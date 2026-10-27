#!/usr/bin/env node
// render-hook.mjs: burn a hook / title "plate" onto a vertical clip.
//
// Does NOT need ffmpeg's drawtext filter (many builds ship without it). The
// plate and text are rendered to a transparent PNG with sharp (Pango text
// layout, any system font or a --font-file TTF/OTF), auto-sized so the widest
// line fills the plate, balanced into at most 2 lines, then composited with
// ffmpeg's overlay filter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, emit, fail, log, ffmpeg, probe, loadBrand, ensureDir, defaultOut, parseSize, round } from './_lib.mjs';

const spec = {
  name: 'render-hook',
  summary: 'Render a text hook plate (sharp, no drawtext needed) and overlay it on a clip.',
  usage: [
    'node render-hook.mjs --input clip.mp4 --text "POV: you automated your edits" --out hooked.mp4',
    'node render-hook.mjs --text "Preview me" --plate-only plate.png',
    'node render-hook.mjs --jobs jobs.json            # [{ "input", "text", "out" }]',
    'node render-hook.mjs --input-dir clips/ --texts hooks.txt --out-dir hooked/   # rotate hooks across clips',
  ],
  options: {
    input: { desc: 'Input clip' },
    text: { desc: 'Hook text (emoji are stripped; plain fonts render them as boxes)' },
    out: { desc: 'Output MP4 (default: edit/<name>-hook.mp4 beside the input)' },
    brand: { desc: 'Brand / style pack JSON (default: brands/example.json)' },
    font: { desc: 'Pango font family override, e.g. "Inter", "DejaVu Sans"' },
    fontFile: { desc: 'TTF/OTF file to use (e.g. an OFL font you downloaded); overrides brand.font.file' },
    weight: { desc: 'Font weight word: normal | bold | heavy | ultrabold (default from brand)' },
    size: { desc: 'Output canvas WxH (default: brand.canvas, e.g. 1080x1920)' },
    fit: { default: 'cover', desc: 'cover = scale+crop to fill canvas, contain = letterbox' },
    start: { type: 'number', default: 0, desc: 'Show plate from this second' },
    end: { type: 'number', desc: 'Hide plate after this second (default: whole clip)' },
    fade: { type: 'number', default: 0, desc: 'Plate fade-in seconds' },
    lines: { default: 'auto', desc: 'auto | 1 | 2 (never 3: long hooks get smaller, not taller)' },
    plateTop: { type: 'number', desc: 'Override plate top offset in px' },
    plateWidth: { type: 'number', desc: 'Override plate width in px' },
    plateOnly: { desc: 'Only write the plate PNG to this path (fast preview, no video)' },
    jobs: { desc: 'Batch JSON array of { input, text, out }' },
    inputDir: { desc: 'Folder of .mp4 clips for rotation mode' },
    texts: { desc: 'Text file, one hook per line, rotated across --input-dir clips' },
    outDir: { desc: 'Output folder for rotation mode' },
    crf: { type: 'number', default: 18, desc: 'x264 CRF' },
  },
  outputs: ['MP4 with plate overlay (or a PNG with --plate-only)', 'JSON: { ok, results: [{ out, plate: { width, height, fontSize, lines } }] }'],
  verify: 'Extract a frame (render-qc proof-sheet) and check the text sits inside the top safe zone, max 2 lines, nothing clipped.',
};

const o = parseArgs(spec);
let sharp;
try { sharp = (await import('sharp')).default; } catch {
  fail('sharp is not installed. Run `npm install` in the repo root (or `npm i sharp`).');
}

const brand = loadBrand(o.brand, import.meta.url);
if (o.font) brand.font.family = o.font;
if (o.fontFile) brand.font.file = path.resolve(o.fontFile);
if (o.weight) brand.font.weight = o.weight;
if (o.plateTop != null) brand.plate.top = o.plateTop;
if (o.plateWidth != null) brand.plate.width = o.plateWidth;
const canvas = o.size ? parseSize(o.size) : { width: brand.canvas.width, height: brand.canvas.height };
const P = brand.plate;
if (brand.font.file && !fs.existsSync(brand.font.file)) fail(`font file not found: ${brand.font.file}`);

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s) => String(s || '')
  .replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/\s+/g, ' ').trim();

// Render one line of text with Pango. Returns { buf, width, height }.
async function textImage(line, px, color) {
  const fontDesc = `${brand.font.family} ${brand.font.weight || 'bold'} ${Math.max(1, Math.round(px))}`;
  const markup = `<span foreground="${color}">${xml(line)}</span>`;
  const img = sharp({ text: { text: markup, font: fontDesc, fontfile: brand.font.file || undefined, rgba: true, dpi: 72 } });
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  return { buf: data, width: info.width, height: info.height };
}
const widthAt = async (line, px) => (await textImage(line, px, '#000000')).width;

async function chooseLines(text, innerW) {
  const words = text.split(' ');
  const REF = 80;
  const one = [text];
  if (o.lines === '1' || words.length < 3) return one;
  let best = one, bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const cand = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(await widthAt(cand[0], REF), await widthAt(cand[1], REF));
    if (w < bestW) { bestW = w; best = cand; }
  }
  if (o.lines === '2') return best;
  // auto: keep a single line if it can still be set reasonably large
  const singlePx = REF * (innerW * P.targetFill) / (await widthAt(text, REF));
  return singlePx >= P.fontMax * 0.8 ? one : best;
}

