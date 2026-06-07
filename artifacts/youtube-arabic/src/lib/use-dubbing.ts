import { useCallback, useEffect, useRef, useState } from "react";

/* ── Types ───────────────────────────────────────────────────── */

export interface DubSegment {
  start: number; // seconds
  end: number;   // seconds
  text: string;  // Arabic text to synthesize
}

export type DubStatus = "idle" | "preparing" | "ready" | "error";

interface DubClip {
  start: number;
  end: number;
  audio: HTMLAudioElement | null;
  url: string | null;
}

interface TtsResponse {
  clips: { index: number; audio: string | null }[];
  error?: string;
}

const CHUNK_SIZE = 12; // segments per /api/tts request
const RATE_MIN = 0.8;
const RATE_MAX = 2.2;

/* ── Helpers ─────────────────────────────────────────────────── */

function base64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

/* Tiny silent WAV used to satisfy browser autoplay policy on the activating gesture */
function silentWavUrl(): string {
  const bytes = new Uint8Array(44);
  const v = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, 0, true);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "data:audio/wav;base64," + btoa(bin);
}

/* ── Hook ────────────────────────────────────────────────────── */

export function useDubbing() {
  const [status, setStatus] = useState<DubStatus>("idle");
  const [progress, setProgress] = useState(0); // 0..100
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const clipsRef = useRef<DubClip[]>([]);
  const curIdxRef = useRef<number>(-1);
  const activeRef = useRef(false);
  const tokenRef = useRef(0); // invalidates in-flight prepare runs

  const disposeClips = (clips: DubClip[]) => {
    for (const c of clips) {
      if (c.audio) {
        try { c.audio.pause(); } catch { /* ignore */ }
        c.audio.src = "";
      }
      if (c.url) URL.revokeObjectURL(c.url);
      c.audio = null;
      c.url = null;
    }
  };

  const releaseClips = useCallback(() => {
    disposeClips(clipsRef.current);
    clipsRef.current = [];
    curIdxRef.current = -1;
  }, []);

  const deactivate = useCallback(() => {
    tokenRef.current++;
    activeRef.current = false;
    setActive(false);
    releaseClips();
    setStatus("idle");
    setProgress(0);
    setError(null);
  }, [releaseClips]);

  useEffect(() => () => { tokenRef.current++; releaseClips(); }, [releaseClips]);

  /**
   * Generate TTS clips for the given segments and switch dubbing on.
   * Must be invoked from a user gesture (unlocks browser audio autoplay).
   */
  const activate = useCallback(async (segments: DubSegment[], voiceId: string) => {
    // Unlock audio synchronously within the calling gesture
    try {
      const unlock = new Audio(silentWavUrl());
      unlock.volume = 0;
      void unlock.play().then(() => unlock.pause()).catch(() => undefined);
    } catch { /* ignore */ }

    const token = ++tokenRef.current;
    releaseClips();
    setError(null);
    setStatus("preparing");
    setProgress(0);
    activeRef.current = true;
    setActive(true);

    const clips: DubClip[] = segments.map((s) => ({
      start: s.start, end: s.end, audio: null, url: null,
    }));

    const indexed = segments.map((s, i) => ({ index: i, text: s.text }));
    const chunks: typeof indexed[] = [];
    for (let i = 0; i < indexed.length; i += CHUNK_SIZE) {
      chunks.push(indexed.slice(i, i + CHUNK_SIZE));
    }

    let done = 0;
    let committed = false;
    try {
      for (const chunk of chunks) {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: chunk, voiceId }),
        });
        if (token !== tokenRef.current) return; // superseded / deactivated

        const data = (await res.json()) as TtsResponse;
        if (!res.ok || data.error) {
          throw new Error(data.error ?? `فشل توليد الصوت (${res.status})`);
        }

        for (const clip of data.clips) {
          if (clip.audio && clips[clip.index]) {
            const url = base64ToBlobUrl(clip.audio);
            const audio = new Audio(url);
            audio.preload = "auto";
            clips[clip.index].audio = audio;
            clips[clip.index].url = url;
          }
        }
        done += chunk.length;
        if (token === tokenRef.current) {
          setProgress(Math.round((done / indexed.length) * 100));
        }
      }

      if (token !== tokenRef.current) return;
      clipsRef.current = clips;
      curIdxRef.current = -1;
      committed = true;
      setStatus("ready");
      setProgress(100);
    } catch (err) {
      if (token !== tokenRef.current) return;
      activeRef.current = false;
      setActive(false);
      setStatus("error");
      setError(err instanceof Error ? err.message : "تعذّر تجهيز الدبلجة");
    } finally {
      // Release any clips built by a run that was superseded or failed
      if (!committed) disposeClips(clips);
    }
  }, [releaseClips]);

  /** Drive playback to match the given media time. Call on every tick / timeupdate. */
  const syncTo = useCallback((time: number) => {
    if (!activeRef.current) return;
    const clips = clipsRef.current;
    if (clips.length === 0) return;

    // Rightmost clip whose start <= time
    let lo = 0, hi = clips.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (clips[mid].start <= time) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx >= 0 && time >= clips[idx].end) idx = -1; // in a gap

    if (idx !== curIdxRef.current) {
      const prev = curIdxRef.current >= 0 ? clips[curIdxRef.current]?.audio : null;
      if (prev) { try { prev.pause(); } catch { /* ignore */ } }
      curIdxRef.current = idx;

      if (idx >= 0) {
        const c = clips[idx];
        if (c.audio) {
          const segDur = c.end - c.start;
          const clipDur = isFinite(c.audio.duration) ? c.audio.duration : 0;
          const rate = clipDur > 0 && segDur > 0
            ? Math.min(RATE_MAX, Math.max(RATE_MIN, clipDur / segDur))
            : 1;
          c.audio.playbackRate = rate;
          const offset = Math.max(0, time - c.start);
          c.audio.currentTime = clipDur > 0 ? Math.min(offset * rate, clipDur) : 0;
          void c.audio.play().catch(() => undefined);
        }
      }
    } else if (idx >= 0) {
      // Same segment — keep audio aligned and playing.
      const c = clips[idx];
      if (c.audio) {
        const clipDur = isFinite(c.audio.duration) ? c.audio.duration : 0;
        // Re-align if the media jumped within this segment (e.g. a small seek)
        // beyond what normal playback drift would explain.
        if (clipDur > 0) {
          const expected = Math.min(Math.max(0, time - c.start) * c.audio.playbackRate, clipDur);
          if (Math.abs(c.audio.currentTime - expected) > 0.35) {
            c.audio.currentTime = expected;
          }
        }
        if (c.audio.paused && time < c.end && !c.audio.ended) {
          void c.audio.play().catch(() => undefined);
        }
      }
    }
  }, []);

  /** Pause the currently playing clip (e.g. when the video pauses). */
  const pauseAudio = useCallback(() => {
    const c = curIdxRef.current >= 0 ? clipsRef.current[curIdxRef.current]?.audio : null;
    if (c) { try { c.pause(); } catch { /* ignore */ } }
  }, []);

  /**
   * Ask the server to stitch the prepared per-segment clips into one timed MP3
   * (silence padded to each segment's start time) and download it.
   */
  const downloadAudio = useCallback(
    async (segments: DubSegment[], voiceId: string, filename: string) => {
      setDownloading(true);
      setDownloadError(null);
      try {
        const res = await fetch("/api/tts/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            segments: segments.map((s) => ({ start: s.start, text: s.text })),
            voiceId,
          }),
        });
        if (!res.ok) {
          let msg = `فشل تنزيل الصوت (${res.status})`;
          try {
            const j = (await res.json()) as { error?: string };
            if (j?.error) msg = j.error;
          } catch { /* non-JSON error body */ }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (err) {
        setDownloadError(err instanceof Error ? err.message : "تعذّر تنزيل الصوت");
      } finally {
        setDownloading(false);
      }
    },
    [],
  );

  return {
    status, progress, error, active, downloading, downloadError,
    activate, deactivate, syncTo, pauseAudio, downloadAudio,
  };
}
