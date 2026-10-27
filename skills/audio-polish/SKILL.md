---
name: audio-polish
description: Fix video and audio loudness, dead air and clicks. Use when the user wants audio normalized for YouTube/TikTok/podcasts (two-pass EBU R128 loudnorm, true-peak limit), silence or dead air trimmed from the start, end or middle, clips joined without pops, or crossfades between clips.
---

# audio-polish

Three scripts in `scripts/`, all ffmpeg-only:

| Script | Does |
|---|---|
| `loudnorm.mjs` | two-pass `loudnorm` (measure, then linear gain), video stream-copied, result re-measured and verified |
| `trim-silence.mjs` | removes lead/tail silence (or every long pause with `--all`), keeps `--pad` of air, 30 ms fades at each join |
| `join.mjs` | concatenates clips with 30 ms anti-click fades, or `--crossfade` (video `xfade` + audio `acrossfade`) |

## Workflow

```bash
# 1. look first (no writes)
node scripts/loudnorm.mjs --input clip.mp4 --dry-run
node scripts/trim-silence.mjs --input clip.mp4 --report-only

# 2. tighten, then normalize (normalize LAST: cuts change loudness stats)
node scripts/trim-silence.mjs --input clip.mp4 --out edit/clip-tight.mp4
node scripts/loudnorm.mjs --input edit/clip-tight.mp4 --out edit/clip-final.mp4 --preset shorts

# joining clips
node scripts/join.mjs --inputs a.mp4,b.mp4,c.mp4 --out edit/joined.mp4
node scripts/join.mjs --inputs a.mp4,b.mp4 --crossfade 0.4 --transition fade --out edit/joined.mp4
```

Presets: `shorts` (-14 LUFS, -1.5 dBTP), `podcast` (-16 LUFS), `broadcast`
(-23 LUFS, EBU R128). Override with `--i`, `--tp`, `--lra`.

## Rules

- Every hard cut gets a short audio fade (30 ms default). Cutting on a non-zero sample is what makes a click.
- Use `--pad` (0.1-0.2 s) when removing pauses so speech does not sound chopped.
- Normalize once, at the end of the audio chain, with two passes. Single-pass loudnorm pumps.
- Never overwrite the source. `--in-place` keeps `<name>.pre-loudnorm.<ext>` and only replaces after verification (target within tolerance, true peak under the ceiling, duration unchanged).
- If the integrated loudness is below -70 LUFS the audio is silent: stop and tell the user rather than boosting noise.
- For long compilations with music, prefer one continuous audio track muxed onto the joined video over many short AAC segments (each AAC segment adds priming silence that can click at joins).

## Verify

`render-qc/scripts/verify-render.mjs` checks loudness range, true peak and
silent audio. Listen at every join when you cut internal pauses.