async function buildPlate(rawText, outPng) {
  const text = clean(rawText);
  if (!text) throw new Error('hook text is empty after cleaning');
  const pw = Math.min(P.width, canvas.width);
  const innerW = pw - P.padX * 2;
  const lines = (await chooseLines(text, innerW)).slice(0, Math.min(2, P.maxLines || 2));
  const REF = 80;
  let widest = 1;
  for (const ln of lines) widest = Math.max(widest, await widthAt(ln, REF));
  let px = Math.round(REF * (innerW * P.targetFill) / widest);
  px = Math.max(P.fontMin, Math.min(P.fontMax, px));
  // never overflow horizontally even at fontMin
  while (px > 8 && (await widthAt(lines.reduce((a, b) => (a.length > b.length ? a : b)), px)) > innerW) px -= 2;

  let ph;
  let plateBase;
  const lh = Math.round(px * P.lineHeight);
  if (P.image) {
    const meta = await sharp(P.image).metadata();
    ph = Math.round(pw * meta.height / meta.width);
    const maxByH = Math.floor((ph - P.padY) / (lines.length * P.lineHeight));
    if (px > maxByH) px = maxByH;
    plateBase = await sharp(P.image).resize(pw, ph).png().toBuffer();
  } else {
    ph = lines.length * lh + P.padY * 2;
    const op = brand.colors.plateOpacity ?? 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">
      <rect x="0" y="0" width="${pw}" height="${ph}" rx="${P.radius}" ry="${P.radius}" fill="${brand.colors.plate}" fill-opacity="${op}"/></svg>`;
    plateBase = await sharp(Buffer.from(svg)).png().toBuffer();
  }
  const lineH = Math.round(px * P.lineHeight);
  const blockH = lines.length * lineH;
  const top0 = Math.round((ph - blockH) / 2);
  const comps = [];
  for (let i = 0; i < lines.length; i++) {
    const t = await textImage(lines[i], px, brand.colors.text);
    comps.push({
      input: t.buf,
      left: Math.max(0, Math.round((pw - t.width) / 2)),
      top: Math.max(0, Math.round(top0 + i * lineH + (lineH - t.height) / 2)),
    });
  }
  await sharp(plateBase).composite(comps).png().toFile(outPng);
  return { width: pw, height: ph, fontSize: px, lines, font: brand.font.file || brand.font.family };
}

async function renderOne(input, text, out) {
  const info = probe(input);
  if (!info.video) throw new Error(`no video stream in ${input}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  try {
    const png = path.join(tmp, 'plate.png');
    const plate = await buildPlate(text, png);
    const x = Math.round((canvas.width - plate.width) / 2);
    const y = Math.round(P.top);
    const { width: W, height: H } = canvas;
    const base = o.fit === 'contain'
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    const endT = o.end ?? null;
    const enable = (o.start > 0 || endT != null)
      ? `:enable='between(t,${o.start},${endT ?? 1e9})'` : '';
    const plateChain = o.fade > 0
      ? `[1:v]format=rgba,fade=t=in:st=${o.start}:d=${o.fade}:alpha=1[pl]`
      : `[1:v]format=rgba[pl]`;
    const chain = `[0:v]${base},setsar=1[bg];${plateChain};[bg][pl]overlay=${x}:${y}:shortest=1${enable},format=yuv420p[v]`;
    ensureDir(path.dirname(path.resolve(out)));
    ffmpeg(['-loglevel', 'error', '-i', input, '-loop', '1', '-framerate', String(brand.canvas.fps || 30), '-i', png,
      '-filter_complex', chain, '-map', '[v]', '-map', '0:a?',
      '-r', String(brand.canvas.fps || 30), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(info.duration), out]);
    return { input, out: path.resolve(out), plate: { ...plate, x, y } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const results = [];
const errors = [];
try {
  if (o.plateOnly) {
    if (!o.text) fail('--plate-only needs --text');
    ensureDir(path.dirname(path.resolve(o.plateOnly)));
    const plate = await buildPlate(o.text, o.plateOnly);
    results.push({ out: path.resolve(o.plateOnly), plate });
  } else if (o.jobs) {
    const jobs = JSON.parse(fs.readFileSync(o.jobs, 'utf8'));
    for (const [i, j] of jobs.entries()) {
      try { results.push(await renderOne(j.input, j.text, j.out || defaultOut(j.input, '-hook', '.mp4'))); log(`[${i + 1}/${jobs.length}] ok ${j.out}`); }
      catch (e) { errors.push({ job: i, error: e.message }); log(`[${i + 1}/${jobs.length}] FAIL ${e.message}`); }
    }
  } else if (o.inputDir) {
    if (!o.texts) fail('rotation mode needs --texts <file, one hook per line>');
    const hooks = fs.readFileSync(o.texts, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (!hooks.length) fail('no hooks in --texts');
    const clips = fs.readdirSync(o.inputDir).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f)).sort();
    const outDir = o.outDir || path.join(o.inputDir, 'hooked');
    for (const [i, f] of clips.entries()) {
      const text = hooks[i % hooks.length];
      try { results.push(await renderOne(path.join(o.inputDir, f), text, path.join(outDir, f.replace(/\.[^.]+$/, '.mp4')))); log(`[${i + 1}/${clips.length}] ${f} <- "${text}"`); }
      catch (e) { errors.push({ clip: f, error: e.message }); }
    }
  } else {
    if (!o.input || !o.text) fail('need --input and --text (or --plate-only / --jobs / --input-dir; see --help)');
    results.push(await renderOne(o.input, o.text, o.out || defaultOut(o.input, '-hook', '.mp4')));
  }
} catch (e) { fail(e.message, { results }); }

emit({ ok: errors.length === 0, brand: brand.name, canvas, results: results.map((r) => ({ ...r, plate: r.plate && { ...r.plate, fontSize: round(r.plate.fontSize, 1) } })), errors });
process.exit(errors.length ? 1 : 0);
