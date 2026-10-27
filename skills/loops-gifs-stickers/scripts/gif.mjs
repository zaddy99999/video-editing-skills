#!/usr/bin/env node
// gif.mjs: high-quality GIF with a per-clip palette (palettegen/paletteuse),
// optional meme-style caption rendered with sharp (stroked text, no drawtext).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, emit, fail, ffmpeg, probe, round, ensureDir, defaultOut, loadBrand } from './_lib.mjs';

const spec = {
  name: 'gif',
  summary: 'Video -> optimized GIF (palettegen/paletteuse), optional stroked caption.',
  usage: ['node gif.mjs --input clip.mp4 --out clip.gif [--start 1 --duration 3 --fps 12 --width 480] [--caption "when the render passes QC"]'],
  options: {
    input: { required: true, desc: 'Source video' },
    out: { desc: 'Output GIF (default: edit/<name>.gif)' },
    start: { type: 'number', default: 0, desc: 'Start (s)' },
    duration: { type: 'number', default: 4, desc: 'Length (s)' },
    fps: { type: 'number', default: 12, desc: 'Frame rate (10-15 is the sweet spot for size)' },
    width: { type: 'number', default: 480, desc: 'Output width px' },
    square: { type: 'boolean', desc: 'Center-crop to a square' },
    colors: { type: 'number', default: 128, desc: 'Palette size (2-256)' },
    dither: { default: 'bayer', desc: 'bayer | sierra2_4a | floyd_steinberg | none' },
    caption: { desc: 'Caption text (uppercased, white with black stroke)' },
    position: { default: 'top', desc: 'Caption position: top | bottom' },
    brand: { desc: 'Brand pack for the caption font family' },
    font: { desc: 'Font family override for the caption' },
    maxMb: { type: 'number', default: 8, desc: 'Warn when output exceeds this size' },
  },
  outputs: ['Looping GIF', 'JSON: { sizeMB, width, height, frames }'],
  verify: 'Check sizeMB against the destination limit; open the GIF and confirm it loops cleanly.',
};

const o = parseArgs(spec);
let info;
try { info = probe(o.input); } catch (e) { fail(e.message); }
if (!info.video) fail('no video stream');
const W = Math.round(o.width / 2) * 2;
const Hs = o.square ? W : Math.round((W * info.video.height) / info.video.width / 2) * 2;
const out = path.resolve(o.out || defaultOut(o.input, '', '.gif'));
ensureDir(path.dirname(out));
const base = o.square
  ? `fps=${o.fps},scale=${W}:${W}:force_original_aspect_ratio=increase,crop=${W}:${W}`
  : `fps=${o.fps},scale=${W}:${Hs}:flags=lanczos`;
const ditherOpt = o.dither === 'none' ? 'dither=none' : `dither=${o.dither}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-'));
try {
  let filter;
  const inputs = ['-ss', String(o.start), '-t', String(o.duration), '-i', o.input];
  if (o.caption) {
    const sharp = (await import('sharp')).default;
    const brand = loadBrand(o.brand, import.meta.url);
    const family = o.font || brand.font.family || 'Sans';
    const text = o.caption.toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // fit: ~0.62em per glyph estimate, clamp to 4-11% of width, wrap to 2 lines if needed
    let fs_ = Math.min(W * 0.11, (W * 0.92) / (text.length * 0.62));
    let lines = [text];
    if (fs_ < W * 0.06 && text.includes(' ')) {
      const words = text.split(' ');
      let best = [text], bw = Infinity;
      for (let i = 1; i < words.length; i++) {
        const c = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
        const w = Math.max(...c.map((l) => l.length));
        if (w < bw) { bw = w; best = c; }
      }
      lines = best;
      fs_ = Math.min(W * 0.11, (W * 0.92) / (bw * 0.62));
    }
    fs_ = Math.max(W * 0.04, fs_);
    const lh = fs_ * 1.08;
    const margin = Math.max(12, fs_ * 0.4);
    const y0 = o.position === 'bottom' ? Hs - margin - lh * (lines.length - 1) - fs_ * 0.2 : margin + fs_;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hs}">
      <style>text{font-family:${family.split(',').map((f) => `'${f.trim()}'`).join(',')},sans-serif;font-weight:900;font-size:${round(fs_, 1)}px;text-anchor:middle;fill:#fff;stroke:#000;stroke-width:${Math.max(3, round(fs_ * 0.12, 1))}px;paint-order:stroke;stroke-linejoin:round}</style>
      ${lines.map((l, i) => `<text x="${W / 2}" y="${round(y0 + i * lh, 1)}">${l}</text>`).join('')}</svg>`;
    const png = path.join(tmp, 'caption.png');
    await sharp(Buffer.from(svg)).png().toFile(png);
    inputs.push('-loop', '1', '-i', png);
    filter = `[0:v]${base}[b];[1:v]format=rgba[c];[b][c]overlay=0:0:shortest=1,split[a][p];[p]palettegen=max_colors=${o.colors}:stats_mode=diff[pal];[a][pal]paletteuse=${ditherOpt}`;
  } else {
    filter = `[0:v]${base},split[a][p];[p]palettegen=max_colors=${o.colors}:stats_mode=diff[pal];[a][pal]paletteuse=${ditherOpt}`;
  }
  ffmpeg(['-loglevel', 'error', ...inputs, '-filter_complex', filter, '-loop', '0', out]);
} catch (e) {
  fail(e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const p = probe(out);
const sizeMB = round(fs.statSync(out).size / 1048576, 2);
emit({ ok: true, out, sizeMB, width: p.video.width, height: p.video.height, fps: o.fps, duration: round(p.duration, 2),
  warning: sizeMB > o.maxMb ? `GIF is ${sizeMB}MB > ${o.maxMb}MB: lower --fps, --width, --colors or --duration` : null });
