---
name: render-qc
description: Quality-check rendered videos before anyone sees or publishes them. Use after any render to verify resolution, fps, duration, codecs, loudness, true peak, silent audio, black or frozen frames, to build a contact/proof sheet PNG for review, and to promote files from staging only after an explicit human approval.
---

# render-qc

The gate between "it rendered" and "it is ready". Automated checks catch the
mechanical failures; the proof sheet and an explicit approval catch the rest.

Scripts in `scripts/`:

| Script | Does |
|---|---|
| `verify-render.mjs` | ffprobe + ffmpeg analysis: size, fps, duration, h264/yuv420p, audio present, not silent, LUFS range, true peak, black ratio, black opening frame, optional frozen video. Exit 1 on any error |
| `proof-sheet.mjs` | contact sheet PNG: `timeline` (N frames per video) or `firstlast` (first + last frame of every clip); `--frames-dir` saves full-res frames |
| `approve.mjs` | promotes staging to a destination only with a fresh proof sheet, passing QC reports and `--approved`; writes `APPROVED.json` with sha256 per file |

## Workflow

```bash
# 1. automated checks (writes final.mp4.qc.json next to the file)
node scripts/verify-render.mjs --input edit/final/short.mp4 --profile shorts --write-report

# 2. proof sheet (and full-res frames for close inspection)
node scripts/proof-sheet.mjs --inputs edit/final/short.mp4 --frames 6 --out edit/final/proof.png --frames-dir edit/frames

# 3. status: shows what would be promoted and any problems (exit 2 = refused)
node scripts/approve.mjs --staging edit/final --proof edit/final/proof.png

# 4. ONLY after the user has looked at the proof sheet and said yes
node scripts/approve.mjs --staging edit/final --proof edit/final/proof.png --dest publish/ --approved --by "<name>"
```

Profiles: `shorts`, `reels`, `tiktok` (1080x1920), `square` (1080x1080),
`landscape` (1920x1080). Override any expectation with `--size`, `--fps`,
`--min-duration`, `--max-duration`.

## Rules

- Run `verify-render` on every final render. A failing check is fixed, not waived; if the user wants it waived, they say so.
- Show the user real output: the proof sheet plus full-resolution frames or the MP4 itself. Do not judge text legibility from a downscaled collage.
- Never pass `--approved` on your own. Approval is the user's call after they have seen the proof. If the user explicitly says "approved" or "ship it", record their name with `--by`.
- The proof sheet must be newer than the files it proves (`approve.mjs` enforces this). Re-render means re-proof.
- `opens-on-content` failing means the clip starts on black: go back to `auto-cut/trim-lead`.
- `true-peak` or `loudness-range` failing: `audio-polish/loudnorm`.
- A frozen-video warning on a screen recording can be fine (static UI); on gameplay it usually means a capture stall.

## What automation cannot check

Whether the hook is true for the clip, whether the clip ends at a satisfying
moment, whether text overlaps something important, whether the content is
allowed to be posted. That is what the proof sheet and the approval step are for.
