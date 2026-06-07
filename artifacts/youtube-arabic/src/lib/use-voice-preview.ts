import { useCallback, useEffect, useRef, useState } from "react";

/* Short fixed Arabic sample spoken when previewing a dubbing voice. Keeping it
 * constant means the server caches one clip per voice (sha1 of model|voice|text),
 * so repeated previews are served from disk and never re-bill. */
const SAMPLE_TEXT = "مرحباً، هذا مثال على صوت الدبلجة العربية.";

export type PreviewStatus = "idle" | "loading" | "playing" | "error";

interface TtsResponse {
  clips: { index: number; audio: string | null }[];
  error?: string;
}

function base64ToBlobUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

/* Tiny silent WAV used to satisfy browser autoplay policy on the click gesture,
 * since the real clip plays only after an awaited fetch. */
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

/**
 * Plays a short fixed Arabic sample for a given dubbing voice so users can hear
 * a voice before choosing it. Only one preview plays at a time; clicking the
 * active voice again stops it.
 */
export function useVoicePreview() {
  const [activeVoice, setActiveVoice] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const tokenRef = useRef(0); // invalidates in-flight previews

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* ignore */ }
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    tokenRef.current++;
    cleanup();
    setActiveVoice(null);
    setStatus("idle");
    setError(null);
  }, [cleanup]);

  useEffect(() => () => { tokenRef.current++; cleanup(); }, [cleanup]);

  const preview = useCallback(async (voiceId: string) => {
    // Toggle off when the same voice is already loading or playing
    if (activeVoice === voiceId && (status === "loading" || status === "playing")) {
      stop();
      return;
    }

    // Unlock audio synchronously within the click gesture
    try {
      const unlock = new Audio(silentWavUrl());
      unlock.volume = 0;
      void unlock.play().then(() => unlock.pause()).catch(() => undefined);
    } catch { /* ignore */ }

    const token = ++tokenRef.current;
    cleanup();
    setActiveVoice(voiceId);
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: [{ index: 0, text: SAMPLE_TEXT }], voiceId }),
      });
      if (token !== tokenRef.current) return; // superseded / stopped

      const data = (await res.json()) as TtsResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `فشل توليد المعاينة (${res.status})`);
      }
      const b64 = data.clips[0]?.audio;
      if (!b64) throw new Error("تعذّر توليد المعاينة لهذا الصوت.");

      if (token !== tokenRef.current) return;

      const url = base64ToBlobUrl(b64);
      const audio = new Audio(url);
      urlRef.current = url;
      audioRef.current = audio;
      audio.onended = () => {
        if (token !== tokenRef.current) return;
        cleanup();
        setStatus("idle");
        setActiveVoice(null);
      };
      setStatus("playing");
      void audio.play().catch(() => undefined);
    } catch (err) {
      if (token !== tokenRef.current) return;
      cleanup();
      setStatus("error");
      setError(err instanceof Error ? err.message : "تعذّر توليد المعاينة");
    }
  }, [activeVoice, status, stop, cleanup]);

  return { activeVoice, status, error, preview, stop };
}
