import './style.css';
import lottie from 'lottie-web';
import { zipSync } from 'fflate';
import {
  loadEngine, onLog, onProgress, probeFile,
  toGIF, toMP4, toWebM, toPNGFrames, framesToLottie, lastLogLines,
} from './converter.js';
import { isLottieJSON, lottieToFrames } from './lottie-io.js';

// ---------------------------------------------------------------------------
// Inline line icons (24x24, currentColor stroke)
// ---------------------------------------------------------------------------

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  size: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  resolution: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/>'),
  film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  loop: svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>'),
  braces: svg('<path d="M8 4a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2"/><path d="M16 4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
};

// ---------------------------------------------------------------------------
// Format catalog
// ---------------------------------------------------------------------------

const FORMATS = [
  { id: 'gif', label: 'GIF', desc: 'universal, loops everywhere', ext: 'gif', mime: 'image/gif', icon: ICONS.loop },
  { id: 'mp4', label: 'MP4', desc: 'H.264 · near-lossless CRF 12', ext: 'mp4', mime: 'video/mp4', icon: ICONS.film },
  { id: 'webm', label: 'WebM', desc: 'VP8 · supports transparency', ext: 'webm', mime: 'video/webm', icon: ICONS.film },
  { id: 'lottie', label: 'Lottie JSON', desc: 'frame sequence, plays in Lottie players', ext: 'json', mime: 'application/json', icon: ICONS.braces },
  { id: 'png', label: 'PNG frames', desc: 'every frame, lossless, zipped', ext: 'zip', mime: 'application/zip', icon: ICONS.image },
];

const ALPHA_INPUTS = new Set(['gif', 'webp', 'png', 'apng', 'json']);

// ---------------------------------------------------------------------------
// State + elements
// ---------------------------------------------------------------------------

const state = {
  file: null,
  kind: null,          // 'video' | 'image' | 'lottie'
  lottieData: null,
  meta: {},            // width/height/fps/duration
  format: 'gif',
  busy: false,
  outputURL: null,
  outputStatus: 'idle', // 'idle' | 'converting' | 'ready' | 'error'
  outputSize: null,
  lottiePlayers: { input: null, output: null },
};

const $ = (id) => document.getElementById(id);
const els = {
  engineChip: $('engine-chip'), engineLabel: $('engine-label'),
  exportBtn: $('export-btn'),
  dropzone: $('dropzone'), fileInput: $('file-input'),
  inputPreview: $('input-preview'), inputNote: $('input-note'),
  inputMeta: $('input-meta'), changeFile: $('change-file'),
  formats: $('formats'), fpsOption: $('fps-option'), fpsInput: $('fps-input'),
  fpsHint: $('fps-hint'), formatNote: $('format-note'),
  progress: $('progress'), progressBar: $('progress-bar'), progressLabel: $('progress-label'),
  errorBox: $('error-box'),
  logOutput: $('log-output'),
  outputPreview: $('output-preview'), outputMeta: $('output-meta'),
  downloadBtn: $('download-btn'), downloadLabel: $('download-label'),
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
  refreshExportButton();
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
  btn.innerHTML =
    `<span class="chip-ico">${fmt.icon}</span>` +
    `<span class="chip-text"><span class="chip-title">${fmt.label}</span><span class="chip-desc">${fmt.desc}</span></span>` +
    `<span class="chip-check">${ICONS.check}</span>`;
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
  renderOutputDetails();
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
      refreshExportButton();
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
  renderInputMeta();
  els.inputMeta.classList.remove('hidden');
  els.changeFile.classList.remove('hidden');
  selectFormat(state.format);
  refreshExportButton();

  if (state.kind !== 'lottie') {
    try {
      await loadEngine();
      const meta = await probeFile(file);
      state.meta = { ...state.meta, ...meta };
      renderInputMeta();
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
        'Your browser can\'t play this codec (common for ProRes/HEVC .mov files) — the converter can still read it. Hit Export.';
      els.inputNote.classList.remove('hidden');
    });
    els.inputPreview.appendChild(video);
  }
}

// ---------------------------------------------------------------------------
// Conversion — triggered by the header Export button
// ---------------------------------------------------------------------------

els.exportBtn.addEventListener('click', convert);

