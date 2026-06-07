import { useEffect, useRef, useState } from "react";
import type { SubtitleEntry } from "@workspace/api-client-react";
import { useSettings } from "@/contexts/settings-context";
import { useDubbing, type DubSegment } from "@/lib/use-dubbing";
import { Mic, Loader2, AlertCircle, Download } from "lucide-react";

interface YoutubePlayerProps {
  videoId: string;
  subtitles: SubtitleEntry[];
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export function YoutubePlayer({ videoId, subtitles }: YoutubePlayerProps) {
  const { settings } = useSettings();
  const fontMap = { tajawal: "'Tajawal', sans-serif", cairo: "'Cairo', sans-serif" };

  // ── ALL ORIGINAL LOGIC — UNCHANGED ────────────────────────────
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const subtitlesRef = useRef<SubtitleEntry[]>(subtitles);
  const currentIndexRef = useRef<number>(-1);
  const [currentSubtitle, setCurrentSubtitle] = useState<string>("");
  const [isPlayerReady, setIsPlayerReady] = useState(false);

  // ── NEW: optional Arabic voice dubbing (opt-in, default off) ──
  const dub = useDubbing();
  const dubRef = useRef(dub);
  dubRef.current = dub;

  function stopPolling() {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function clearSubtitle() {
    setCurrentSubtitle("");
  }

  function updateSubtitle() {
    const player = playerRef.current;
    const subs = subtitlesRef.current;

    if (!player || !subs || subs.length === 0) {
      setCurrentSubtitle("");
      return;
    }

    const currentTime: number =
      typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0;

    // Binary search: find the rightmost entry whose start ≤ currentTime.
    //
    // YouTube's transcript format uses OVERLAPPING entries — a new subtitle
    // begins before the previous one's duration expires. The old forward-scan
    // stopped at the first (oldest) match, so the user saw stale text while
    // the audio had already moved on. Binary search always returns the MOST
    // RECENTLY STARTED entry, which is what the speaker is saying right now.
    // It also handles backward seeks naturally without a separate scan pass.
    let lo = 0;
    let hi = subs.length - 1;
    let idx = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Number(subs[mid].start) <= currentTime) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Drive optional dubbing audio (no-op unless dubbing is active)
    dubRef.current.syncTo(currentTime);

    if (idx === -1) {
      currentIndexRef.current = -1;
      setCurrentSubtitle("");
      return;
    }

    currentIndexRef.current = idx;
    const sub = subs[idx];
    const end = Number(sub.start) + Number(sub.duration);

    // Show only if within the entry's duration window; gap otherwise.
    setCurrentSubtitle(currentTime <= end ? (sub.text ?? "") : "");
  }

  function startPolling() {
    stopPolling();
    intervalRef.current = setInterval(updateSubtitle, 100);
  }

  useEffect(() => {
    subtitlesRef.current = subtitles;
    currentIndexRef.current = -1;
    setCurrentSubtitle("");
  }, [subtitles]);

  useEffect(() => {
    let destroyed = false;

    function initPlayer() {
      if (destroyed) return;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      stopPolling();
      clearSubtitle();
      currentIndexRef.current = -1;
      setIsPlayerReady(false);

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { if (!destroyed) setIsPlayerReady(true); },
          onStateChange: (event: { data: number }) => {
            const state: number = event.data;
            const YTState = window.YT.PlayerState;
            if (state === YTState.PLAYING) {
              startPolling();
            } else {
              stopPolling();
              clearSubtitle();
              dubRef.current.pauseAudio();
            }
          },
        },
      });
    }

