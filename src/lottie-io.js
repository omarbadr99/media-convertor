// Lottie input support: render a Lottie JSON to PNG frames off-screen so
// ffmpeg can encode them into any raster format.
import lottie from 'lottie-web';

export function isLottieJSON(text) {
  try {
    const data = JSON.parse(text);
    return typeof data === 'object' && data !== null &&
      'layers' in data && 'fr' in data && 'op' in data && 'w' in data && 'h' in data;
  } catch {
    return false;
  }
}

/**
 * Renders every frame of a Lottie animation to PNG bytes.
 * Returns { frames: Uint8Array[], fps, width, height }.
 */
export async function lottieToFrames(animationData, onFrame = () => {}) {
  const width = Math.round(animationData.w);
  const height = Math.round(animationData.h);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const anim = lottie.loadAnimation({
    renderer: 'canvas',
    loop: false,
    autoplay: false,
    animationData,
    rendererSettings: {
      context: canvas.getContext('2d'),
      clearCanvas: true,
      preserveAspectRatio: 'xMidYMid meet',
    },
  });

  try {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      anim.addEventListener('DOMLoaded', finish);
      anim.addEventListener('data_ready', finish);
      setTimeout(finish, 1500); // animationData loads synchronously in practice
    });

    const total = Math.max(1, Math.round(anim.totalFrames));
    const frames = [];
    for (let i = 0; i < total; i++) {
      anim.goToAndStop(i, true);
      await nextPaint();
      frames.push(await canvasToPNG(canvas));
      onFrame(i + 1, total);
    }
    return { frames, fps: animationData.fr || 30, width, height };
  } finally {
    anim.destroy();
  }
}

function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function canvasToPNG(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('Failed to capture Lottie frame'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}
