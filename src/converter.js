// Thin wrapper around ffmpeg.wasm: loading, probing, and the actual
// format conversions. Everything runs in a worker inside the browser.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

let ffmpeg = null;
let loadPromise = null;

const logListeners = new Set();
const progressListeners = new Set();
const recentLogs = [];

export function onLog(fn) { logListeners.add(fn); }
export function onProgress(fn) { progressListeners.add(fn); }
export function lastLogLines(n = 8) { return recentLogs.slice(-n).join('\n'); }

export function loadEngine() {
  if (loadPromise) return loadPromise;
  fsEntries = []; // fresh engine = fresh FS
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 500) recentLogs.splice(0, 100);
    logListeners.forEach((fn) => fn(message));
  });
  ffmpeg.on('progress', ({ progress }) => {
    progressListeners.forEach((fn) => fn(progress));
  });
  // ?url assets can resolve relative to the page; the engine worker lives at a
  // different URL, so absolutize both before handing them over.
  loadPromise = ffmpeg.load({
    coreURL: new URL(coreURL, document.baseURI).href,
    wasmURL: new URL(wasmURL, document.baseURI).href,
  }).then(() => ffmpeg);
  return loadPromise;
}

// Tracks every file/dir we create in the wasm FS so each run starts clean.
let fsEntries = [];

async function cleanFS() {
  const ff = await loadEngine();
  for (const entry of fsEntries.reverse()) {
    try {
      if (entry.dir) {
        for (const f of await ff.listDir(entry.name)) {
          if (!f.isDir) await ff.deleteFile(`${entry.name}/${f.name}`);
        }
        await ff.deleteDir(entry.name);
      } else {
        await ff.deleteFile(entry.name);
      }
    } catch { /* already gone */ }
  }
  fsEntries = [];
}

async function writeFile(name, data) {
  const ff = await loadEngine();
  await ff.writeFile(name, data);
  fsEntries.push({ name });
}

async function makeDir(name) {
  const ff = await loadEngine();
  await ff.createDir(name);
  fsEntries.push({ name, dir: true });
}

// A wasm crash inside the worker (e.g. an encoder bug) leaves ffmpeg.exec's
// promise pending forever — the worker has no error handler. Encoders log
// constantly, so prolonged silence during exec means the engine is dead:
// terminate it, restart, and surface a real error instead of hanging.
const STALL_MS = 30000;

async function exec(args) {
  const ff = await loadEngine();
  let lastActivity = Date.now();
  const bump = () => { lastActivity = Date.now(); };
  logListeners.add(bump);
  try {
    return await new Promise((resolve, reject) => {
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > STALL_MS) {
          clearInterval(watchdog);
          ffmpeg.terminate();
          ffmpeg = null;
          loadPromise = null;
          loadEngine(); // start recovering in the background
          reject(new Error(
            'The conversion engine crashed (no response for 30s). ' +
            'It has been restarted — please try again, possibly with a different format.',
          ));
        }
      }, 2000);
      ff.exec(args).then(
        (ret) => { clearInterval(watchdog); resolve(ret); },
        (err) => { clearInterval(watchdog); reject(err); },
      );
    });
  } finally {
    logListeners.delete(bump);
  }
}

async function readDirFrames(dir) {
  const ff = await loadEngine();
  const names = (await ff.listDir(dir))
    .filter((f) => !f.isDir && f.name.endsWith('.png'))
    .map((f) => f.name)
    .sort();
  const frames = [];
  for (const name of names) frames.push(await ff.readFile(`${dir}/${name}`));
  return { names, frames };
}

/**
 * Prepares the input inside the wasm FS.
 * source is either { kind: 'file', file } or { kind: 'frames', frames, fps }
 * (frames = array of PNG Uint8Arrays, used for Lottie input).
 * Returns the ffmpeg args that select this input.
 */
