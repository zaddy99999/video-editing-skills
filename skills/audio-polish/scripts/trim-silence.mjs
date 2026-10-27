#!/usr/bin/env node
// trim-silence.mjs: remove dead air (leading/trailing, or every long pause).
//
// silencedetect finds quiet ranges; each one is shrunk by --pad on both sides
// (auto-editor's "margin" idea: keep a breath of air around speech), then
// the kept ranges are re-joined with 30 ms audio fades at every join so cuts
// never click. Video is cut on the same boundaries so A/V stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, log, run, ffmpeg, probe, round, FFMPEG, ensureDir, defaultOut } from './_lib.mjs';

const spec = {
  name: 'trim-silence',
  summary: 'Cut leading/trailing (or all long) silences with padding and 30ms anti-click fades.',
  usage: [
    'node trim-silence.mjs --input clip.mp4 --out clip-tight.mp4            # edges only',
    'node trim-silence.mjs --input talk.mp4 --all --min-gap 0.6 --pad 0.15   # also internal pauses',
    'node trim-silence.mjs --input clip.mp4 --report-only',
  ],
  options: {
    input: { required: true, desc: 'Video or audio file' },
    out: { desc: 'Output (default: edit/<name>-tight.<ext>)' },
    noise: { type: 'number', default: -40, desc: 'Silence threshold dB' },
    minGap: { type: 'number', default: 0.5, desc: 'Only cut silences at least this long (s)' },
    pad: { type: 'number', default: 0.12, desc: 'Air kept on each side of sound (s)' },
    fade: { type: 'number', default: 0.03, desc: 'Fade in/out at each join (s); 0.03 = 30ms removes clicks' },
    all: { type: 'boolean', desc: 'Cut internal pauses too (default: only lead-in and tail)' },
    reportOnly: { type: 'boolean', desc: 'Print silences and the keep plan; write nothing' },
    crf: { type: 'number', default: 18, desc: 'x264 CRF when re-encoding video' },
  },
  outputs: ['Tightened file', 'JSON: { silences[], keep[], removedSec }'],
  verify: 'Listen at every join (or render-qc audio check); duration = original - removedSec.',
};

const o = parseArgs(spec);
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.audio) fail('input has no audio stream');
const dur = info.duration;

const { stderr } = run(FFMPEG, ['-hide_banner', '-nostdin', '-i', o.input, '-vn', '-af',
  `silencedetect=noise=${o.noise}dB:d=${o.minGap}`, '-f', 'null', '-'], { allowFail: true });
const silences = [];
let s0 = null;
for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
  if (m[1] === 'start') s0 = Math.max(0, parseFloat(m[2]));
  else if (s0 != null) { silences.push({ start: s0, end: Math.min(dur, parseFloat(m[2])) }); s0 = null; }
}
if (s0 != null) silences.push({ start: s0, end: dur }); // silence runs to the end

const eps = 0.02;
const cutRanges = silences
  .filter((s) => o.all || s.start <= eps || s.end >= dur - eps)
  .map((s) => ({
    start: s.start <= eps ? 0 : s.start + o.pad,
    end: s.end >= dur - eps ? dur : s.end - o.pad,
  }))
  .filter((r) => r.end - r.start > 0.05);

const keep = [];
let cursor = 0;
for (const r of cutRanges) {
  if (r.start > cursor) keep.push({ start: cursor, end: r.start });
  cursor = Math.max(cursor, r.end);
}
if (cursor < dur) keep.push({ start: cursor, end: dur });
const kept = keep.filter((k) => k.end - k.start > 0.05);
const removedSec = round(dur - kept.reduce((a, k) => a + (k.end - k.start), 0));
const plan = { silences: silences.map((s) => ({ start: round(s.start), end: round(s.end) })), keep: kept.map((k) => ({ start: round(k.start), end: round(k.end) })), removedSec };

if (o.reportOnly) { emit({ ok: true, reportOnly: true, duration: round(dur), ...plan }); process.exit(0); }
if (!kept.length) fail('the whole file is silent at this threshold; nothing kept', plan);

const ext = path.extname(o.input) || '.mp4';
const out = path.resolve(o.out || defaultOut(o.input, '-tight', ext));
ensureDir(path.dirname(out));
if (removedSec < 0.05) {
  fs.copyFileSync(o.input, out);
  emit({ ok: true, out, note: 'no silence to remove; copied', ...plan });
  process.exit(0);
}

const hasV = !!info.video;
const parts = [];
const labels = [];
kept.forEach((k, i) => {
  const len = k.end - k.start;
  const f = Math.min(o.fade, len / 3);
  if (hasV) parts.push(`[0:v]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`);
  parts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=${f},afade=t=out:st=${Math.max(0, len - f)}:d=${f}[a${i}]`);
  labels.push(hasV ? `[v${i}][a${i}]` : `[a${i}]`);
});
parts.push(`${labels.join('')}concat=n=${kept.length}:v=${hasV ? 1 : 0}:a=1${hasV ? '[v]' : ''}[a]`);

try {
  ffmpeg(['-loglevel', 'error', '-i', o.input, '-filter_complex', parts.join(';'),
    ...(hasV ? ['-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf), '-pix_fmt', 'yuv420p'] : []),
    '-map', '[a]', ...(/\.wav$/i.test(ext) ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']),
    ...(/\.(mp4|m4a|mov)$/i.test(ext) ? ['-movflags', '+faststart'] : []), out]);
} catch (e) { fail(e.message, plan); }
const newDur = probe(out).duration;
log(`removed ${removedSec}s of silence: ${round(dur)}s -> ${round(newDur)}s`);
emit({ ok: true, out, duration: round(dur), newDuration: round(newDur), ...plan });
