#!/usr/bin/env node
// split.mjs: split a source video into back-to-back clips at approved cuts.
// Frame-accurate (input seek + re-encode), writes one poster per clip and a
// manifest.json. Each cut is the end of one clip and the start of the next.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, log, ffmpeg, probe, round, ensureDir, slug } from './_lib.mjs';

const spec = {
  name: 'split',
  summary: 'Split a video into clips at cut points (from suggest-cuts markers or --cuts).',
  usage: [
    'node split.mjs --markers cuts.json --out-dir edit/clips',
    'node split.mjs --input rec.mp4 --cuts 12.4,31.0,58.2 --out-dir edit/clips',
  ],
  options: {
    markers: { desc: 'Markers JSON { source, cuts[], labels[] } (suggest-cuts output, after human review)' },
    input: { desc: 'Source video (overrides markers.source)' },
    cuts: { type: 'list', desc: 'Comma-separated cut times in seconds (overrides markers.cuts)' },
    outDir: { desc: 'Output folder (default: edit/<source-slug>/ beside the source)' },
    minLen: { type: 'number', default: 0.3, desc: 'Skip segments shorter than this (seconds)' },
    maxWidth: { type: 'number', default: 1080, desc: 'Downscale wider sources to this width (keeps aspect)' },
    crf: { type: 'number', default: 20, desc: 'x264 CRF' },
    preset: { default: 'veryfast', desc: 'x264 preset' },
    posters: { type: 'boolean', default: true, desc: 'Write a JPG poster of each clip\'s first frame' },
    prefix: { default: 'clip', desc: 'Output filename prefix' },
  },
  outputs: ['<out-dir>/<prefix>-NN.mp4', '<out-dir>/<prefix>-NN.jpg', '<out-dir>/manifest.json'],
  verify: 'Run render-qc proof-sheet --mode firstlast on the clips and check every clip opens on content.',
};

const o = parseArgs(spec);
let markers = {};
if (o.markers) {
  try { markers = JSON.parse(fs.readFileSync(o.markers, 'utf8')); } catch (e) { fail(`cannot read markers: ${e.message}`); }
}
const src = o.input || markers.source;
if (!src) fail('need --input or --markers with a "source"');
let info;
try { info = probe(src); } catch (e) { fail(e.message); }
const cuts = (o.cuts.length ? o.cuts.map(Number) : (markers.cuts || []).map(Number))
  .filter((n) => Number.isFinite(n) && n > 0 && n < info.duration).sort((a, b) => a - b);
const labels = markers.labels || [];
const outDir = path.resolve(o.outDir || path.join(path.dirname(path.resolve(src)), 'edit', slug(src)));
ensureDir(outDir);

const bounds = [0, ...cuts, info.duration];
const segments = [];
for (let i = 0; i < bounds.length - 1; i++) {
  if (bounds[i + 1] - bounds[i] < o.minLen) continue;
  segments.push({ start: bounds[i], end: bounds[i + 1], label: labels[i] || '' });
}

log(`splitting ${path.basename(src)} -> ${segments.length} clips in ${outDir}`);
const clips = [];
const errors = [];
segments.forEach((seg, i) => {
  const n = String(i + 1).padStart(2, '0');
  const file = path.join(outDir, `${o.prefix}-${n}.mp4`);
  const poster = path.join(outDir, `${o.prefix}-${n}.jpg`);
  const dur = (seg.end - seg.start).toFixed(3);
  try {
    ffmpeg(['-loglevel', 'error', '-ss', String(seg.start), '-i', src, '-t', dur,
      '-vf', `scale='min(${o.maxWidth},iw)':-2`,
      '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
      ...(info.audio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
      '-movflags', '+faststart', file]);
    if (o.posters) {
      ffmpeg(['-loglevel', 'error', '-ss', '0', '-i', file, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", poster]);
    }
    clips.push({
      id: i + 1, file: path.basename(file), poster: o.posters ? path.basename(poster) : null,
      start: round(seg.start), end: round(seg.end), seconds: round(seg.end - seg.start, 2), label: seg.label,
    });
    log(`  [${i + 1}/${segments.length}] ${path.basename(file)} (${dur}s) ok`);
  } catch (e) {
    errors.push({ segment: i + 1, error: e.message });
    log(`  [${i + 1}/${segments.length}] FAILED ${e.message}`);
  }
});

const manifest = { source: path.resolve(src), createdFrom: o.markers ? path.basename(o.markers) : 'cli', clips };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
emit({ ok: errors.length === 0, outDir, manifest: path.join(outDir, 'manifest.json'), clips: clips.length, errors });
process.exit(errors.length ? 1 : 0);
