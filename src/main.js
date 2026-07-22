import './style.css';
import lottie from 'lottie-web';
import { zipSync } from 'fflate';
import {
  loadEngine, onLog, onProgress, probeFile,
  toGIF, toMP4, toWebM, toPNGFrames, framesToLottie, lastLogLines,
} from './converter.js';
import { isLottieJSON, lottieToFrames } from './lottie-io.js';

// ---------------------------------------------------------------------------
// Format catalog
// ---------------------------------------------------------------------------

const FORMATS = [
  { id: 'gif', label: 'GIF', desc: 'universal, loops everywhere', ext: 'gif', mime: 'image/gif' },
  { id: 'mp4', label: 'MP4', desc: 'H.264 · near-lossless CRF 12', ext: 'mp4', mime: 'video/mp4' },
  { id: 'webm', label: 'WebM', desc: 'VP8 · supports transparency', ext: 'webm', mime: 'video/webm' },
  { id: 'lottie', label: 'Lottie JSON', desc: 'frame sequence, plays in lottie players', ext: 'json', mime: 'application/json' },
  { id: 'png', label: 'PNG frames', desc: 'every frame, lossless, zipped', ext: 'zip', mime: 'application/zip' },
];

const ALPHA_INPUTS = new Set(['gif', 'webp', 'png', 'apng', 'json']);

// ---------------------------------------------------------------------------
// State + elements
// ---------------------------------------------------------------------------

const state = {
  file: null,          // the uploaded File
  kind: null,          // 'video' | 'image' | 'lottie'
  lottieData: null,    // parsed JSON when kind === 'lottie'
  meta: {},            // width/height/fps/duration
  format: 'gif',
  busy: false,
  outputURL: null,
  lottiePlayers: { input: null, output: null },
};

const $ = (id) => document.getElementById(id);
const els = {
  engineChip: $('engine-chip'), engineLabel: $('engine-label'),
  dropzone: $('dropzone'), fileInput: $('file-input'),
  inputPreview: $('input-preview'), inputNote: $('input-note'),
  inputMeta: $('input-meta'), changeFile: $('change-file'),
  formats: $('formats'), fpsOption: $('fps-option'), fpsInput: $('fps-input'),
  fpsHint: $('fps-hint'), formatNote: $('format-note'),
  convertBtn: $('convert-btn'),
  progress: $('progress'), progressBar: $('progress-bar'), progressLabel: $('progress-label'),
  errorBox: $('error-box'),
  logOutput: $('log-output'),
  outputPreview: $('output-preview'), outputMeta: $('output-meta'), downloadBtn: $('download-btn'),
};

// ---------------------------------------------------------------------------
// Engine boot
// ---------------------------------------------------------------------------

onLog((message) => {
  els.logOutput.textContent += message + '\n';
  if (els.logOutput.textContent.length > 60000) {
    els.logOutput.textContent = els.logOutput.textContent.slice(-40000);
  }
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
});

let engineReady = false;
loadEngine().then(() => {
  engineReady = true;
  els.engineChip.classList.add('ready');
  els.engineLabel.textContent = 'Engine ready';
  refreshConvertButton();
}).catch((err) => {
  els.engineChip.classList.add('error');
  els.engineLabel.textContent = 'Engine failed to load';
  showError(`Could not load the conversion engine: ${err?.message || err}`);
});

// ---------------------------------------------------------------------------
// Format picker
// ---------------------------------------------------------------------------

for (const fmt of FORMATS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'format-chip';
  btn.role = 'radio';
  btn.dataset.format = fmt.id;
  btn.setAttribute('aria-checked', String(fmt.id === state.format));
  btn.innerHTML = `<span>${fmt.label}</span><small>${fmt.desc}</small>`;
  btn.addEventListener('click', () => selectFormat(fmt.id));
  els.formats.appendChild(btn);
}

function selectFormat(id) {
  state.format = id;
  for (const chip of els.formats.children) {
    chip.setAttribute('aria-checked', String(chip.dataset.format === id));
  }
  const usesFps = id === 'lottie';
  els.fpsOption.classList.toggle('hidden', !usesFps);
  if (usesFps) {
    const src = state.meta.fps || 30;
    els.fpsInput.value = Math.min(30, Math.round(src)) || 30;
    els.fpsHint.textContent = state.meta.fps ? `(source: ${state.meta.fps} fps)` : '';
  }
  els.formatNote.classList.toggle('hidden', id !== 'lottie');
  if (id === 'lottie') {
    els.formatNote.textContent =
      'Raster footage becomes an image-sequence Lottie: every frame is embedded as a full-resolution PNG, ' +
      'so files get large for long clips. Lower the frame rate to shrink it.';
  }
}
selectFormat('gif');

// ---------------------------------------------------------------------------
// File intake
// ---------------------------------------------------------------------------

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.changeFile.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.[0]) acceptFile(els.fileInput.files[0]);
});

