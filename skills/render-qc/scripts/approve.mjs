#!/usr/bin/env node
// approve.mjs: explicit human approval gate between "rendered" and "live".
//
// Nothing leaves the staging folder unless:
//   1. a proof sheet exists and is NEWER than every staged media file
//      (a proof of an older render proves nothing),
//   2. every staged media file has a passing <file>.qc.json from verify-render,
//   3. the operator passes --approved after looking at the proof.
// Promotion is atomic (copy to a temp dir, then rename), refuses to overwrite
// unless --replace, and writes APPROVED.json with a sha256 per file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, emit, fail, ensureDir } from './_lib.mjs';

const spec = {
  name: 'approve',
  summary: 'Promote staged renders only after proof sheet + QC pass + explicit --approved.',
  usage: [
    'node approve.mjs --staging edit/final --proof edit/final/proof.png              # status / dry run',
    'node approve.mjs --staging edit/final --proof edit/final/proof.png --dest publish/ --approved',
  ],
  options: {
    staging: { required: true, desc: 'Folder with rendered files' },
    proof: { required: true, desc: 'Proof sheet PNG made from the CURRENT renders (proof-sheet.mjs)' },
    dest: { desc: 'Where approved files go (required with --approved)' },
    approved: { type: 'boolean', desc: 'I looked at the proof sheet and approve these renders' },
    by: { desc: 'Approver name/handle recorded in APPROVED.json' },
    replace: { type: 'boolean', desc: 'Allow overwriting files that already exist in --dest' },
    skipQc: { type: 'boolean', desc: 'Do not require .qc.json reports (recorded in APPROVED.json)' },
  },
  outputs: ['Files copied to --dest', '<dest>/APPROVED.json { files[{ name, sha256 }], proof, approvedAt }'],
  verify: 'Exit 0 and APPROVED.json lists every file. Exit 2 means the gate refused (read "problems").',
  exitCodes: { 0: 'promoted (or status ok)', 1: 'error', 2: 'gate refused' },
};

const o = parseArgs(spec);
const staging = path.resolve(o.staging);
if (!fs.existsSync(staging)) fail(`staging not found: ${staging}`);
const media = fs.readdirSync(staging).filter((f) => /\.(mp4|mov|webm|gif|webp|png|jpg)$/i.test(f) && path.resolve(staging, f) !== path.resolve(o.proof)).sort();
const problems = [];
if (!media.length) problems.push('no media files in staging');
if (!fs.existsSync(o.proof)) problems.push(`proof sheet missing: ${o.proof}`);
else {
  const proofT = fs.statSync(o.proof).mtimeMs;
  const newer = media.filter((f) => /\.(mp4|mov|webm|gif|webp)$/i.test(f) && fs.statSync(path.join(staging, f)).mtimeMs > proofT);
  if (newer.length) problems.push(`proof sheet is older than: ${newer.join(', ')} (re-run proof-sheet.mjs)`);
}
const videos = media.filter((f) => /\.(mp4|mov|webm)$/i.test(f));
const qc = {};
if (!o.skipQc) {
  for (const f of videos) {
    const rp = path.join(staging, `${f}.qc.json`);
    if (!fs.existsSync(rp)) { problems.push(`no QC report for ${f} (verify-render.mjs --write-report)`); continue; }
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    qc[f] = r.ok;
    if (!r.ok) problems.push(`QC failed for ${f}: ${(r.errors || []).join(', ')}`);
    else if (fs.statSync(path.join(staging, f)).mtimeMs > fs.statSync(rp).mtimeMs) problems.push(`QC report for ${f} is older than the file (re-run verify-render)`);
  }
}

const status = { staging, files: media, qc, problems };
if (problems.length) { emit({ ok: false, refused: true, ...status }); process.exit(2); }
if (!o.approved) {
  emit({ ok: true, ready: true, ...status, next: 'Review the proof sheet yourself (or show it to the user), then re-run with --approved --dest <folder>.' });
  process.exit(0);
}
if (!o.dest) fail('--approved needs --dest');

const dest = ensureDir(path.resolve(o.dest));
const existing = media.filter((f) => fs.existsSync(path.join(dest, f)));
if (existing.length && !o.replace) { emit({ ok: false, refused: true, problems: [`already in dest (pass --replace): ${existing.join(', ')}`] }); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(dest, '.approve-'));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files = [];
try {
  for (const f of media) { fs.copyFileSync(path.join(staging, f), path.join(tmp, f)); files.push({ name: f, sha256: sha(path.join(tmp, f)) }); }
  for (const f of media) fs.renameSync(path.join(tmp, f), path.join(dest, f));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const record = { approvedAt: new Date().toISOString(), by: o.by || null, staging, proof: path.resolve(o.proof), qcSkipped: !!o.skipQc, files };
fs.writeFileSync(path.join(dest, 'APPROVED.json'), JSON.stringify(record, null, 2) + '\n');
emit({ ok: true, promoted: files.length, dest, record: path.join(dest, 'APPROVED.json') });
