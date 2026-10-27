#!/usr/bin/env bash
# End-to-end smoke test on a synthetic clip (no network, no API keys).
# Runs: auto-cut -> hook-overlay -> captions (make + burn from a fixture
# word list; transcription itself needs a downloaded model) -> audio-polish
# -> loops-gifs-stickers -> render-qc -> youtube-publish (dry run only).
#   bash test/smoke.sh            # outputs go to outputs/smoke (gitignored)
#   bash test/smoke.sh --demo     # also refresh docs/demo.png
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/outputs/smoke"
S="$ROOT/skills"
rm -rf "$OUT" && mkdir -p "$OUT"
pass=0; fail=0

# run a script, require exit 0 and "ok": true in its JSON
step() {
  local name="$1"; shift
  local log="$OUT/$name.json"
  if "$@" >"$log" 2>"$OUT/$name.err" && node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(j.ok===true?0:1)" "$log"; then
    echo "PASS  $name"; pass=$((pass+1))
  else
    echo "FAIL  $name  (see $log / $OUT/$name.err)"; fail=$((fail+1))
  fi
}
# expect a non-zero exit (gates that must refuse)
expect_fail() {
  local name="$1"; shift
  if "$@" >"$OUT/$name.json" 2>/dev/null; then echo "FAIL  $name (should have refused)"; fail=$((fail+1)); else echo "PASS  $name (refused as expected)"; pass=$((pass+1)); fi
}

if node "$ROOT/test/check-lib-sync.mjs" >/dev/null; then echo "PASS  lib-sync"; pass=$((pass+1)); else echo "FAIL  lib-sync"; fail=$((fail+1)); fi
bash "$ROOT/test/make-fixture.sh" "$OUT/raw.mp4" >/dev/null

