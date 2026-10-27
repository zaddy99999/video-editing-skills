#!/usr/bin/env node
// loudnorm.mjs: two-pass EBU R128 loudness normalization (ffmpeg loudnorm).
//
// Pass 1 measures integrated loudness / true peak / LRA, pass 2 applies a
// linear gain with those measurements (no pumping). Video is stream-copied.
// The result is re-measured and verified. --in-place keeps a backup and only
// replaces the original after verification passes (fail loud, never destroy).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, log, run, probe, round, FFMPEG, ensureDir, defaultOut } from './_lib.mjs';

const PRESETS = {
  shorts: { i: -14, tp: -1.5, lra: 11 },   // YouTube / TikTok / Reels playback target
  podcast: { i: -16, tp: -1.5, lra: 11 },
  broadcast: { i: -23, tp: -2, lra: 15 },  // EBU R128
};

const spec = {
  name: 'loudnorm',
  summary: 'Two-pass loudness normalization (EBU R128) with verification; video stream copied.',
  usage: [
    'node loudnorm.mjs --input clip.mp4 --out clip-loud.mp4 [--preset shorts]',
    'node loudnorm.mjs --input clip.mp4 --dry-run        # measure only',
    'node loudnorm.mjs --input clip.mp4 --in-place       # backup, verify, then replace',
  ],
  options: {
    input: { required: true, desc: 'Video or audio file' },
    out: { desc: 'Output (default: edit/<name>-loudnorm.<ext>)' },
    preset: { default: 'shorts', desc: `Target preset: ${Object.keys(PRESETS).join(' | ')}` },
    i: { type: 'number', desc: 'Integrated loudness target LUFS (overrides preset)' },
    tp: { type: 'number', desc: 'True-peak ceiling dBTP (overrides preset)' },
    lra: { type: 'number', desc: 'Loudness range target (overrides preset)' },
    tolerance: { type: 'number', default: 1, desc: 'Allowed |measured - target| LUFS for verify' },
    inPlace: { type: 'boolean', desc: 'Replace the input after verification (backup kept as <name>.pre-loudnorm.<ext>)' },
    dryRun: { type: 'boolean', desc: 'Measure only, write nothing' },
    bitrate: { default: '192k', desc: 'AAC bitrate for the re-encoded audio' },
  },
  outputs: ['Normalized file', 'JSON: { before:{i,tp,lra}, after:{i,tp,lra}, verified }'],
  verify: 'after.i within tolerance of target and after.tp <= target tp + 0.5 (AAC adds a little).',
};

const o = parseArgs(spec);
const preset = PRESETS[o.preset];
if (!preset) fail(`unknown preset "${o.preset}"`);
const T = { i: o.i ?? preset.i, tp: o.tp ?? preset.tp, lra: o.lra ?? preset.lra };

let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.audio) fail('input has no audio stream');

function measure(file, extra = '') {
  const { stderr } = run(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af',
    `loudnorm=I=${T.i}:TP=${T.tp}:LRA=${T.lra}${extra}:print_format=json`, '-f', 'null', '-'], { allowFail: true });
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) throw new Error(`loudnorm produced no measurement: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return JSON.parse(m[0]);
}
const pick = (j) => ({ i: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra), thresh: Number(j.input_thresh) });

try {
  const m1 = measure(o.input);
  const before = pick(m1);
  if (o.dryRun) emit({ ok: true, dryRun: true, target: T, before });
  if (o.dryRun) process.exit(0);
  if (!Number.isFinite(before.i) || before.i < -70) fail('audio is silent (integrated loudness below -70 LUFS); nothing to normalize', { before });

  const ext = path.extname(o.input) || '.mp4';
  const finalOut = o.inPlace ? path.resolve(o.input) : path.resolve(o.out || defaultOut(o.input, '-loudnorm', ext));
  const tmp = finalOut.replace(/(\.[^.]+)$/, `.loudnorm-tmp-${process.pid}$1`);
  ensureDir(path.dirname(finalOut));
  const af = `loudnorm=I=${T.i}:TP=${T.tp}:LRA=${T.lra}:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}` +
    `:measured_LRA=${m1.input_lra}:measured_thresh=${m1.input_thresh}:offset=${m1.target_offset}:linear=true:print_format=summary,` +
    `aresample=${info.audio.sampleRate || 48000}`; // loudnorm upsamples to 192k internally
  const isAudioOnly = !info.video;
  const codecArgs = isAudioOnly && /\.(wav)$/i.test(ext) ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', o.bitrate];
  run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', o.input,
    ...(isAudioOnly ? [] : ['-map', '0:v:0', '-c:v', 'copy']), '-map', '0:a:0', '-af', af, ...codecArgs,
    ...(/\.(mp4|m4a|mov)$/i.test(ext) ? ['-movflags', '+faststart'] : []), tmp]);

  const after = pick(measure(tmp));
  const durDelta = Math.abs(probe(tmp).duration - info.duration);
  const verified = Math.abs(after.i - T.i) <= o.tolerance && after.tp <= T.tp + 0.5 && durDelta <= 0.2;
  if (!verified) {
    fs.rmSync(tmp, { force: true });
    fail('verification failed; original left untouched', { target: T, before, after: { ...after, durDelta: round(durDelta) } });
  }
  let backup = null;
  if (o.inPlace) {
    backup = finalOut.replace(/(\.[^.]+)$/, '.pre-loudnorm$1');
    if (!fs.existsSync(backup)) fs.copyFileSync(finalOut, backup);
  }
  fs.renameSync(tmp, finalOut);
  log(`loudness ${before.i} -> ${after.i} LUFS, true peak ${before.tp} -> ${after.tp} dBTP`);
  emit({ ok: true, out: finalOut, backup, target: T, before, after, durationDelta: round(durDelta), verified });
} catch (e) { fail(e.message); }
