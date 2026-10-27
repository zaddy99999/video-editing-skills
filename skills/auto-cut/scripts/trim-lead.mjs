#!/usr/bin/env node
// trim-lead.mjs: remove dead lead-in so a clip opens on content.
//
// Samples tiny grayscale frames from the first --max-lead seconds (one ffmpeg
// call, raw frames on stdout), compares each to a "settled" reference frame
// taken later in the clip, and trims everything before the first frame that
// (a) is not black / near-black, (b) is not a dark "loading screen" (only the
// centre band lit, optional heuristic) and (c) resembles the reference.
// Works on screen recordings, app captures and gameplay where clips often
// start on the tail of the previous screen, a black frame, or a spinner.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, log, ffmpeg, runBuffer, probe, round, FFMPEG, defaultOut, ensureDir } from './_lib.mjs';

const spec = {
  name: 'trim-lead',
  summary: 'Trim black / loading / transitional frames from the start of clips so they open on content.',
  usage: [
    'node trim-lead.mjs --input clip.mp4 [--out clip-trimmed.mp4] [--dry-run]',
    'node trim-lead.mjs --manifest edit/rec/manifest.json   # every clip from split.mjs, in place',
  ],
  options: {
    input: { desc: 'One clip' },
    manifest: { desc: 'split.mjs manifest.json: trims every clip in place and updates the manifest' },
    out: { desc: 'Output for --input (default: edit/<name>-trimmed.mp4 beside the clip)' },
    refTime: { type: 'number', desc: 'Reference "settled" time in seconds (default: min(50% of clip, 6s))' },
    threshold: { type: 'number', default: 0.07, desc: 'Mean abs diff (0-1) below which a frame resembles the reference' },
    maxLead: { type: 'number', default: 5, desc: 'Never trim more than this many seconds' },
    step: { type: 'number', default: 0.05, desc: 'Sampling step in seconds' },
    darkLuma: { type: 'number', default: 12, desc: 'Mean luma (0-255) below which a frame counts as black' },
    loadingHeuristic: { type: 'boolean', desc: 'Also skip dark frames lit only in the centre band (spinner/logo loading screens)' },
    minTrim: { type: 'number', default: 0.05, desc: 'Ignore leads shorter than this' },
    dryRun: { type: 'boolean', desc: 'Only report the detected lead; write nothing' },
  },
  outputs: ['Trimmed MP4 (or clips rewritten in place with --manifest)', 'JSON: { results: [{ clip, lead, out }] }'],
  verify: 'render-qc proof-sheet --mode firstlast: the first frame of every clip should be real content.',
};

const o = parseArgs(spec);
if (!o.input && !o.manifest) fail('need --input or --manifest');

const GW = 48, GH = 27, PX = GW * GH;

function grayFrames(clip, start, dur, fps) {
  const buf = runBuffer(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(dur),
    '-i', clip, '-an', '-vf', `fps=${fps},scale=${GW}:${GH},format=gray`, '-f', 'rawvideo', 'pipe:1']);
  const frames = [];
  for (let off = 0; off + PX <= buf.length; off += PX) frames.push(buf.subarray(off, off + PX));
  return frames;
}
const mean = (g) => { let s = 0; for (let i = 0; i < g.length; i++) s += g[i]; return s / g.length; };
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255; };
function isLoading(g) {
  // dark overall, top and bottom thirds black, something lit in the middle
  const band = [0, 0, 0], cnt = [0, 0, 0];
  for (let y = 0; y < GH; y++) {
    const b = y < GH / 3 ? 0 : y < (2 * GH) / 3 ? 1 : 2;
    for (let x = 0; x < GW; x++) { band[b] += g[y * GW + x]; cnt[b]++; }
  }
  return mean(g) < o.darkLuma * 2.2 && band[0] / cnt[0] < o.darkLuma && band[2] / cnt[2] < o.darkLuma;
}

function detectLead(clip) {
  const info = probe(clip);
  const dur = info.duration;
  if (!info.video || dur < 0.5) return { lead: 0, duration: dur, note: 'too short or no video' };
  const refT = Math.min(o.refTime ?? Math.min(dur * 0.5, 6), dur - 0.1);
  const [ref] = grayFrames(clip, refT, 0.5, 1 / 0.5);
  if (!ref) return { lead: 0, duration: dur, note: 'could not read reference frame' };
  const span = Math.min(o.maxLead, Math.max(0, dur - 0.2));
  const frames = grayFrames(clip, 0, span, 1 / o.step);
  for (let i = 0; i < frames.length; i++) {
    const g = frames[i];
    const m = mean(g);
    if (m < o.darkLuma) continue;
    if (o.loadingHeuristic && isLoading(g)) continue;
    if (diff(g, ref) < o.threshold) return { lead: round(i * o.step, 2), duration: dur, refTime: round(refT, 2) };
  }
  // nothing resembled the reference: only trim pure-black frames
  let i = 0;
  while (i < frames.length && mean(frames[i]) < o.darkLuma) i++;
  if (i && i * o.step >= dur - 0.3) return { lead: 0, duration: dur, dead: true, note: 'whole clip looks black; not trimmed (review or drop it)' };
  return { lead: round(i * o.step, 2), duration: dur, refTime: round(refT, 2), note: i ? 'black-only trim' : 'no settled match; left as is' };
}

function trimTo(clip, lead, out) {
  const info = probe(clip);
  const tmp = out === clip ? clip.replace(/(\.[^.]+)$/, `.trim-tmp-${process.pid}$1`) : out;
  ensureDir(path.dirname(path.resolve(tmp)));
  ffmpeg(['-loglevel', 'error', '-ss', String(lead), '-i', clip,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    ...(info.audio ? ['-c:a', 'aac', '-b:a', '160k', '-af', 'afade=t=in:d=0.03'] : ['-an']),
    '-movflags', '+faststart', tmp]);
  if (tmp !== out) fs.renameSync(tmp, out);
  return out;
}

const results = [];
try {
  if (o.input) {
    const d = detectLead(o.input);
    const out = path.resolve(o.out || defaultOut(o.input, '-trimmed'));
    const r = { clip: o.input, ...d, out: null };
    if (!o.dryRun) {
      if (d.lead > o.minTrim) r.out = trimTo(o.input, d.lead, out);
      else { ensureDir(path.dirname(out)); fs.copyFileSync(o.input, out); r.out = out; r.note = (r.note ? r.note + '; ' : '') + 'no trim needed, copied'; }
    }
    results.push(r);
  } else {
    const mPath = path.resolve(o.manifest);
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    const dir = path.dirname(mPath);
    for (const c of m.clips || []) {
      const file = path.join(dir, c.file);
      if (!fs.existsSync(file)) { results.push({ clip: c.file, error: 'missing' }); continue; }
      const d = detectLead(file);
      const r = { clip: c.file, ...d };
      if (!o.dryRun && d.lead > o.minTrim) {
        trimTo(file, d.lead, file);
        if (c.poster) ffmpeg(['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", path.join(dir, c.poster)]);
        c.start = round((c.start || 0) + d.lead);
        c.seconds = round(c.seconds - d.lead, 2);
        c.leadTrimmed = d.lead;
      }
      results.push(r);
      log(`  ${c.file}: lead ${d.lead}s${d.note ? ' (' + d.note + ')' : ''}`);
    }
    if (!o.dryRun) fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
  }
} catch (e) { fail(e.message, { results }); }

emit({ ok: true, dryRun: o.dryRun, trimmed: results.filter((r) => r.lead > o.minTrim).length, results });
