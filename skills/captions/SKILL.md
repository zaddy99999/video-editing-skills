---
name: captions
description: Transcribe speech locally with word-level timestamps (faster-whisper, no API key) and burn styled, word-highlighted captions into a video, or export SRT. Use when the user wants subtitles or captions on a video, a transcript with word timings, or cut points that never land inside a word.
---

# captions

Local word-level transcription, short-form caption styling and burn-in.

Scripts are in `scripts/`:

| Script | Does |
|---|---|
| `transcribe.py` | faster-whisper with `word_timestamps=True` to `words.json` (cached) |
| `make-captions.mjs` | `words.json` to ASS (styled, active-word highlight) and SRT |
| `burn.mjs` | burns ASS/SRT with libass (`ass` / `subtitles` filter) |
| `snap-to-words.mjs` | moves cut points to the nearest gap between words |

## Workflow

1. **Transcribe** (once per source; the result is cached):
   ```bash
   pip install faster-whisper            # once
   python3 scripts/transcribe.py --input clip.mp4 --out edit/clip.words.json --model small --language en
   ```
   The first run downloads the model from Hugging Face. If that is blocked the
   script exits with code 4 and a JSON `fix` message instead of a traceback; it
   never writes a fake transcript. Point `--model` at a local CTranslate2 model
   folder to work offline.
2. **Build captions**:
   ```bash
   node scripts/make-captions.mjs --words edit/clip.words.json --out-ass edit/clip.ass --out-srt edit/clip.srt
   ```
   Style comes from the brand pack (`captions` block: size, margin, outline,
   highlight; `colors.accent` is the active-word color).
3. **Burn** as the very last visual step:
   ```bash
   node scripts/burn.mjs --input edit/clip-hook.mp4 --subs edit/clip.ass --out edit/clip-captioned.mp4
   ```
   Use `--fonts-dir` when the caption font is a file rather than an installed font.
4. **Verify** with a `render-qc` proof sheet: readable, inside the safe area, not over the hook plate.

## Rules

- Never cut inside a word. Before splitting speech, snap cuts to word gaps:
  `node scripts/snap-to-words.mjs --words edit/clip.words.json --markers edit/cuts.json --out edit/cuts.json`
- Captions go on last: after cuts, overlays and color. If you trim the clip after
  transcribing, pass `--offset -<seconds trimmed>` to `make-captions.mjs`.
- 1 to 3 words per chunk for shorts (`maxWords`, `maxChars`). Chunks break on punctuation and on pauses.
- Keep captions out of the bottom ~15% (platform UI) and away from the hook plate: tune `captions.marginV`.
- Transcripts are cached: re-run with `--force` only when the audio changed.
- Spot-check words against the audio; whisper can mishear names and jargon. Fix `words.json` by hand if needed.

## Without ffmpeg libass

If `burn.mjs` reports no `ass` filter, the ffmpeg build lacks libass. Install a
full build (most package managers ship one), or upload the SRT as a separate
caption track instead of burning it in.