# --help --json contract for every node script
for f in "$S"/*/scripts/*.mjs; do
  [[ "$(basename "$f")" == _lib.mjs ]] && continue
  node "$f" --help --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.name||!j.inputs)process.exit(1)})" || { echo "FAIL  contract $(basename "$f")"; fail=$((fail+1)); }
done
if python3 "$S/captions/scripts/transcribe.py" --help --json >/dev/null; then echo "PASS  contracts (--help --json)"; pass=$((pass+1)); else echo "FAIL  transcribe.py contract"; fail=$((fail+1)); fi

# 1. auto-cut
expect_fail qc-raw-opens-black   node "$S/render-qc/scripts/verify-render.mjs" --input "$OUT/raw.mp4" --profile shorts
step suggest-cuts   node "$S/auto-cut/scripts/suggest-cuts.mjs" --input "$OUT/raw.mp4" --min-clip 1 --out "$OUT/cuts.json"
step split          node "$S/auto-cut/scripts/split.mjs" --markers "$OUT/cuts.json" --out-dir "$OUT/clips"
step trim-lead      node "$S/auto-cut/scripts/trim-lead.mjs" --input "$OUT/raw.mp4" --out "$OUT/trimmed.mp4"

# 2. hook-overlay
step plate-only     node "$S/hook-overlay/scripts/render-hook.mjs" --text "POV: your edits run themselves" --plate-only "$OUT/plate.png"
step hook-overlay   node "$S/hook-overlay/scripts/render-hook.mjs" --input "$OUT/trimmed.mp4" --text "POV: your edits run themselves" --fade 0.2 --out "$OUT/hooked.mp4"

# 3. captions (fixture words; real transcription needs a whisper model download)
step make-captions  node "$S/captions/scripts/make-captions.mjs" --words "$ROOT/test/fixtures/words.sample.json" --out-ass "$OUT/caps.ass" --out-srt "$OUT/caps.srt"
step burn-captions  node "$S/captions/scripts/burn.mjs" --input "$OUT/hooked.mp4" --subs "$OUT/caps.ass" --out "$OUT/captioned.mp4"
step snap-to-words  node "$S/captions/scripts/snap-to-words.mjs" --words "$ROOT/test/fixtures/words.sample.json" --cuts 1.2,3.5

# 4. audio-polish
step trim-silence   node "$S/audio-polish/scripts/trim-silence.mjs" --input "$OUT/raw.mp4" --all --out "$OUT/tight.mp4"
step join           node "$S/audio-polish/scripts/join.mjs" --inputs "$OUT/clips/clip-02.mp4,$OUT/clips/clip-03.mp4" --out "$OUT/joined.mp4"
step crossfade      node "$S/audio-polish/scripts/join.mjs" --inputs "$OUT/clips/clip-02.mp4,$OUT/clips/clip-04.mp4" --crossfade 0.4 --out "$OUT/xfade.mp4"
mkdir -p "$OUT/final"
step loudnorm       node "$S/audio-polish/scripts/loudnorm.mjs" --input "$OUT/captioned.mp4" --out "$OUT/final/short.mp4"

# 5. loops-gifs-stickers
step loop-xfade     node "$S/loops-gifs-stickers/scripts/loop.mjs" --input "$OUT/trimmed.mp4" --out "$OUT/loop.mp4"
step loop-pingpong  node "$S/loops-gifs-stickers/scripts/loop.mjs" --input "$OUT/trimmed.mp4" --mode pingpong --duration 2 --out "$OUT/pingpong.mp4"
step gif            node "$S/loops-gifs-stickers/scripts/gif.mjs" --input "$OUT/trimmed.mp4" --duration 2 --caption "when the render passes QC" --out "$OUT/meme.gif"
step sticker-webp   node "$S/loops-gifs-stickers/scripts/sticker.mjs" --input "$OUT/trimmed.mp4" --format webp --out "$OUT/sticker.webp"
step sticker-webm   node "$S/loops-gifs-stickers/scripts/sticker.mjs" --input "$OUT/trimmed.mp4" --format webm --out "$OUT/sticker.webm"

# 6. render-qc
expect_fail approve-without-proof node "$S/render-qc/scripts/approve.mjs" --staging "$OUT/final" --proof "$OUT/final/proof.png"
step verify-render  node "$S/render-qc/scripts/verify-render.mjs" --input "$OUT/final/short.mp4" --profile shorts --write-report
step proof-sheet    node "$S/render-qc/scripts/proof-sheet.mjs" --inputs "$OUT/final/short.mp4" --frames 6 --out "$OUT/final/proof.png"
step proof-firstlast node "$S/render-qc/scripts/proof-sheet.mjs" --input-dir "$OUT/clips" --mode firstlast --out "$OUT/clips-proof.png"
step approve-status node "$S/render-qc/scripts/approve.mjs" --staging "$OUT/final" --proof "$OUT/final/proof.png"
step approve        node "$S/render-qc/scripts/approve.mjs" --staging "$OUT/final" --proof "$OUT/final/proof.png" --dest "$OUT/publish" --approved --by smoke-test

# 7. youtube-publish (dry run only: no network, no credentials)
cat > "$OUT/publish/jobs.json" <<JSON
[{ "file": "short.mp4", "title": "Agent-edited short: auto-cut to captions", "tags": ["shorts", "automation"] }]
JSON
step upload-dry-run node "$S/youtube-publish/scripts/upload.mjs" --jobs "$OUT/publish/jobs.json" --dry-run --ledger "$OUT/publish/ledger.json"
expect_fail upload-public-refused node "$S/youtube-publish/scripts/upload.mjs" --file "$OUT/publish/short.mp4" --title "x short" --privacy public --dry-run --ledger "$OUT/publish/ledger.json"

if [[ "${1:-}" == "--demo" ]]; then
  mkdir -p "$ROOT/docs"
  ffmpeg -hide_banner -loglevel error -y -ss 3.3 -i "$OUT/final/short.mp4" -frames:v 1 -vf scale=540:-2 "$ROOT/docs/demo.png"
  echo "wrote docs/demo.png"
fi

echo "---"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
