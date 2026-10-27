#!/usr/bin/env node
// upload.mjs: idempotent YouTube uploader (Data API v3, resumable, no SDK).
//
// Safety model:
//   * default privacy is PRIVATE; "public" needs --allow-public.
//   * an upload ledger (sha256 of each file) means a re-run never double-posts;
//     the ledger is saved after EVERY upload so a crash mid-batch still counts.
//   * --dry-run validates everything and prints the plan + quota cost without
//     touching the network.
//   * metadata is linted (empty/placeholder titles, length limits).
//   * tokens are read from env or a token file and are never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, emit, fail, log, round } from './_lib.mjs';

const CHUNK = 8 * 1024 * 1024;
const PRIVACY = ['private', 'unlisted', 'public'];

const spec = {
  name: 'upload',
  summary: 'Upload videos to YouTube with private-by-default, a dedupe ledger, metadata lint and dry-run.',
  usage: [
    'node upload.mjs --jobs jobs.json --dry-run',
    'node upload.mjs --jobs jobs.json --token-file .youtube-token.json',
    'node upload.mjs --file final.mp4 --title "My short" --tags shorts,automation --privacy unlisted',
    'node upload.mjs --check-auth',
  ],
  options: {
    jobs: { desc: 'JSON array of { file, title, description, tags[], privacy, categoryId, publishAt, madeForKids }' },
    file: { desc: 'Single video file (instead of --jobs)' },
    title: { desc: 'Title for --file' },
    description: { default: '', desc: 'Description for --file' },
    tags: { type: 'list', desc: 'Tags for --file' },
    privacy: { default: 'private', desc: 'private | unlisted | public (public needs --allow-public)' },
    categoryId: { default: '22', desc: 'YouTube category id (22 People & Blogs, 24 Entertainment, 28 Science & Tech)' },
    publishAt: { desc: 'ISO time to auto-publish (YouTube requires privacy=private for scheduled videos)' },
    allowPublic: { type: 'boolean', desc: 'Permit privacy=public' },
    ledger: { default: '.youtube-upload-ledger.json', desc: 'Upload ledger path (gitignored); prevents double posts' },
    tokenFile: { default: '.youtube-token.json', desc: 'Token file from auth.mjs (or set YOUTUBE_REFRESH_TOKEN)' },
    maxUploads: { type: 'number', default: 6, desc: 'Stop after this many uploads per run (6 x 1600 units fits a default 10k/day quota)' },
    forceDuplicate: { type: 'boolean', desc: 'Upload even if the ledger says this file was already posted' },
    results: { desc: 'Also write per-job results JSON here' },
    dryRun: { type: 'boolean', desc: 'Validate + plan only. No network.' },
    checkAuth: { type: 'boolean', desc: 'Only verify the refresh token can mint an access token' },
    unitsPerUpload: { type: 'number', default: 1600, desc: 'Quota units one videos.insert costs (check the current value in Google\'s quota docs)' },
  },
  outputs: ['Videos on YouTube', 'ledger JSON updated after each upload', 'JSON: { results[{ file, videoId, url, skipped, error }], quota }'],
  verify: 'Each result has a videoId or a skip reason; open the URL while it is still private/unlisted before making it public.',
  exitCodes: { 0: 'all jobs uploaded or skipped', 1: 'validation or upload error' },
};

const o = parseArgs(spec);
const UNITS_PER_UPLOAD = o.unitsPerUpload; // default project quota is 10,000 units/day

// ---------- auth ----------
function creds() {
  let refresh = process.env.YOUTUBE_REFRESH_TOKEN;
  let clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!refresh && fs.existsSync(o.tokenFile)) {
    const t = JSON.parse(fs.readFileSync(o.tokenFile, 'utf8'));
    refresh = t.refresh_token; clientId = clientId || t.client_id;
  }
  if (!refresh || !clientId || !clientSecret) {
    fail('missing credentials: need YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in env and a refresh token (run auth.mjs, or set YOUTUBE_REFRESH_TOKEN)');
  }
  return { refresh, clientId, clientSecret };
}
async function accessToken() {
  const c = creds();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token refresh failed: ${j.error || r.status} ${j.error_description || ''}`.trim());
  return j.access_token;
}

// ---------- jobs + lint ----------
let jobs;
if (o.jobs) jobs = JSON.parse(fs.readFileSync(o.jobs, 'utf8'));
else if (o.file) jobs = [{ file: o.file, title: o.title, description: o.description, tags: o.tags, privacy: o.privacy, categoryId: o.categoryId, publishAt: o.publishAt }];
else if (!o.checkAuth) fail('need --jobs or --file (see --help)');

if (o.checkAuth) {
  try { await accessToken(); emit({ ok: true, auth: 'refresh token works' }); process.exit(0); } catch (e) { fail(e.message); }
}

const baseDir = o.jobs ? path.dirname(path.resolve(o.jobs)) : process.cwd();
const PLACEHOLDER = /^(untitled|title|todo|tbd|test|new video|video\s*\d*)$|\{\{|\}\}|lorem ipsum|\bTODO\b|\bFIXME\b/i;
function lint(j, i) {
  const p = [];
  j.file = path.resolve(baseDir, j.file || '');
  if (!j.file || !fs.existsSync(j.file)) p.push(`file not found: ${j.file}`);
  const title = String(j.title || '').trim();
  if (!title) p.push('title is empty');
  if (title.length > 100) p.push(`title is ${title.length} chars (max 100)`);
  if (PLACEHOLDER.test(title)) p.push(`title looks like a placeholder: "${title}"`);
  if (/[<>]/.test(title)) p.push('title contains < or > (rejected by YouTube)');
  if (Buffer.byteLength(String(j.description || '')) > 5000) p.push('description over 5000 bytes');
  const tagChars = (j.tags || []).reduce((s, t) => s + String(t).length + (String(t).includes(' ') ? 2 : 0), 0) + Math.max(0, (j.tags || []).length - 1);
  if (tagChars > 500) p.push(`tags total ${tagChars} chars (max 500)`);
  j.privacy = j.privacy || o.privacy || 'private';
  if (!PRIVACY.includes(j.privacy)) p.push(`bad privacy "${j.privacy}"`);
  if (j.privacy === 'public' && !o.allowPublic) p.push('privacy=public needs --allow-public (default is private: review first)');
  if (j.publishAt && j.privacy !== 'private') p.push('publishAt requires privacy=private (YouTube publishes it at that time)');
  if (j.publishAt && Number.isNaN(Date.parse(j.publishAt))) p.push(`publishAt is not a date: ${j.publishAt}`);
  return p.map((m) => `job ${i}: ${m}`);
}
const problems = jobs.flatMap(lint);
if (problems.length) fail('validation failed; nothing uploaded', { problems });

// ---------- ledger ----------
const loadLedger = () => { try { return JSON.parse(fs.readFileSync(o.ledger, 'utf8')); } catch { return { items: [] }; } };
const saveLedger = (l) => {
  l.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(o.ledger)), { recursive: true });
  const tmp = `${o.ledger}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  fs.renameSync(tmp, o.ledger);
};
const sha256 = (file) => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const ledger = loadLedger();
const posted = new Map(ledger.items.map((x) => [x.sha256, x]));

