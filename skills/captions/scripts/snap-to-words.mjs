#!/usr/bin/env node
// snap-to-words.mjs: move proposed cut points so they never land inside a word.
//
// Each cut is snapped to the nearest gap between two words (the gap midpoint,
// or word end + pad when the gap is wide). Use it on suggest-cuts output, or
// on any hand-made cut list, before split.mjs on speech content.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, round, ensureDir } from './_lib.mjs';

const spec = {
  name: 'snap-to-words',
  summary: 'Snap cut times to the nearest silence between words (never cut inside a word).',
  usage: [
    'node snap-to-words.mjs --words clip.words.json --markers cuts.json --out cuts.snapped.json',
    'node snap-to-words.mjs --words clip.words.json --cuts 12.3,40.8',
  ],
  options: {
    words: { required: true, desc: 'words.json from transcribe.py' },
    markers: { desc: 'Markers JSON with cuts[] (suggest-cuts output)' },
    cuts: { type: 'list', desc: 'Comma-separated cut times (instead of --markers)' },
    pad: { type: 'number', default: 0.08, desc: 'Keep at least this much air after the previous word (s)' },
    maxShift: { type: 'number', default: 1.5, desc: 'Do not move a cut more than this (s); flag it instead' },
    out: { desc: 'Write updated markers here' },
  },
  outputs: ['Markers JSON with snapped cuts[] and a moves[] report'],
  verify: 'Every reported cut has insideWord=false.',
};

const o = parseArgs(spec);
const words = JSON.parse(fs.readFileSync(o.words, 'utf8')).words || [];
if (!words.length) fail('no words in --words');
let markers = o.markers ? JSON.parse(fs.readFileSync(o.markers, 'utf8')) : { cuts: [] };
const cuts = o.cuts.length ? o.cuts.map(Number) : (markers.cuts || []).map(Number);
if (!cuts.length) fail('no cuts given (--markers or --cuts)');

// candidate safe points: before the first word, every inter-word gap, after the last word
const gaps = [];
gaps.push({ a: 0, b: words[0].start });
for (let i = 0; i < words.length - 1; i++) gaps.push({ a: words[i].end, b: words[i + 1].start });
gaps.push({ a: words[words.length - 1].end, b: Infinity });
const safe = (g) => {
  const width = g.b - g.a;
  if (!Number.isFinite(width)) return g.a + o.pad;
  return width > 2 * o.pad ? Math.min(g.a + Math.max(o.pad, width / 2), g.b - o.pad) : g.a + width / 2;
};
const insideWord = (t) => words.some((w) => t > w.start + 1e-3 && t < w.end - 1e-3);

const moves = cuts.map((c) => {
  let best = null;
  for (const g of gaps) {
    const s = safe(g);
    if (!best || Math.abs(s - c) < Math.abs(best - c)) best = s;
  }
  const shift = best - c;
  const ok = Math.abs(shift) <= o.maxShift;
  const t = ok ? round(best) : c;
  return { from: c, to: t, shift: round(shift), insideWord: insideWord(t), flagged: !ok };
});
markers = { ...markers, cuts: moves.map((m) => m.to), snappedToWords: true };
if (o.out) { ensureDir(path.dirname(path.resolve(o.out))); fs.writeFileSync(o.out, JSON.stringify(markers, null, 2) + '\n'); }
emit({ ok: moves.every((m) => !m.insideWord), out: o.out ? path.resolve(o.out) : null, cuts: markers.cuts, moves });