for (const evt of ['dragover', 'dragleave', 'drop']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.toggle('dragover', evt === 'dragover');
    if (evt === 'drop' && e.dataTransfer?.files?.[0]) acceptFile(e.dataTransfer.files[0]);
  });
}
// Allow dropping anywhere on the page once a file is loaded.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.[0]) acceptFile(e.dataTransfer.files[0]);
});

async function acceptFile(file) {
  clearError();
  resetOutput();
  state.file = file;
  state.lottieData = null;
  state.meta = {};

  const ext = (file.name.split('.').pop() || '').toLowerCase();

  if (ext === 'json' || file.type === 'application/json') {
    const text = await file.text();
    if (!isLottieJSON(text)) {
      showError('That JSON file does not look like a Lottie animation (missing layers/fr/op/w/h).');
      state.file = null;
      refreshConvertButton();
      return;
    }
    state.kind = 'lottie';
    state.lottieData = JSON.parse(text);
    state.meta = {
      width: state.lottieData.w,
      height: state.lottieData.h,
      fps: state.lottieData.fr,
      duration: (state.lottieData.op - state.lottieData.ip) / state.lottieData.fr,
    };
  } else if (['gif', 'webp', 'png', 'apng'].includes(ext) || file.type.startsWith('image/')) {
    state.kind = 'image';
  } else {
    state.kind = 'video';
  }

  renderInputPreview();
  renderMeta(els.inputMeta, {
    File: file.name,
    Size: formatBytes(file.size),
    ...metaFields(state.meta),
  });
  els.inputMeta.classList.remove('hidden');
  els.changeFile.classList.remove('hidden');
  selectFormat(state.format); // refresh fps hint
  refreshConvertButton();

  // Probe raster/video inputs with ffmpeg for exact dimensions & fps.
  if (state.kind !== 'lottie') {
    try {
      await loadEngine();
      const meta = await probeFile(file);
      state.meta = { ...state.meta, ...meta };
      renderMeta(els.inputMeta, {
        File: file.name,
        Size: formatBytes(file.size),
        ...metaFields(state.meta),
      });
      selectFormat(state.format);
    } catch { /* probe is best-effort */ }
  }
}

