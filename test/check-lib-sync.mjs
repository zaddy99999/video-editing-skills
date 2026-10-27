#!/usr/bin/env node
// Verifies every skills/*/scripts/_lib.mjs is identical to shared/_lib.mjs.
//   node test/check-lib-sync.mjs           # check (exit 1 on drift)
//   node test/check-lib-sync.mjs --write   # copy shared/_lib.mjs into every skill
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = fs.readFileSync(path.join(root, 'shared', '_lib.mjs'), 'utf8');
const write = process.argv.includes('--write');
let drift = 0;
for (const skill of fs.readdirSync(path.join(root, 'skills'))) {
  const dir = path.join(root, 'skills', skill, 'scripts');
  if (!fs.existsSync(dir)) continue;
  if (!fs.readdirSync(dir).some((f) => f.endsWith('.mjs') && f !== '_lib.mjs')) continue;
  const file = path.join(dir, '_lib.mjs');
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === canonical;
  if (!same && write) { fs.writeFileSync(file, canonical); console.log(`synced ${path.relative(root, file)}`); }
  else if (!same) { drift++; console.log(`DRIFT ${path.relative(root, file)}`); }
}
if (drift) process.exit(1);
console.log(write ? 'lib copies synced' : 'lib copies in sync');