const plan = [];
for (const j of jobs) {
  j.sha256 = await sha256(j.file);
  const prev = posted.get(j.sha256);
  plan.push({ file: j.file, title: j.title, privacy: j.privacy, sizeMB: round(fs.statSync(j.file).size / 1048576, 1),
    action: prev && !o.forceDuplicate ? `skip (already posted as ${prev.videoId})` : 'upload' });
}
const toUpload = plan.filter((p) => p.action === 'upload').length;
const quota = { perUpload: UNITS_PER_UPLOAD, thisRun: Math.min(toUpload, o.maxUploads) * UNITS_PER_UPLOAD, defaultDailyQuota: 10000 };
if (o.dryRun) { emit({ ok: true, dryRun: true, plan, quota, ledger: path.resolve(o.ledger) }); process.exit(0); }

// ---------- upload ----------
async function uploadOne(j, token) {
  const size = fs.statSync(j.file).size;
  const meta = {
    snippet: { title: j.title.trim(), description: j.description || '', tags: j.tags || [], categoryId: String(j.categoryId || o.categoryId) },
    status: { privacyStatus: j.privacy, selfDeclaredMadeForKids: !!j.madeForKids, embeddable: true, ...(j.publishAt ? { publishAt: new Date(j.publishAt).toISOString() } : {}) },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/*' },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`init failed ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const session = init.headers.get('location');
  const fd = fs.openSync(j.file, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const r = await fetch(session, { method: 'PUT', headers: { 'content-length': String(len), 'content-range': `bytes ${offset}-${offset + len - 1}/${size}` }, body: buf });
      if (r.status === 308) {
        const range = r.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : offset + len;
        process.stderr.write(`\r  ${path.basename(j.file)}: ${round((offset / size) * 100, 0)}%`);
        continue;
      }
      if (r.ok) { process.stderr.write('\n'); return await r.json(); }
      throw new Error(`upload failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    throw new Error('upload ended without a final response');
  } finally { fs.closeSync(fd); }
}

const results = [];
let token;
try { token = await accessToken(); } catch (e) { fail(e.message); }
let uploaded = 0;
for (const j of jobs) {
  const prev = posted.get(j.sha256);
  if (prev && !o.forceDuplicate) { results.push({ file: j.file, skipped: true, reason: `already posted as ${prev.videoId}` }); continue; }
  if (uploaded >= o.maxUploads) { results.push({ file: j.file, skipped: true, reason: `--max-uploads ${o.maxUploads} reached (quota)` }); continue; }
  log(`uploading "${j.title}" (${j.privacy})`);
  try {
    const v = await uploadOne(j, token);
    uploaded++;
    const item = { sha256: j.sha256, file: path.basename(j.file), videoId: v.id, title: j.title, privacy: v.status?.privacyStatus, uploadedAt: new Date().toISOString() };
    ledger.items.unshift(item);
    posted.set(j.sha256, item);
    saveLedger(ledger); // after EACH upload
    results.push({ file: j.file, videoId: v.id, url: `https://youtu.be/${v.id}`, privacy: v.status?.privacyStatus });
  } catch (e) {
    results.push({ file: j.file, error: e.message });
    if (/quotaExceeded|dailyLimitExceeded|uploadLimitExceeded/.test(e.message)) { log('quota exhausted; stopping'); break; }
  }
}
if (o.results) fs.writeFileSync(o.results, JSON.stringify(results, null, 2) + '\n');
const ok = results.every((r) => !r.error);
emit({ ok, uploaded, results, quota: { ...quota, used: uploaded * UNITS_PER_UPLOAD }, ledger: path.resolve(o.ledger) });
process.exit(ok ? 0 : 1);
