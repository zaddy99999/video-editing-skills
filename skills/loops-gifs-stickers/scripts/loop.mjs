#!/usr/bin/env node
// loop.mjs: make a clip loop seamlessly.
//
// crossfade (default): the last --xfade seconds dissolve into the first ones,
//   so the final frame flows into frame 0. Output = duration - xfade.
// pingpong: forward + reversed. Last frame == first frame. ffmpeg's reverse
//   filter buffers every frame in RAM, so keep pingpong sources short (cap
//   --max-duration) or pre-render them once and reuse the result.
import path from 'node:path';
import { parseArgs, emit, fail, ffmpeg, probe, round, ensureDir, defaultOut } from './_lib.mjs';

const spec = {
  name: 'loop',
  summary: 'Seamless loop via end-to-start crossfade or forward+reverse ping-pong.',
  usage: [
    'node loop.mjs --input clip.mp4 --out loop.mp4 [--start 2 --duration 4] [--xfade 0.5]',
    'node loop.mjs --input clip.mp4 --mode pingpong --duration 3 --out pp.mp4',
  ],
  options: {
    input: { required: true, desc: 'Source clip' },
    out: { desc: 'Output MP4 (default: edit/<name>-loop.mp4)' },
    mode: { default: 'crossfade', desc: 'crossfade | pingpong' },
    start: { type: 'number', default: 0, desc: 'Segment start (s)' },
    duration: { type: 'number', desc: 'Segment length (s); default: rest of the clip' },
    xfade: { type: 'number', default: 0.5, desc: 'Crossfade length (s) for crossfade mode' },
    maxDuration: { type: 'number', default: 15, desc: 'Refuse pingpong segments longer than this (RAM safety)' },
    audio: { type: 'boolean', default: false, desc: 'Keep audio (crossfaded too). Off by default: loops are usually silent' },
    crf: { type: 'number', default: 18, desc: 'x264 CRF' },
  },
  outputs: ['Looping MP4', 'JSON: { duration, mode }'],
  verify: 'render-qc proof-sheet --mode firstlast on the output: last and first frames should match (pingpong) or flow (crossfade).',
};

const o = parseArgs(spec);
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.video) fail('no video stream');
const S = o.start;
const D = Math.min(o.duration ?? info.duration - S, info.duration - S);
if (D <= 0.2) fail('segment too short');
const out = path.resolve(o.out || defaultOut(o.input, '-loop', '.mp4'));
ensureDir(path.dirname(out));
const keepAudio = o.audio && !!info.audio;
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

try {
  if (o.mode === 'pingpong') {
    if (D > o.maxDuration) fail(`pingpong segment ${round(D)}s > --max-duration ${o.maxDuration}s (reverse buffers all frames in RAM)`);
    // drop the duplicated turnaround frame on the reversed half
    const fc = `[0:v]trim=start=${S}:duration=${D},setpts=PTS-STARTPTS,split[f][r];[r]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[f][rv]concat=n=2:v=1:a=0[v]`;
    ffmpeg(['-loglevel', 'error', '-i', o.input, '-filter_complex', fc, '-map', '[v]', '-an', ...enc, out]);
  } else if (o.mode === 'crossfade') {
    const X = o.xfade;
    if (X <= 0 || X * 2 >= D) fail('--xfade must be > 0 and less than half the segment');
    const fc = [
      `[0:v]trim=start=${S}:duration=${D},setpts=PTS-STARTPTS,split[m0][h0]`,
      `[m0]trim=start=${X},setpts=PTS-STARTPTS[main]`,
      `[h0]trim=duration=${X},setpts=PTS-STARTPTS[head]`,
      `[main][head]xfade=transition=fade:duration=${X}:offset=${round(D - 2 * X)}[v]`,
    ];
    if (keepAudio) {
      fc.push(`[0:a]atrim=start=${S}:duration=${D},asetpts=PTS-STARTPTS,asplit[am][ah]`,
        `[am]atrim=start=${X},asetpts=PTS-STARTPTS[amain]`,
        `[ah]atrim=duration=${X},asetpts=PTS-STARTPTS[ahead]`,
        `[amain][ahead]acrossfade=d=${X}[a]`);
    }
    ffmpeg(['-loglevel', 'error', '-i', o.input, '-filter_complex', fc.join(';'), '-map', '[v]',
      ...(keepAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : ['-an']), ...enc, out]);
  } else {
    fail(`unknown --mode ${o.mode}`);
  }
} catch (e) { fail(e.message); }
emit({ ok: true, out, mode: o.mode, segment: { start: S, duration: round(D) }, duration: round(probe(out).duration) });
