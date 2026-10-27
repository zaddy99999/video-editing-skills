#!/usr/bin/env node
// suggest-cuts.mjs: propose cut points for a long recording.
// Read-only. Combines ffmpeg scene-change detection (visual cuts) with
// silencedetect midpoints (audio pauses), merges cuts closer than --min-clip,
// and falls back to an even grid when detection finds too little.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, log, run, probe, round, FFMPEG, ensureDir } from './_lib.mjs';

const spec = {
  name: 'suggest-cuts',
  summary: 'Suggest cut points (scene changes + audio pauses) for a long video. Read-only.',
  usage: ['node suggest-cuts.mjs --input rec.mp4 [--min-clip 6] [--out cuts.json]'],
  options: {
    input: { required: true, desc: 'Source video' },
    minClip: { type: 'number', default: 6, desc: 'Minimum seconds between cuts' },
    sceneThreshold: { type: 'number', default: 0.2, desc: 'ffmpeg scene score (0-1); lower = more cuts' },
    silenceDb: { type: 'number', default: -28, desc: 'Silence threshold in dB for pause detection' },
    silenceMin: { type: 'number', default: 0.4, desc: 'Minimum pause length in seconds' },
    grid: { type: 'number', default: 35, desc: 'Fallback grid step in seconds when detection is sparse (0 = off)' },
    noScene: { type: 'boolean', desc: 'Skip scene detection' },
    noSilence: { type: 'boolean', desc: 'Skip silence detection' },
    out: { desc: 'Write the markers JSON here (also printed). Feed it to split.mjs' },
  },
  outputs: ['JSON markers: { source, durationSec, fps, cuts[], reasons[], labels[] } (split.mjs input)'],
  verify: 'Open the markers in an approval step (or render-qc proof-sheet) before splitting.',
};

const o = parseArgs(spec);
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.video) fail('input has no video stream');
const dur = info.duration;
log(`analyzing ${path.basename(o.input)}: ${dur.toFixed(1)}s @ ${(info.video.fps || 0).toFixed(2)}fps`);

function sceneCuts() {
  const { stderr } = run(FFMPEG, ['-hide_banner', '-nostdin', '-i', o.input, '-an', '-filter:v',
    `select='gt(scene,${o.sceneThreshold})',showinfo`, '-f', 'null', '-'], { allowFail: true });
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => ({ t: parseFloat(m[1]), reason: 'scene' }));
}

function silenceCuts() {
  if (!info.audio) return [];
  const { stderr } = run(FFMPEG, ['-hide_banner', '-nostdin', '-i', o.input, '-vn', '-af',
    `silencedetect=noise=${o.silenceDb}dB:d=${o.silenceMin}`, '-f', 'null', '-'], { allowFail: true });
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[0-9.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  // cut at the middle of each pause: never inside speech
  return starts.map((s, i) => ({ t: ends[i] != null ? (Math.max(0, s) + ends[i]) / 2 : s, reason: 'pause' }));
}

const raw = [
  ...(o.noScene ? [] : sceneCuts()),
  ...(o.noSilence ? [] : silenceCuts()),
].filter((c) => c.t >= o.minClip && c.t <= dur - Math.min(o.minClip, 1)).sort((a, b) => a.t - b.t);

const picked = [];
for (const c of raw) {
  const last = picked[picked.length - 1];
  if (!last || c.t - last.t >= o.minClip) picked.push({ t: round(c.t), reason: c.reason });
  else if (last.reason !== c.reason && !last.reason.includes('+')) last.reason += '+' + c.reason;
}

// Sparse detection (< ~1 cut per minute): lay an even grid so a reviewer has
// something to nudge instead of one giant clip.
if (o.grid > 0 && picked.length < Math.floor(dur / 60)) {
  for (let t = o.grid; t < dur - o.minClip; t += o.grid) {
    if (!picked.some((c) => Math.abs(c.t - t) < o.minClip)) picked.push({ t: round(t), reason: 'grid' });
  }
  picked.sort((a, b) => a.t - b.t);
}

const result = {
  ok: true,
  source: path.resolve(o.input),
  durationSec: round(dur),
  fps: info.video.fps ? round(info.video.fps, 3) : null,
  cuts: picked.map((c) => c.t),
  reasons: picked.map((c) => c.reason),
  labels: [],
  clips: picked.length + 1,
};
if (o.out) {
  ensureDir(path.dirname(path.resolve(o.out)));
  fs.writeFileSync(o.out, JSON.stringify(result, null, 2) + '\n');
  result.out = path.resolve(o.out);
}
emit(result);