function renderInputPreview() {
  destroyLottie('input');
  els.dropzone.classList.add('hidden');
  els.inputPreview.classList.remove('hidden');
  els.inputPreview.innerHTML = '';
  els.inputNote.classList.add('hidden');

  if (state.kind === 'lottie') {
    mountLottie('input', els.inputPreview, state.lottieData);
    return;
  }

  const url = URL.createObjectURL(state.file);
  if (state.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Input preview';
    els.inputPreview.appendChild(img);
  } else {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('error', () => {
      els.inputNote.textContent =
        'Your browser can\'t play this codec (common for ProRes/HEVC .mov files) — the converter can still read it. Hit Convert.';
      els.inputNote.classList.remove('hidden');
    });
    els.inputPreview.appendChild(video);
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

els.convertBtn.addEventListener('click', convert);

function refreshConvertButton() {
  els.convertBtn.disabled = !(state.file && engineReady && !state.busy);
}

let progressMode = 'idle';
onProgress((p) => {
  if (progressMode !== 'encode') return;
  const pct = Math.max(0, Math.min(1, p)) * 100;
  if (pct > 0) {
    els.progressBar.classList.remove('indeterminate');
    els.progressBar.style.width = `${pct.toFixed(1)}%`;
    els.progressLabel.textContent = `Encoding… ${pct.toFixed(0)}%`;
  }
});

function setProgress(label, { indeterminate = true, fraction = null } = {}) {
  els.progress.classList.remove('hidden');
  els.progressLabel.textContent = label;
  els.progressBar.classList.toggle('indeterminate', indeterminate && fraction === null);
  if (fraction !== null) {
    els.progressBar.classList.remove('indeterminate');
    els.progressBar.style.width = `${(fraction * 100).toFixed(1)}%`;
  }
}

async function convert() {
  if (state.busy || !state.file) return;
  clearError();
  resetOutput();
  state.busy = true;
  refreshConvertButton();
  els.convertBtn.textContent = 'Converting…';

  try {
    const fmt = FORMATS.find((f) => f.id === state.format);
    const isLottieIn = state.kind === 'lottie';

    // Lottie in → Lottie out is a passthrough.
    if (isLottieIn && fmt.id === 'lottie') {
      const bytes = new TextEncoder().encode(JSON.stringify(state.lottieData));
      finishOutput({ data: bytes, ext: 'json', mime: 'application/json' }, fmt);
      return;
    }

    setProgress('Preparing input…');

    // Build the ffmpeg input source.
    let source;
    if (isLottieIn) {
      const rendered = await lottieToFrames(state.lottieData, (done, total) => {
        setProgress(`Rendering Lottie frames ${done}/${total}`, { fraction: done / total });
      });
      source = { kind: 'frames', frames: rendered.frames, fps: rendered.fps };
    } else {
      source = { kind: 'file', file: state.file };
    }

    progressMode = 'encode';
    setProgress('Encoding…');

    let result;
    if (fmt.id === 'gif') {
      result = await toGIF(source);
    } else if (fmt.id === 'mp4') {
      result = await toMP4(source);
    } else if (fmt.id === 'webm') {
      const ext = (state.file.name.split('.').pop() || '').toLowerCase();
      result = await toWebM(source, { alpha: ALPHA_INPUTS.has(ext) });
    } else if (fmt.id === 'png') {
      const { names, frames } = await toPNGFrames(source);
      setProgress('Zipping frames…');
      const entries = {};
      names.forEach((name, i) => { entries[`frames/${name}`] = frames[i]; });
      // PNGs are already compressed; store them for speed.
      const zipped = zipSync(entries, { level: 0 });
      result = { data: zipped, ext: 'zip', mime: 'application/zip', frameCount: frames.length, firstFrame: frames[0] };
    } else if (fmt.id === 'lottie') {
      const fps = clampFps(parseFloat(els.fpsInput.value) || 30);
      const { frames } = await toPNGFrames(source, { fps });
      setProgress(`Embedding ${frames.length} frames into Lottie JSON…`);
      result = await framesToLottie(frames, fps);
    }

    finishOutput(result, fmt);
  } catch (err) {
    console.error(err);
    showError(String(err?.message || err) || `Conversion failed.\n\n${lastLogLines()}`);
  } finally {
    progressMode = 'idle';
    state.busy = false;
    els.convertBtn.textContent = 'Convert →';
    els.progress.classList.add('hidden');
    refreshConvertButton();
  }
}

function clampFps(v) { return Math.max(1, Math.min(120, v)); }

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function finishOutput(result, fmt) {
  destroyLottie('output');
  const blob = new Blob([result.data], { type: result.mime });
  if (state.outputURL) URL.revokeObjectURL(state.outputURL);
  state.outputURL = URL.createObjectURL(blob);

  els.outputPreview.classList.remove('empty');
  els.outputPreview.innerHTML = '';

  if (fmt.id === 'gif') {
    const img = document.createElement('img');
    img.src = state.outputURL;
    img.alt = 'Output preview';
    els.outputPreview.appendChild(img);
  } else if (fmt.id === 'mp4' || fmt.id === 'webm') {
    const video = document.createElement('video');
    video.src = state.outputURL;
    video.controls = true;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    els.outputPreview.appendChild(video);
  } else if (fmt.id === 'lottie') {
    const data = result.json ? JSON.parse(result.json) : state.lottieData;
    mountLottie('output', els.outputPreview, data);
  } else if (fmt.id === 'png') {
    if (result.firstFrame) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(new Blob([result.firstFrame], { type: 'image/png' }));
      img.alt = 'First extracted frame';
      els.outputPreview.appendChild(img);
    }
  }

  const baseName = (state.file.name.replace(/\.[^.]*$/, '') || 'converted');
  els.downloadBtn.href = state.outputURL;
  els.downloadBtn.download = `${baseName}.${result.ext}`;
  els.downloadBtn.textContent = `⬇ Download ${fmt.label} (${formatBytes(blob.size)})`;
  els.downloadBtn.classList.remove('hidden');

  renderMeta(els.outputMeta, {
    Format: fmt.label,
    Size: formatBytes(blob.size),
    ...(result.frameCount ? { Frames: String(result.frameCount) } : {}),
    ...(result.width ? { Resolution: `${result.width}×${result.height}` } : {}),
  });
  els.outputMeta.classList.remove('hidden');
}

function resetOutput() {
  destroyLottie('output');
  if (state.outputURL) { URL.revokeObjectURL(state.outputURL); state.outputURL = null; }
  els.outputPreview.classList.add('empty');
  els.outputPreview.innerHTML = '<p class="empty-hint">Your converted file will preview here</p>';
  els.outputMeta.classList.add('hidden');
  els.downloadBtn.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountLottie(slot, container, data) {
  const box = document.createElement('div');
  box.className = 'lottie-box';
  box.style.setProperty('--ar', `${data.w} / ${data.h}`);
  container.appendChild(box);
  state.lottiePlayers[slot] = lottie.loadAnimation({
    container: box,
    renderer: 'svg',
    loop: true,
    autoplay: true,
    animationData: data,
  });
}

function destroyLottie(slot) {
  if (state.lottiePlayers[slot]) {
    state.lottiePlayers[slot].destroy();
    state.lottiePlayers[slot] = null;
  }
}

function metaFields(meta) {
  const out = {};
  if (meta.width) out.Resolution = `${meta.width}×${meta.height}`;
  if (meta.fps) out['Frame rate'] = `${meta.fps} fps`;
  if (meta.duration) out.Duration = `${meta.duration.toFixed(2)} s`;
  return out;
}

function renderMeta(dl, fields) {
  dl.innerHTML = '';
  for (const [label, value] of Object.entries(fields)) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.title = value;
    div.append(dt, dd);
    dl.appendChild(div);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function clearError() {
  els.errorBox.classList.add('hidden');
  els.errorBox.textContent = '';
}

// Exposed for automated testing.
window.__mc = { state, loadEngine, acceptFile, convert, selectFormat };