    if (!window.YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }

    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = () => initPlayer();
    }

    return () => {
      destroyed = true;
      stopPolling();
      clearSubtitle();
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
    };
  }, [videoId]);
  // ── END ORIGINAL LOGIC ────────────────────────────────────────

  // Keep the YouTube player muted while dubbing is active so audio doesn't overlap
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (dub.active) p.mute?.();
      else p.unMute?.();
    } catch { /* ignore */ }
  }, [dub.active, isPlayerReady]);

  function buildSegments(): DubSegment[] {
    return subtitlesRef.current.map((s) => ({
      start: Number(s.start),
      end: Number(s.start) + Number(s.duration),
      text: s.text ?? "",
    }));
  }

  async function toggleDubbing() {
    if (dub.active) {
      dub.deactivate();
      return;
    }
    await dub.activate(buildSegments(), settings.dubbingVoice);
  }

  function downloadDub() {
    if (dub.downloading) return;
    void dub.downloadAudio(buildSegments(), settings.dubbingVoice, `dubbed-${videoId}.mp3`);
  }

  // Auto-activate dubbing when the user has turned it on by default in settings.
  // Default is off, so this is a no-op for the existing experience.
  const autoDubRef = useRef(false);
  useEffect(() => { autoDubRef.current = false; }, [videoId]);
  useEffect(() => {
    if (!settings.dubbingEnabled || !isPlayerReady) return;
    if (autoDubRef.current || dubRef.current.status !== "idle") return;
    const subs = subtitlesRef.current;
    if (subs.length === 0) return;
    autoDubRef.current = true;
    const segs: DubSegment[] = subs.map((s) => ({
      start: Number(s.start),
      end: Number(s.start) + Number(s.duration),
      text: s.text ?? "",
    }));
    void dubRef.current.activate(segs, settings.dubbingVoice);
  }, [settings.dubbingEnabled, settings.dubbingVoice, isPlayerReady, dub.status]);

  return (
    <div>
    <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", background: "#000" }}>
      {/* Player container */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Subtitle overlay */}
      {isPlayerReady && (
        <div
          style={{
            position: "absolute",
            bottom: settings.position === "bottom" ? 0 : undefined,
            top: settings.position === "top" ? 0 : undefined,
            left: 0, right: 0,
            padding: settings.position === "bottom" ? "0 12px 48px" : "12px 12px 0",
            display: "flex",
            justifyContent: "center",
            alignItems: settings.position === "bottom" ? "flex-end" : "flex-start",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            dir="rtl"
            lang="ar"
            style={{
              opacity: currentSubtitle && !(settings.hideSubsWhileDubbing && dub.active) ? 1 : 0,
              transform: currentSubtitle ? "translateY(0)" : "translateY(6px)",
              transition: "opacity 0.18s ease, transform 0.18s ease",
              background: `rgba(0,0,0,${settings.bgOpacity})`,
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.1)",
              padding: "10px 22px",
              maxWidth: "88%",
              wordBreak: "break-word",
              overflowWrap: "break-word",
              whiteSpace: "normal",
              textAlign: "center",
              direction: "rtl",
              unicodeBidi: "plaintext",
              fontFamily: fontMap[settings.fontFamily],
              fontSize: settings.fontSize,
              fontWeight: settings.bold ? 700 : 400,
              color: settings.color,
              lineHeight: 1.5,
              textShadow: settings.shadow ? "0 2px 10px rgba(0,0,0,0.9)" : "none",
              letterSpacing: "0.01em",
            }}
          >
            {currentSubtitle || "\u00A0"}
          </div>
        </div>
      )}
    </div>

      {/* ── Dubbing control bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "12px 14px", background: "#0B1220",
      }}>
        <button
          type="button"
          onClick={toggleDubbing}
          disabled={dub.status === "preparing"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "9px 18px", borderRadius: 12,
            border: `1px solid ${dub.active ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.12)"}`,
            background: dub.active ? "rgba(255,61,0,0.15)" : "rgba(255,255,255,0.04)",
            color: dub.active ? "#FF6B35" : "#CBD5E1",
            fontFamily: "'Cairo', sans-serif", fontSize: "0.88rem", fontWeight: 600,
            cursor: dub.status === "preparing" ? "wait" : "pointer",
          }}
        >
          {dub.status === "preparing"
            ? <><Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />جارٍ تجهيز الدبلجة… {dub.progress}%</>
            : dub.active
              ? <><Mic style={{ width: 16, height: 16 }} />إيقاف الدبلجة</>
              : <><Mic style={{ width: 16, height: 16 }} />دبلجة صوتية بالعربية</>}
        </button>
        {dub.status === "ready" && (
          <button
            type="button"
            onClick={downloadDub}
            disabled={dub.downloading}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "9px 18px", borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              color: "#CBD5E1",
              fontFamily: "'Cairo', sans-serif", fontSize: "0.88rem", fontWeight: 600,
              cursor: dub.downloading ? "wait" : "pointer",
            }}
          >
            {dub.downloading
              ? <><Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />جارٍ تجهيز الملف…</>
              : <><Download style={{ width: 16, height: 16 }} />تنزيل الصوت المدبلج</>}
          </button>
        )}
        {dub.active && dub.status === "ready" && (
          <span style={{ color: "#64748B", fontSize: "0.78rem" }}>
            تم كتم صوت الفيديو الأصلي — الدبلجة تقريبية المزامنة
          </span>
        )}
        {dub.status === "error" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#F87171", fontSize: "0.8rem" }}>
            <AlertCircle style={{ width: 14, height: 14 }} />{dub.error}
          </span>
        )}
        {dub.downloadError && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#F87171", fontSize: "0.8rem" }}>
            <AlertCircle style={{ width: 14, height: 14 }} />{dub.downloadError}
          </span>
        )}
      </div>
    </div>
  );
}
