#!/usr/bin/env bash
# Generates a tiny synthetic 9:16 test clip (no copyrighted media):
#   0.0-1.0s  black frames + silence      (dead lead-in for trim-lead / trim-silence)
#   1.0-3.5s  testsrc2 + 440 Hz tone
#   3.5-6.0s  smptebars + 660 Hz tone     (a hard scene change for suggest-cuts)
#   with a 0.8s silent gap at 4.2-5.0s    (a pause for silence detection)
# Usage: bash test/make-fixture.sh [out.mp4]
set -euo pipefail
OUT="${1:-outputs/fixture.mp4}"
mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1080x1920:r=30:d=1" \
  -f lavfi -i "testsrc2=s=1080x1920:r=30:d=2.5" \
  -f lavfi -i "smptebars=s=1080x1920:r=30:d=2.5" \
  -f lavfi -i "anullsrc=r=48000:cl=stereo:d=1" \
  -f lavfi -i "sine=f=440:r=48000:d=2.5" \
  -f lavfi -i "sine=f=660:r=48000:d=2.5" \
  -filter_complex "\
[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v];\
[4:a]aformat=channel_layouts=stereo,volume=0.5[a1];\
[5:a]aformat=channel_layouts=stereo,volume='if(between(t,0.7,1.5),0,0.5)':eval=frame[a2];\
[3:a][a1][a2]concat=n=3:v=0:a=1[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k \
  -movflags +faststart "$OUT"
echo "$OUT"
