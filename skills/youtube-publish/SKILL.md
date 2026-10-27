---
name: youtube-publish
description: Upload finished videos or Shorts to YouTube safely from the terminal. Use when the user wants to authorize a YouTube channel, upload one or many videos with titles, descriptions and tags, schedule a publish time, or make sure a batch never double-posts. Defaults to private uploads and keeps an upload ledger.
---

# youtube-publish

YouTube Data API v3 uploader with no SDK dependency (plain `fetch`, resumable
chunked upload). Built for batches: private by default, a sha256 ledger so a
re-run never double-posts, metadata lint, dry-run and quota awareness.

## One-time setup (the user does this, not the agent)

1. Google Cloud Console: create a project, enable **YouTube Data API v3**,
   create an **OAuth client ID** of type **Desktop app**.
2. Provide the client to the scripts without committing it:
   `export YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=...` (or keep the
   downloaded JSON outside the repo and pass `--client-secrets`).
3. Authorize the channel once:
   ```bash
   node scripts/auth.mjs --token-file .youtube-token.json
   ```
   Opens the consent page, catches the redirect on 127.0.0.1 (PKCE + state
   check), stores the refresh token with mode 600. The token is never printed.

## Workflow

```bash
# 1. dry run: validates metadata, hashes files, shows skip/upload plan and quota cost
node scripts/upload.mjs --jobs jobs.json --dry-run

# 2. upload (private by default)
node scripts/upload.mjs --jobs jobs.json --token-file .youtube-token.json

# single file
node scripts/upload.mjs --file publish/short.mp4 --title "How I automated my edits" --tags shorts,automation --privacy unlisted
```

`jobs.json`:
```json
[
  { "file": "publish/short-01.mp4", "title": "...", "description": "...", "tags": ["shorts"], "privacy": "private" },
  { "file": "publish/short-02.mp4", "title": "...", "privacy": "private", "publishAt": "2026-11-01T17:00:00Z" }
]
```
Relative `file` paths resolve against the jobs file's folder.

## Rules

- Only upload files that passed `render-qc` and were approved by the user.
- Default privacy is `private`. `public` is refused unless the user explicitly asked and you pass `--allow-public`. Scheduled videos (`publishAt`) must be `private`; YouTube flips them public at that time.
- Always `--dry-run` first and show the plan to the user.
- Never print, log or commit tokens, client secrets, `.env*` files or the ledger. The repo `.gitignore` covers `*token*.json`, `*credentials*.json`, `*client_secret*.json`, `.env*` and `*ledger*.json`.
- The ledger (`.youtube-upload-ledger.json`) is the source of truth for what was posted. It is saved after every single upload. Do not delete it to "retry"; use `--force-duplicate` only if the user really wants a second copy.
- Quota: a project gets 10,000 units/day by default and one upload has historically cost 1,600 units (about 6 uploads/day). `--max-uploads` (default 6) stops a run before it burns the quota; `--units-per-upload` adjusts the estimate if Google changes the cost. On `quotaExceeded` the run stops and the remaining jobs can be re-run tomorrow (the ledger skips the done ones).
- Titles: no placeholders (TODO, untitled, `{{...}}`), max 100 characters, no `<` or `>`. Tags total max 500 characters. The lint enforces this.
- Unverified API projects may force uploads to private until Google audits the app; tell the user if every upload comes back private.

## Verify

Every result has a `videoId` (open `https://youtu.be/<id>` while it is still
private) or a `skipped` reason. `node scripts/upload.mjs --check-auth` tests
credentials without uploading.
