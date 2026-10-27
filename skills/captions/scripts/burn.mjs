#!/usr/bin/env node
// burn.mjs: burn ASS/SRT captions into a video with libass (ffmpeg `ass` /
// `subtitles` filter). Captions are always the LAST visual step, after cuts,
// overlays and grading, so they are never cut, scaled or covered.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, emit, fail, ffmpeg, run, probe, ensureDir, defaultOut, FFMPEG } from './_lib.mjs';

const spec = {
  name: 'burn',
  summary: 'Burn ASS or SRT captions into a video (libass).',
  usage: ['node burn.mjs --input clip.mp4 --subs clip.ass --out clip-captioned.mp4 [--fonts-dir ./fonts]'],
  options: {
    input: { required: true, desc: 'Input video' },
    subs: { required: true, desc: '.ass or .srt file' },
    out: { desc: 'Output MP4 (default: edit/<name>-captioned.mp4)' },
    fontsDir: { desc: 'Folder of TTF/OTF fonts for libass (use for a font that is not installed)' },
    crf: { type: 'number', default: 18, desc: 'x264 CRF' },
  },
  outputs: ['MP4 with burned-in captions (audio stream copied)'],
  verify: 'render-qc proof-sheet on the output; captions readable, inside safe area, not overlapping the hook plate.',
};

const o = parseArgs(spec);
const { stdout: filters } = run(FFMPEG, ['-hide_banner', '-filters'], { allowFail: true });
const isAss = /\.ass$/i.test(o.subs);
const filterName = isAss ? 'ass' : 'subtitles';
if (!new RegExp(`\\s${filterName}\\s`).test(filters)) {
  fail(`this ffmpeg has no "${filterName}" filter (built without libass). Install a full ffmpeg build, or use hook-overlay style PNG text instead.`);
}
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!fs.existsSync(o.subs)) fail(`subs not found: ${o.subs}`);

// Copy subs to a temp path with a filter-safe name (avoids escaping ':' and quotes in user paths).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
try {
  const subs = path.join(tmp, isAss ? 'subs.ass' : 'subs.srt');
  fs.copyFileSync(o.subs, subs);
  let vf = `${filterName}='${esc(subs)}'`;
  if (o.fontsDir) vf += `:fontsdir='${esc(path.resolve(o.fontsDir))}'`;
  const out = path.resolve(o.out || defaultOut(o.input, '-captioned', '.mp4'));
  ensureDir(path.dirname(out));
  ffmpeg(['-loglevel', 'error', '-i', o.input, '-vf', `${vf},format=yuv420p`, '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf), '-c:a', 'copy', '-movflags', '+faststart', out]);
  emit({ ok: true, out, filter: filterName, duration: probe(out).duration, inputDuration: info.duration });
} catch (e) {
  fail(e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