function refreshExportButton() {
  els.exportBtn.disabled = !(state.file && engineReady && !state.busy);
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
  state.outputStatus = 'converting';
  refreshExportButton();
  els.exportBtn.textContent = 'Converting…';
  renderOutputDetails();

  try {
    const fmt = FORMATS.find((f) => f.id === state.format);
    const isLottieIn = state.kind === 'lottie';

    if (isLottieIn && fmt.id === 'lottie') {
      const bytes = new TextEncoder().encode(JSON.stringify(state.lottieData));
      finishOutput({ data: bytes, ext: 'json', mime: 'application/json' }, fmt);
      return;
    }

    setProgress('Preparing input…');

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
    state.outputStatus = 'error';
    showError(String(err?.message || err) || `Conversion failed.\n\n${lastLogLines()}`);
    renderOutputDetails();
  } finally {
    progressMode = 'idle';
    state.busy = false;
    els.exportBtn.textContent = 'Export';
    els.progress.classList.add('hidden');
    refreshExportButton();
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
  state.outputSize = blob.size;
  state.outputStatus = 'ready';

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
  els.downloadBtn.setAttribute('aria-disabled', 'false');
  els.downloadLabel.textContent = `Download ${fmt.label} · ${formatBytes(blob.size)}`;

  renderOutputDetails();
}

function resetOutput() {
  destroyLottie('output');
  if (state.outputURL) { URL.revokeObjectURL(state.outputURL); state.outputURL = null; }
  state.outputSize = null;
  if (state.outputStatus === 'ready') state.outputStatus = 'idle';
  els.outputPreview.classList.add('empty');
  els.outputPreview.innerHTML =
    '<div class="empty-inner">' +
    ICONS.file +
    '<p class="empty-hint">Your converted file<br>will preview here</p></div>';
  els.downloadBtn.setAttribute('aria-disabled', 'true');
  els.downloadBtn.removeAttribute('href');
  els.downloadLabel.textContent = 'Download';
  renderOutputDetails();
}

// Prevent navigation while the download button is disabled.
els.downloadBtn.addEventListener('click', (e) => {
  if (els.downloadBtn.getAttribute('aria-disabled') === 'true') e.preventDefault();
});

// ---------------------------------------------------------------------------
// Meta / details rendering
// ---------------------------------------------------------------------------

function row(iconKey, label, valueHTML) {
  const key = iconKey
    ? `<span class="row-key"><span class="row-ico">${ICONS[iconKey]}</span>${label}</span>`
    : `<span class="row-key">${label}</span>`;
  return `<div class="row">${key}<span class="row-val">${valueHTML}</span></div>`;
}

function renderInputMeta() {
  const m = state.meta;
  let html = '';
  html += row('file', 'File', escapeHTML(state.file.name));
  html += row('size', 'Size', formatBytes(state.file.size));
  if (m.width) html += row('resolution', 'Resolution', `${m.width} × ${m.height}`);
  if (m.fps) html += row('film', 'Frame rate', `${m.fps} fps`);
  if (m.duration) html += row('clock', 'Duration', `${m.duration.toFixed(2)} s`);
  els.inputMeta.innerHTML = html;
}

function renderOutputDetails() {
  const fmt = FORMATS.find((f) => f.id === state.format);
  const m = state.meta;

  const statusMap = {
    idle: { cls: '', text: state.file ? 'Ready to export' : 'Waiting for a file' },
    converting: { cls: 'converting', text: 'Converting' },
    ready: { cls: 'ready', text: 'Ready' },
    error: { cls: 'error', text: 'Failed' },
  };
  const st = statusMap[state.outputStatus] || statusMap.idle;
  const statusVal = `<span class="status-dot ${st.cls}"></span>${st.text}`;

  let html = '';
  html += row(null, 'Status', `<span class="${state.outputStatus === 'converting' ? 'accent' : ''}">${statusVal}</span>`);
  html += row(null, 'Format', fmt ? fmt.label : '—');
  if (state.format === 'lottie') {
    const fps = clampFps(parseFloat(els.fpsInput.value) || (m.fps || 30));
    html += row(null, 'Frame rate', `${fps} fps`);
  } else if (m.fps) {
    html += row(null, 'Frame rate', `${m.fps} fps`);
  }
  html += row(null, 'Resolution', m.width ? `${m.width} × ${m.height}` : '—');
  html += row(null, 'Estimated size', state.outputSize != null ? formatBytes(state.outputSize) : '—');
  els.outputMeta.innerHTML = html;
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function clearError() {
  els.errorBox.classList.add('hidden');
  els.errorBox.textContent = '';
}

// Initial paint of the output details card.
renderOutputDetails();

// Exposed for automated testing.
window.__mc = { state, loadEngine, acceptFile, convert, selectFormat };
