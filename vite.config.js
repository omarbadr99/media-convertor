import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any subpath (e.g. GitHub Pages).
  base: './',
  build: {
    target: 'es2022',
    // ffmpeg-core.wasm is ~32 MB; silence the size warning for it.
    chunkSizeWarningLimit: 40000,
  },
  optimizeDeps: {
    // These packages use workers/wasm and break when pre-bundled by esbuild.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
