#!/usr/bin/env node
// join.mjs: join clips without audio clicks.
//
// Default: hard cuts with a 30 ms audio fade-out/fade-in at every join (cuts
// on non-zero samples are what click). With --crossfade D: video xfade plus
// audio acrossfade of D seconds. Inputs are conformed to the first clip's
// size / fps / sample rate; inputs with no audio get silence.
import path from 'node:path';
import { parseArgs, emit, fail, ffmpeg, probe, round, ensureDir } from './_lib.mjs';

const spec = {
  name: 'join',
  summary: 'Concatenate clips with 30ms anti-click fades or a video+audio crossfade.',
  usage: [
    'node join.mjs --inputs a.mp4,b.mp4,c.mp4 --out joined.mp4',
    'node join.mjs --inputs a.mp4,b.mp4 --crossfade 0.4 --transition fade --out joined.mp4',
  ],
  options: {
    inputs: { type: 'list', required: true, desc: 'Comma-separated clips in order (2+)' },
    out: { required: true, desc: 'Output MP4' },
    crossfade: { type: 'number', default: 0, desc: 'Crossfade seconds (0 = hard cut with click-free fades)' },
    transition: { default: 'fade', desc: 'xfade transition name when --crossfade > 0 (fade, wipeleft, slideup, ...)' },
    fade: { type: 'number', default: 0.03, desc: 'Audio fade at hard cuts (s)' },
    crf: { type: 'number', default: 18, desc: 'x264 CRF' },
  },
  outputs: ['Joined MP4', 'JSON: { duration, expectedDuration }'],
  verify: 'duration ~= sum(inputs) - (n-1) * crossfade; listen at each join.',
};

const o = parseArgs(spec);
if (o.inputs.length < 2) fail('need at least 2 --inputs');
let infos;
try { infos = o.inputs.map(probe); } catch (e) { fail(e.message); }
if (infos.some((i) => !i.video)) fail('every input needs a video stream');
const { width: W, height: H } = infos[0].video;
const fps = Math.round(infos[0].video.fps || 30);
const SR = 48000;
const X = o.crossfade;
if (X > 0 && infos.some((i) => i.duration <= X * 2)) fail('a clip is shorter than 2x the crossfade');

const args = ['-loglevel', 'error'];
o.inputs.forEach((f) => args.push('-i', f));
// silent stand-ins for clips without audio
const silentIdx = {};
infos.forEach((inf, i) => {
  if (!inf.audio) { silentIdx[i] = o.inputs.length + Object.keys(silentIdx).length; args.push('-f', 'lavfi', '-t', String(inf.duration), '-i', `anullsrc=r=${SR}:cl=stereo`); }
});

const f = [];
infos.forEach((inf, i) => {
  f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  const a = silentIdx[i] != null ? `[${silentIdx[i]}:a]` : `[${i}:a]`;
  const fadeA = X > 0 ? '' : `,afade=t=in:st=0:d=${o.fade},afade=t=out:st=${Math.max(0, inf.duration - o.fade)}:d=${o.fade}`;
  f.push(`${a}aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=0:${inf.duration}${fadeA}[a${i}]`);
});

let expected;
if (X > 0) {
  let vPrev = '[v0]', aPrev = '[a0]';
  let offset = 0;
  for (let i = 1; i < infos.length; i++) {
    offset += infos[i - 1].duration - X;
    const vOut = i === infos.length - 1 ? '[v]' : `[vx${i}]`;
    const aOut = i === infos.length - 1 ? '[a]' : `[ax${i}]`;
    f.push(`${vPrev}[v${i}]xfade=transition=${o.transition}:duration=${X}:offset=${round(offset)}${vOut}`);
    f.push(`${aPrev}[a${i}]acrossfade=d=${X}:c1=tri:c2=tri${aOut}`);
    vPrev = vOut; aPrev = aOut;
  }
  expected = infos.reduce((s, i) => s + i.duration, 0) - X * (infos.length - 1);
} else {
  f.push(`${infos.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${infos.length}:v=1:a=1[v][a]`);
  expected = infos.reduce((s, i) => s + i.duration, 0);
}

const out = path.resolve(o.out);
ensureDir(path.dirname(out));
try {
  ffmpeg([...args, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf), '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
} catch (e) { fail(e.message); }
const d = probe(out).duration;
emit({ ok: Math.abs(d - expected) < 0.25, out, duration: round(d), expectedDuration: round(expected), mode: X > 0 ? `crossfade ${X}s (${o.transition})` : `hard cut, ${o.fade * 1000}ms fades` });
