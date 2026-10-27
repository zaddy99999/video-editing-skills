#!/usr/bin/env python3
"""transcribe.py: word-level transcript with faster-whisper (local, no API key).

Writes words.json: {ok, model, language, duration, words:[{word,start,end,prob}], segments:[...]}
which make-captions.mjs and snap-to-words.mjs read.

Degrades gracefully: if faster-whisper is not installed (exit 3) or the model
cannot be loaded / downloaded (exit 4, e.g. Hugging Face blocked on your
network), it prints a JSON error with the fix instead of a traceback, and
never writes a fake transcript.
"""
import argparse
import json
import os
import sys

CONTRACT = {
    "name": "transcribe",
    "summary": "Word-level transcript (faster-whisper) for captions and word-safe cuts.",
    "usage": ["python3 transcribe.py --input clip.mp4 --out words.json [--model small] [--language en]"],
    "inputs": {
        "--input": {"type": "string", "required": True, "description": "Audio or video file"},
        "--out": {"type": "string", "required": False, "description": "Output JSON (default: edit/<name>.words.json beside input)"},
        "--model": {"type": "string", "default": "small", "description": "tiny|base|small|medium|large-v3 (.en variants for English) or a local CTranslate2 model dir"},
        "--language": {"type": "string", "default": None, "description": "Language code, e.g. en (default: auto-detect)"},
        "--device": {"type": "string", "default": "auto", "description": "auto|cpu|cuda"},
        "--compute-type": {"type": "string", "default": "int8", "description": "int8 (CPU) | float16 (GPU) | ..."},
        "--beam-size": {"type": "number", "default": 5, "description": "Beam size"},
        "--vad": {"type": "boolean", "default": True, "description": "Silero VAD filter to skip silence (--no-vad to disable)"},
        "--force": {"type": "boolean", "default": False, "description": "Re-transcribe even if --out exists (transcripts are cached)"},
    },
    "outputs": ["words.json {ok, model, language, duration, words[{word,start,end,prob}], segments[{start,end,text}]}"],
    "verify": "Spot-check a few word timestamps against the audio; words must be non-overlapping and increasing.",
    "exitCodes": {"0": "ok", "1": "error", "3": "faster-whisper not installed", "4": "model could not be loaded (offline / blocked download)"},
}


def emit(obj, code=0):
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def main():
    if "--help" in sys.argv and "--json" in sys.argv:
        emit(CONTRACT)
    p = argparse.ArgumentParser(description=CONTRACT["summary"])
    p.add_argument("--input", required=True)
    p.add_argument("--out")
    p.add_argument("--model", default="small")
    p.add_argument("--language", default=None)
    p.add_argument("--device", default="auto")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--vad", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--force", action="store_true")
    a = p.parse_args()

    if not os.path.exists(a.input):
        emit({"ok": False, "error": f"input not found: {a.input}"}, 1)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.input)), "edit",
                                os.path.splitext(os.path.basename(a.input))[0] + ".words.json")
    if os.path.exists(out) and not a.force:
        emit({"ok": True, "cached": True, "out": os.path.abspath(out)})

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"ok": False, "error": "faster-whisper is not installed",
              "fix": "pip install faster-whisper   (or: pip install -r requirements.txt)"}, 3)

    try:
        model = WhisperModel(a.model, device=a.device, compute_type=a.compute_type)
    except Exception as e:  # network blocked, bad model name, missing CUDA, ...
        emit({"ok": False, "error": f"could not load whisper model '{a.model}': {type(e).__name__}: {str(e)[:300]}",
              "fix": [
                  "The first run downloads the model from Hugging Face; make sure huggingface.co is reachable,",
                  "or download a CTranslate2 model elsewhere (e.g. Systran/faster-whisper-small) and pass --model /path/to/dir,",
                  "or use --device cpu --compute-type int8 if CUDA is the problem.",
              ]}, 4)

    try:
        segments, info = model.transcribe(a.input, language=a.language, beam_size=a.beam_size,
                                          word_timestamps=True, vad_filter=a.vad)
        words, segs = [], []
        for s in segments:
            segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()})
            for w in (s.words or []):
                txt = w.word.strip()
                if not txt:
                    continue
                words.append({"word": txt, "start": round(w.start, 3), "end": round(w.end, 3),
                              "prob": round(getattr(w, "probability", 0.0), 3)})
    except Exception as e:
        emit({"ok": False, "error": f"transcription failed: {type(e).__name__}: {str(e)[:300]}"}, 1)

    # enforce monotonic, non-overlapping word times (whisper occasionally overlaps by a few ms)
    for i in range(1, len(words)):
        if words[i]["start"] < words[i - 1]["end"]:
            words[i]["start"] = words[i - 1]["end"]
        if words[i]["end"] < words[i]["start"]:
            words[i]["end"] = words[i]["start"]

    result = {"ok": True, "source": os.path.abspath(a.input), "model": a.model, "language": info.language,
              "duration": round(info.duration, 3), "words": words, "segments": segs}
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    emit({"ok": True, "out": os.path.abspath(out), "language": info.language, "words": len(words),
          "duration": round(info.duration, 3)})


if __name__ == "__main__":
    main()
