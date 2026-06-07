#!/usr/bin/env python3
"""
whisper_warmup.py — Downloads and caches the Whisper tiny model at server startup.
Run once so the first real request doesn't wait for a 39 MB download.
"""
import sys

def main() -> None:
    try:
        from faster_whisper import WhisperModel  # type: ignore
        print("[whisper-warmup] Loading tiny model into cache...", flush=True)
        WhisperModel("tiny", device="cpu", compute_type="int8")
        print("[whisper-warmup] Model ready.", flush=True)
    except Exception as exc:  # noqa: BLE001
        # Non-fatal — server still starts, first request will be slower
        print(f"[whisper-warmup] Warning: {exc}", flush=True)

if __name__ == "__main__":
    main()
