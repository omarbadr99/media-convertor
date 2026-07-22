# Motion Converter

Convert motion files between formats — entirely in the browser, at the source's full
resolution. Nothing is ever uploaded: all decoding and encoding happens on your device
via [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) and
[lottie-web](https://airbnb.io/lottie/).

## What it does

Drop in any of these:

| Input | Notes |
| --- | --- |
| MOV / MP4 / M4V / WebM / MKV / AVI | Any codec ffmpeg can decode — including ProRes `.mov` files browsers can't even play |
| GIF / animated WebP / APNG | |
| Lottie JSON | Rendered frame-by-frame with lottie-web, then encoded |

…preview it, then convert to any of these and preview + download the result:

| Output | How it's made |
| --- | --- |
| **GIF** | Per-frame 256-color palettes (`palettegen stats_mode=single` + `paletteuse new=1`) — the highest color fidelity GIF allows |
| **MP4** | H.264, CRF 12 (near-lossless), full resolution |
| **WebM** | VP8 at a visually lossless quality ceiling, keeps transparency from GIF/Lottie/APNG sources |
| **Lottie JSON** | Image-sequence Lottie: every frame embedded as a full-resolution PNG (adjustable frame rate — long clips get big) |
| **PNG frames** | Every frame, lossless, zipped |

Resolution is never reduced. The only pixel-level change ever applied is the
even-dimension rounding H.264 requires for MP4 output.

## Notes & limits

- A raster video can't become *vector* Lottie — the Lottie export is an image-sequence
  animation (full quality, but large). Lottie **input** is rendered at its native
  size and frame rate.
- The single-threaded WebAssembly build tops out around 2 GB of memory, so very long
  or very large clips may fail. Typical clips convert fine.
- WebM uses VP8 because the VP9 encoder in the current ffmpeg.wasm build crashes.
  If the engine ever wedges, a watchdog restarts it automatically.

## Development

```bash
npm install
npm run dev       # local dev server
npm run build     # production build in dist/
npm run preview   # serve the production build
```

Built with Vite. The ffmpeg core (~32 MB wasm) is bundled at build time from
`@ffmpeg/core` — no CDN dependency, works offline, and deploys as a fully static
site (GitHub Pages, Netlify, etc. — the relative `base` means any subpath works).
