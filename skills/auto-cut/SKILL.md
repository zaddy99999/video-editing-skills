---
name: auto-cut
description: Split long screen recordings, gameplay or app captures into clips and remove dead lead-in. Use when the user has a long continuous video and wants it cut into shorts, wants cut points suggested (scene changes, audio pauses), wants frame-accurate splits from a list of timestamps, or wants clips to start on real content instead of black frames, loading screens or the tail of the previous screen.
---

# auto-cut

Turn one long recording into clean, back-to-back clips that each open on content.
Works on non-speech footage (screen recordings, app reveals, gameplay, music
content) where transcript-based editors have nothing to read.

All scripts are in `scripts/` next to this file. Run them with `node`; each one
prints a single JSON object on stdout (progress goes to stderr) and supports
`--help` and `--help --json` (a machine-readable contract of inputs/outputs).

## Workflow

1. **Inspect** the source: `ffprobe` duration/fps, or a `render-qc` proof sheet.
2. **Suggest cuts** (read-only):
   ```bash
   node scripts/suggest-cuts.mjs --input rec.mp4 --min-clip 8 --out edit/cuts.json
   ```
   Output: `{ source, durationSec, fps, cuts[], reasons[] }`. Each reason is
   `scene`, `pause` or `grid` (even fallback grid when detection is sparse).
3. **Get approval.** Show the cut list (and a proof sheet) to the user. Edit
   `cuts[]` / add `labels[]` in the JSON. Do not split before the plan is agreed.
   For speech, run `captions/scripts/snap-to-words.mjs` first so no cut lands inside a word.
4. **Split** frame-accurately (re-encodes, writes posters + manifest):
   ```bash
   node scripts/split.mjs --markers edit/cuts.json --out-dir edit/clips
   ```
5. **Trim dead lead-in** on every clip, in place, updating the manifest:
   ```bash
   node scripts/trim-lead.mjs --manifest edit/clips/manifest.json
   node scripts/trim-lead.mjs --input clip.mp4 --dry-run   # just report the lead
   ```
   It compares early frames to a settled reference frame later in the clip and
   cuts before the first frame that is not black, not a dark centre-lit loading
   screen (`--loading-heuristic`), and resembles the reference. Clips that are
   black from start to end are flagged `dead: true` and left alone.
6. **Verify**: `render-qc/scripts/proof-sheet.mjs --input-dir edit/clips --mode firstlast`.
   Every FIRST frame must be content; every LAST frame must not be mid-action.

## Rules

- Outputs go to `edit/` beside the source by default. Never overwrite the original recording.
- Cut at pauses or scene changes, never mid-motion or mid-word.
- A clip must open on content: no loading screen, spinner, black frame or the previous screen's tail.
- Detection is a suggestion. A human (or an explicit user instruction) approves the cut list.
- Keep `manifest.json`: downstream skills (hook-overlay batch, render-qc, publish) read it.

## Tuning

| Situation | Flag |
|---|---|
| Too many cuts | raise `--min-clip`, raise `--scene-threshold` (0.3-0.4) |
| UI recordings with subtle changes | lower `--scene-threshold` to 0.1 |
| Music / no meaningful audio | `--no-silence` |
| Lead trim too aggressive | lower `--max-lead`, lower `--threshold` |
| Reference frame lands on a transition | set `--ref-time` |
