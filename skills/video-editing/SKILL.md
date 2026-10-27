---
name: video-editing
description: Entry point for editing videos with ffmpeg from the terminal, especially short-form vertical video (Shorts, TikTok, Reels) made from screen recordings, app captures, gameplay or music content. Use when the user asks to edit, cut, caption, polish, loop, QC or publish a video and you need to pick the right skill and order of steps. Routes to auto-cut, hook-overlay, captions, audio-polish, loops-gifs-stickers, render-qc and youtube-publish.
---

# video-editing (router)

You edit video by running small, single-purpose scripts and reading their JSON
output, not by watching the video. Look at frames (proof sheets, full-res
stills) only at decision points.

## Which skill

| The user wants... | Skill |
|---|---|
| a long recording split into clips, cut points suggested, dead lead-in removed | `auto-cut` |
| hook / title / "POV:" text on the video | `hook-overlay` |
| subtitles, captions, a transcript, cuts that respect words | `captions` |
| loudness fixed, silence removed, clean joins, crossfades | `audio-polish` |
| a seamless loop, a GIF, a meme GIF, a sticker | `loops-gifs-stickers` |
| to know if a render is OK, a contact sheet, an approval step | `render-qc` |
| the video on YouTube | `youtube-publish` |

## Default pipeline (raw screen recording to published Short)

```
auto-cut  ->  hook-overlay  ->  captions  ->  audio-polish  ->  render-qc  ->  youtube-publish
suggest,      plate PNG +      transcribe,    trim silence,     verify,         dry-run,
approve,      overlay          ASS, burn      loudnorm          proof sheet,    upload private,
split, trim                    (last visual)  (last audio)      user approves   ledger
```

Not every job needs every step: a music clip skips captions; a GIF skips
publishing. Ask when the goal is unclear; otherwise state the plan and go.

## Hard rules (all skills)

1. **Never touch the original.** Outputs go to `edit/` beside the source (scripts default to this).
2. **Plan, then cut.** Propose cut points / hooks / settings and get the user's OK before destructive or slow steps.
3. **Never cut inside a word.** For speech, snap cuts to word gaps (`captions/snap-to-words`).
4. **Every audio cut gets a ~30 ms fade.** Clicks come from cutting on non-zero samples.
5. **Clips open on content.** No black frames, loading screens or the previous screen's tail (`auto-cut/trim-lead`, checked by `render-qc`).
6. **Text stays in the safe zone.** Hook plate in the top area, max 2 lines; captions above the bottom platform UI; nothing overlapping.
7. **Order matters.** Cuts, then overlays, then captions (last visual step), then loudness (last audio step), then QC.
8. **QC every final render** with `render-qc/verify-render`, then show the user the proof sheet or the real MP4. Do not judge from downscaled previews.
9. **Approval is human.** Never pass `--approved` or `--allow-public` unless the user said so in this conversation.
10. **Secrets stay out of git and out of logs.** OAuth clients and tokens live in env vars or gitignored files; never print them.
11. **Prefer re-running a script with different flags over hand-writing ffmpeg.** Every script answers `--help` and `--help --json`.

## Setup check

```bash
ffmpeg -version && ffprobe -version     # required (any recent build; drawtext NOT required)
node --version                          # >= 18
npm install                             # once, at the repo root (installs sharp)
python3 -m pip install faster-whisper   # only for captions/transcribe.py
```
If ffmpeg is not on PATH, set `FFMPEG_PATH` and `FFPROBE_PATH`.

## Style packs

`brands/example.json` holds canvas size, font, colors, hook-plate geometry and
caption style. Copy it per channel/brand and pass `--brand brands/<name>.json`.
Use system fonts or open-license fonts (`--font-file`); never commit commercial fonts.
