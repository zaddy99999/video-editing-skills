---
name: hook-overlay
description: Put a hook, title or "POV:" text plate on top of a vertical (9:16) or square video. Use when the user wants on-screen hook text, a title card plate, the same hook style across a batch of clips, or rotating hook lines across many clips. Works even when the local ffmpeg has no drawtext filter, because text is rendered to PNG with sharp.
---

# hook-overlay

Burn a clean, brand-consistent text plate onto a clip. The plate and text are
rendered to a transparent PNG with sharp (Pango text layout), auto-sized so the
widest line fills the plate, balanced into at most two lines, and composited
with ffmpeg `overlay`. No `drawtext` needed (many ffmpeg builds lack it).

Scripts are in `scripts/`. Needs `npm install` once at the repo root (sharp).

## Workflow

1. **Pick the style.** Use `brands/example.json` or a copy of it
   (`--brand brands/<name>.json`). It sets canvas size, font, colors and plate
   geometry. Fonts: pass `--font "Family Name"` for an installed font or
   `--font-file path/to/Font.ttf` for an open-license font you downloaded.
2. **Preview the plate only** (fast, no video):
   ```bash
   node scripts/render-hook.mjs --text "POV: your edits run themselves" --plate-only edit/plate.png
   ```
   Look at the PNG. Check line breaks and size before rendering video.
3. **Render**:
   ```bash
   node scripts/render-hook.mjs --input clip.mp4 --text "POV: your edits run themselves" --out edit/clip-hook.mp4
   # plate only for the first 3 seconds, with a 0.2s fade in
   node scripts/render-hook.mjs --input clip.mp4 --text "Wait for it" --end 3 --fade 0.2 --out edit/clip-hook.mp4
   ```
4. **Batch**:
   ```bash
   node scripts/render-hook.mjs --jobs jobs.json                       # [{ "input", "text", "out" }]
   node scripts/render-hook.mjs --input-dir edit/clips --texts hooks.txt --out-dir edit/hooked   # rotate hooks
   ```
5. **Verify** with `render-qc` (proof sheet + frames). Text must be inside the safe zone.

## Rules

- Max 2 lines, never 3. Long hooks get a smaller font, not another line.
- Keep the plate in the top safe zone: about 150 px from the top on 1080x1920, about 70% of the width, clear of platform UI (bottom ~25% is covered by captions/buttons on Shorts/TikTok/Reels).
- Emoji are stripped from on-video text (plain fonts render them as boxes). Keep emoji in titles, not plates.
- A hook must be true for the clip. A conditional claim ("I finally hit the rare one") only goes on a clip that shows it.
- Rotate several safe hooks across a batch instead of one hook everywhere.
- Captions come after the hook render; make sure they do not overlap the plate.
- Do not commit commercial fonts. Use system fonts or OFL fonts (Inter, Anton, Montserrat, ...).

## Options worth knowing

`--size 1080x1080` (square), `--fit contain` (letterbox instead of crop),
`--plate-top` / `--plate-width` (geometry overrides), `--lines 1|2`,
`--start/--end` (time window), `--weight heavy|bold|normal`.
Set `plate.image` in the brand file to use your own plate artwork PNG
instead of the default rounded rectangle.