async function prepareInput(source) {
  await cleanFS();
  if (source.kind === 'frames') {
    await makeDir('fin');
    for (let i = 0; i < source.frames.length; i++) {
      await writeFile(`fin/f_${String(i + 1).padStart(5, '0')}.png`, source.frames[i]);
    }
    return ['-framerate', String(source.fps || 30), '-i', 'fin/f_%05d.png'];
  }
  const ext = (source.file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const name = `in.${ext}`;
  await writeFile(name, new Uint8Array(await source.file.arrayBuffer()));
  return ['-i', name];
}

/** Parses stream info out of ffmpeg's stderr for a media file. */
export async function probeFile(file) {
  const inputArgs = await prepareInput({ kind: 'file', file });
  const lines = [];
  const capture = (m) => lines.push(m);
  logListeners.add(capture);
  try {
    await exec(['-hide_banner', ...inputArgs]);
  } finally {
    logListeners.delete(capture);
  }
  const text = lines.join('\n');
  const meta = {};
  const dim = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (dim) { meta.width = +dim[1]; meta.height = +dim[2]; }
  const fps = /([\d.]+)\s*fps/.exec(text) || /([\d.]+)\s*tbr/.exec(text);
  if (fps) meta.fps = Math.round(parseFloat(fps[1]) * 100) / 100;
  const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  if (dur) meta.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  return meta;
}

async function readOutput(name) {
  const ff = await loadEngine();
  const data = await ff.readFile(name);
  fsEntries.push({ name });
  return data;
}

function assertOk(ret, what) {
  if (ret !== 0) {
    throw new Error(`${what} failed (ffmpeg exit code ${ret}).\n\n${lastLogLines()}`);
  }
}

// ---------------------------------------------------------------------------
// Conversions. All keep the source resolution; no scaling except the
// mandatory even-dimension rounding H.264 requires.
// ---------------------------------------------------------------------------

export async function toGIF(source) {
  const input = await prepareInput(source);
  // Per-frame 256-color palettes = the highest color fidelity a GIF can hold.
  const ret = await exec([
    ...input,
    '-filter_complex',
    '[0:v]split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a',
    '-loop', '0',
    'out.gif',
  ]);
  assertOk(ret, 'GIF encode');
  return { data: await readOutput('out.gif'), ext: 'gif', mime: 'image/gif' };
}

export async function toMP4(source) {
  const input = await prepareInput(source);
  const ret = await exec([
    ...input,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '12',
    '-pix_fmt', 'yuv420p',
    // H.264 requires even dimensions; round up instead of cropping pixels.
    '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2:flags=lanczos',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    'out.mp4',
  ]);
  assertOk(ret, 'MP4 encode');
  return { data: await readOutput('out.mp4'), ext: 'mp4', mime: 'video/mp4' };
}

export async function toWebM(source, { alpha = false } = {}) {
  const input = await prepareInput(source);
  const ret = await exec([
    ...input,
    // VP8: the wasm build's VP9 encoder crashes (memory OOB), so VP8 it is.
    // High bitrate ceiling + low qmax ≈ visually lossless.
    '-c:v', 'libvpx',
    '-crf', '5', '-qmin', '0', '-qmax', '16', '-b:v', '20M',
    '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p',
    '-auto-alt-ref', '0',
    '-deadline', 'good', '-cpu-used', '2',
    '-an',
    'out.webm',
  ]);
  assertOk(ret, 'WebM encode');
  return { data: await readOutput('out.webm'), ext: 'webm', mime: 'video/webm' };
}

export async function toPNGFrames(source, { fps = null } = {}) {
  const input = await prepareInput(source);
  await makeDir('fout');
  const args = [...input];
  if (fps) args.push('-vf', `fps=${fps}`);
  else args.push('-vsync', '0');
  const ret = await exec([...args, 'fout/f_%05d.png']);
  assertOk(ret, 'Frame extraction');
  return readDirFrames('fout');
}

/** Frame count + dimensions in, image-sequence Lottie JSON out. */
export async function framesToLottie(frames, fps) {
  const first = await createImageBitmap(new Blob([frames[0]], { type: 'image/png' }));
  const w = first.width;
  const h = first.height;
  first.close();

  const assets = [];
  const layers = [];
  for (let i = 0; i < frames.length; i++) {
    assets.push({
      id: `img_${i}`, w, h, u: '', e: 1,
      p: await toDataURL(frames[i]),
    });
    layers.push({
      ddd: 0, ind: i + 1, ty: 2, nm: `frame ${i + 1}`, refId: `img_${i}`,
      ks: {
        o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
        p: { a: 0, k: [w / 2, h / 2, 0] }, a: { a: 0, k: [w / 2, h / 2, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0, ip: i, op: i + 1, st: 0, bl: 0,
    });
  }

  const lottie = {
    v: '5.7.4', fr: fps, ip: 0, op: frames.length,
    w, h, nm: 'Motion Converter export', ddd: 0,
    assets, layers, markers: [],
  };
  const json = JSON.stringify(lottie);
  return { data: new TextEncoder().encode(json), json, ext: 'json', mime: 'application/json', width: w, height: h };
}

function toDataURL(u8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([u8], { type: 'image/png' }));
  });
}
