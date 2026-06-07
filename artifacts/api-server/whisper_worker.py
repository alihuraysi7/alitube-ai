#!/usr/bin/env python3
"""
whisper_worker.py — Transcribes audio to text using faster-whisper (tiny model, CPU, int8).

Usage:  python3 whisper_worker.py <audio_file_path>
Output: JSON on stdout — {"segments": [...], "language": "...", "language_probability": 0.99}
Errors: JSON on stdout — {"error": "..."}  +  exit code 1
"""
import sys
import json


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 whisper_worker.py <audio_file>"}))
        sys.exit(1)

    audio_path = sys.argv[1]

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        print(json.dumps({"error": f"faster-whisper not installed: {exc}"}))
        sys.exit(1)

    try:
        # tiny model — ~39 MB, fast on CPU, good for short clips
        model = WhisperModel("tiny", device="cpu", compute_type="int8")

        segments_iter, info = model.transcribe(
            audio_path,
            beam_size=5,
            vad_filter=True,                              # skip silent regions
            vad_parameters={"min_silence_duration_ms": 400},
        )

        segments_out = []
        for seg in segments_iter:
            text = seg.text.strip()
            if text:                                       # skip empty segments
                segments_out.append({
                    "start": round(float(seg.start), 3),
                    "end":   round(float(seg.end),   3),
                    "text":  text,
                })

        print(json.dumps({
            "segments":             segments_out,
            "language":             info.language,
            "language_probability": round(float(info.language_probability), 3),
        }))

    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
