---
name: loops-gifs-stickers
description: Make seamless video loops, small high-quality GIFs (optionally with a meme caption) and animated stickers (WebP, transparent GIF, Telegram VP9-alpha WebM, chroma key). Use when the user wants a clip to loop cleanly, a GIF from a video, a reaction/meme GIF, or a 512px animated sticker.
---

# loops-gifs-stickers

Scripts in `scripts/`:

| Script | Output |
|---|---|
| `loop.mjs` | seamless MP4 loop: `crossfade` (end dissolves into start) or `pingpong` (forward + reverse) |
| `gif.mjs` | GIF with a per-clip palette (`palettegen` + `paletteuse`), optional stroked caption |
| `sticker.mjs` | 512px animated sticker: `webp`, transparent `gif`, or `webm` (VP9 alpha, Telegram) |

## Workflow

```bash
# loop: pick a 4s window, dissolve the last 0.5s into the first
node scripts/loop.mjs --input clip.mp4 --start 2 --duration 4 --xfade 0.5 --out edit/loop.mp4
node scripts/loop.mjs --input clip.mp4 --mode pingpong --duration 3 --out edit/pingpong.mp4

# GIF (12 fps / 480 px is a good size-quality balance)
node scripts/gif.mjs --input clip.mp4 --start 1 --duration 3 --out edit/clip.gif
node scripts/gif.mjs --input clip.mp4 --caption "when the render passes QC" --square --out edit/meme.gif

# stickers
node scripts/sticker.mjs --input clip.mp4 --format webp --out edit/sticker.webp
node scripts/sticker.mjs --input greenscreen.mp4 --chroma 0x00ff00 --format webm --out edit/sticker.webm
```

## Rules

- Pick a loop window where the motion is continuous. A crossfade cannot hide a scene change; a pingpong cannot hide motion that obviously should not reverse (people walking, text appearing).
- `reverse` buffers every frame in RAM. Keep pingpong windows short (`--max-duration`, default 15 s) or render the pingpong once and reuse it with `-stream_loop`.
- One scene per loop or GIF. Check the proof sheet for two different backgrounds in one loop (scene bleed).
- GIF size grows with fps x width x duration x colors. If it is too big, lower fps first (10-12), then width, then colors.
- Platform limits (checked and reported): Telegram video sticker WebM <= 256 KB, <= 3 s, 512 px; WhatsApp WebP <= 500 KB.
- Captions on GIFs are rendered to PNG with sharp (no drawtext); keep them under ~6 words.

## Verify

`render-qc/scripts/proof-sheet.mjs --inputs edit/loop.mp4 --mode firstlast`:
for pingpong the first and last frames should be identical; for crossfade the
last frame should flow into the first.
