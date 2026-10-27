#!/usr/bin/env node
// sticker.mjs: animated sticker (512 px, transparent background).
//
// Formats: webp (animated WebP: WhatsApp / Signal / web), gif (transparent
// palette), webm (VP9 with alpha: Telegram video stickers). Optional chroma
// key removes a solid background (green screen, flat UI color).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, fail, ffmpeg, probe, round, ensureDir, defaultOut } from './_lib.mjs';

const LIMITS = { webp: 500, gif: 1024, webm: 256 }; // KB, common platform caps

const spec = {
  name: 'sticker',
  summary: 'Animated 512px sticker as WebP, transparent GIF or Telegram VP9-alpha WebM, with optional chroma key.',
  usage: [
    'node sticker.mjs --input clip.mp4 --format webp --out sticker.webp',
    'node sticker.mjs --input greenscreen.mp4 --chroma 0x00ff00 --format webm --out sticker.webm',
  ],
  options: {
    input: { required: true, desc: 'Source video or GIF' },
    out: { desc: 'Output file (default: edit/<name>-sticker.<format>)' },
    format: { default: 'webp', desc: 'webp | gif | webm' },
    size: { type: 'number', default: 512, desc: 'Longest side in px (sticker platforms want 512)' },
    start: { type: 'number', default: 0, desc: 'Start (s)' },
    duration: { type: 'number', default: 3, desc: 'Length (s); Telegram max is 3' },
    fps: { type: 'number', default: 15, desc: 'Frame rate' },
    chroma: { desc: 'Key out this color, e.g. 0x00ff00 (green screen) or 0xffffff' },
    similarity: { type: 'number', default: 0.12, desc: 'Chroma key similarity (0-1)' },
    blend: { type: 'number', default: 0.04, desc: 'Chroma key edge blend (0-1)' },
    quality: { type: 'number', default: 70, desc: 'WebP quality (0-100) / used to pick VP9 CRF' },
  },
  outputs: ['Sticker file', 'JSON: { sizeKB, limitKB, width, height }'],
  verify: 'sizeKB <= limitKB for the target platform; preview on a dark and a light background.',
};

const o = parseArgs(spec);
if (!LIMITS[o.format]) fail(`unknown --format ${o.format}`);
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.video) fail('no video stream');
const out = path.resolve(o.out || defaultOut(o.input, '-sticker', '.' + o.format));
ensureDir(path.dirname(out));
const S = o.size;
const key = o.chroma ? `,format=rgba,colorkey=${o.chroma}:${o.similarity}:${o.blend}` : ',format=rgba';
const fit = `fps=${o.fps},scale=${S}:${S}:force_original_aspect_ratio=decrease${key},pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
const inArgs = ['-loglevel', 'error', '-ss', String(o.start), '-t', String(o.duration), '-i', o.input, '-an'];

try {
  if (o.format === 'webp') {
    ffmpeg([...inArgs, '-vf', fit, '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(o.quality),
      '-compression_level', '6', '-loop', '0', '-pix_fmt', 'yuva420p', out]);
  } else if (o.format === 'gif') {
    ffmpeg([...inArgs, '-filter_complex', `[0:v]${fit},split[a][b];[b]palettegen=reserve_transparent=1:stats_mode=diff[p];[a][p]paletteuse=alpha_threshold=128`,
      '-loop', '0', out]);
  } else {
    const crf = Math.round(63 - (o.quality / 100) * 40); // quality 70 -> crf ~35
    ffmpeg([...inArgs, '-vf', `${fit},format=yuva420p`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(crf),
      '-deadline', 'good', '-metadata:s:v:0', 'alpha_mode=1', out]);
  }
} catch (e) { fail(e.message); }

const sizeKB = round(fs.statSync(out).size / 1024, 1);
let dims = { width: S, height: S };
try { const p = probe(out); if (p.video?.width) dims = { width: p.video.width, height: p.video.height }; } catch { /* ffprobe can't always read animated webp */ }
emit({ ok: true, out, format: o.format, sizeKB, limitKB: LIMITS[o.format], ...dims,
  warning: sizeKB > LIMITS[o.format] ? `over the common ${LIMITS[o.format]}KB limit: lower --fps, --duration or --quality` : null });
