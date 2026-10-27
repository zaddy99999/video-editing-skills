#!/usr/bin/env node
// auth.mjs: one-time YouTube OAuth (installed-app loopback flow with PKCE).
//
// Reads the OAuth client from env (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET)
// or from the client JSON you download from Google Cloud Console
// (--client-secrets). Opens the consent page, catches the redirect on
// 127.0.0.1, exchanges the code and writes the refresh token to --token-file
// with 0600 permissions. The token is NEVER printed. Keep that file out of git
// (the repo .gitignore already ignores *token*.json and .env*).
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, emit, fail, log } from './_lib.mjs';

const spec = {
  name: 'auth',
  summary: 'Authorize a YouTube channel once and store a refresh token locally (never printed).',
  usage: [
    'YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... node auth.mjs --token-file .youtube-token.json',
    'node auth.mjs --client-secrets client_secret.json --token-file .youtube-token.json',
  ],
  options: {
    clientSecrets: { desc: 'OAuth client JSON downloaded from Google Cloud Console (Desktop app type)' },
    tokenFile: { default: '.youtube-token.json', desc: 'Where to store the refresh token (chmod 600, gitignored)' },
    port: { type: 'number', default: 8765, desc: 'Loopback port for the redirect' },
    scopes: { type: 'list', default: ['https://www.googleapis.com/auth/youtube.upload'], desc: 'OAuth scopes (add .../auth/youtube for playlists)' },
    noOpen: { type: 'boolean', desc: 'Do not try to open a browser; just print the URL' },
    timeout: { type: 'number', default: 300, desc: 'Seconds to wait for consent' },
  },
  outputs: ['token file { refresh_token, client_id, scope, created_at } (mode 600)'],
  verify: 'node upload.mjs --check-auth --token-file <file> exchanges the token without uploading.',
};

const o = parseArgs(spec);
let clientId = process.env.YOUTUBE_CLIENT_ID;
let clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (o.clientSecrets) {
  const j = JSON.parse(fs.readFileSync(o.clientSecrets, 'utf8'));
  const c = j.installed || j.web || j;
  clientId = c.client_id; clientSecret = c.client_secret;
}
if (!clientId || !clientSecret) {
  fail('missing OAuth client. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET, or pass --client-secrets client_secret.json', {
    howTo: 'Google Cloud Console > APIs & Services > enable "YouTube Data API v3" > Credentials > Create OAuth client ID > Desktop app.',
  });
}

const redirect = `http://127.0.0.1:${o.port}/oauth2callback`;
const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: o.scopes.join(' '),
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
  if (u.searchParams.get('state') !== state) { res.writeHead(400).end('State mismatch'); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.writeHead(400).end(`No code: ${u.searchParams.get('error') || 'unknown error'}`); finish(1, 'consent denied or failed'); return; }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const tok = await r.json();
    if (!r.ok) throw new Error(`token exchange failed: ${tok.error || r.status} ${tok.error_description || ''}`);
    if (!tok.refresh_token) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('No refresh token returned. Revoke the app at myaccount.google.com/permissions and run again.');
      finish(1, 'no refresh_token returned (revoke prior grant and retry)');
      return;
    }
    const file = path.resolve(o.tokenFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ refresh_token: tok.refresh_token, client_id: clientId, scope: tok.scope, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('YouTube connected. You can close this tab.');
    finish(0, null, file, tok.scope);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Token exchange failed. See terminal.');
    finish(1, e.message);
  }
});

let done = false;
function finish(code, error, file, scope) {
  if (done) return; done = true;
  server.close();
  if (code === 0) emit({ ok: true, tokenFile: file, scope, note: 'refresh token stored (not printed). Keep this file out of git.' });
  else emit({ ok: false, error });
  setTimeout(() => process.exit(code), 50);
}

server.listen(o.port, '127.0.0.1', () => {
  log(`Redirect URI (Desktop clients accept any loopback port): ${redirect}`);
  log('Open this URL, pick the channel to upload to, and approve:\n');
  log(url + '\n');
  if (!o.noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
setTimeout(() => finish(1, `timed out after ${o.timeout}s waiting for consent`), o.timeout * 1000).unref();
