import { useState, useRef } from "react";
import { useTranslateSubtitles } from "@workspace/api-client-react";
import { YoutubePlayer } from "@/components/youtube-player";
import { WhisperUpload } from "@/components/whisper-upload";
import type { SubtitleEntry } from "@workspace/api-client-react";
import { addHistoryItem } from "@/lib/storage";
import { useSettings } from "@/contexts/settings-context";
import {
  Loader2,
  Link2,
  Search,
  Zap,
  Film,
  AlertCircle,
  Youtube,
  Download,
  Upload,
} from "lucide-react";
import { usePwaInstall } from "@/hooks/use-pwa-install";

interface VideoResult {
  videoId: string;
  subtitles: SubtitleEntry[];
}

export function Home() {
  // ── ALL ORIGINAL LOGIC — UNCHANGED ────────────────────────────
  const [url, setUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<VideoResult | null>(null);
  const mutation = useTranslateSubtitles();
  const activeRequestId = useRef<number>(0);
  const { settings } = useSettings();

  // UI-only tab state (within YouTube mode)
  const [activeTab, setActiveTab] = useState<"link" | "search">("link");

  // PWA install prompt
  const { isInstallable, install } = usePwaInstall();

  const handleTranslate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    const requestId = Date.now();
    activeRequestId.current = requestId;

    setErrorMsg(null);
    setResult(null);

    mutation.mutate(
      { data: { video_url: url, engine: settings.translationEngine } },
      {
        onSuccess: (data) => {
          if (requestId !== activeRequestId.current) return;
          if (!data || data.subtitles.length === 0) {
            setErrorMsg("No Arabic subtitles could be generated for this video.");
            return;
          }
          setResult({ videoId: data.videoId, subtitles: data.subtitles });
          addHistoryItem({
            type: "youtube",
            title: url,
            videoId: data.videoId,
            subtitles: data.subtitles,
          });
        },
        onError: (err: unknown) => {
          if (requestId !== activeRequestId.current) return;
          let message =
            "تعذّر تحميل الترجمة — تأكد من أن الفيديو يحتوي على تعليق صوتي إنجليزي أو أن الرابط صحيح.";
          try {
            const body = (err as { data?: { error?: string; details?: string } })?.data;
            if (body?.error) {
              message = body.details ? `${body.error} — ${body.details}` : body.error;
            }
          } catch { /* use default */ }
          setErrorMsg(message);
        },
      }
    );
  };
  // ── END ORIGINAL LOGIC ────────────────────────────────────────

  const isLoading = mutation.isPending;
  const showEmpty = !isLoading && !errorMsg && !result;

  // ── NEW: main mode selector ───────────────────────────────────
  const [mainTab, setMainTab] = useState<"youtube" | "whisper">("youtube");

  return (
    <div
      style={{ background: "#0B1220", minHeight: "100vh", fontFamily: "'Cairo', 'Tajawal', sans-serif", paddingBottom: 72 }}
      className="relative overflow-x-hidden text-white"
    >
      {/* ── Ambient background orbs ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div
          className="glow-orb absolute rounded-full"
          style={{
            width: "55vw", height: "55vw",
            top: "-15vw", left: "-15vw",
            background: "radial-gradient(ellipse, rgba(124,58,237,0.18) 0%, transparent 70%)",
            filter: "blur(40px)",
          }}
        />
        <div
          className="glow-orb-2 absolute rounded-full"
          style={{
            width: "50vw", height: "50vw",
            bottom: "-10vw", right: "-10vw",
            background: "radial-gradient(ellipse, rgba(0,212,255,0.12) 0%, transparent 70%)",
            filter: "blur(40px)",
          }}
        />
        <div
          className="glow-orb-3 absolute rounded-full"
          style={{
            width: "40vw", height: "40vw",
            top: "30%", left: "50%", transform: "translateX(-50%)",
            background: "radial-gradient(ellipse, rgba(255,61,0,0.08) 0%, transparent 70%)",
            filter: "blur(60px)",
          }}
        />
      </div>

      {/* ── Page content ── */}
      <div className="relative z-10 flex flex-col items-center px-4 py-10 md:py-16">
        <div className="w-full max-w-3xl flex flex-col gap-10">

          {/* ── HEADER ── */}
          <header className="flex flex-col items-center text-center gap-5">
            {/* Top badges row */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
              {/* AI badge */}
              <div
                style={{
                  display: "inline-flex", alignItems: "center", gap: "8px",
                  padding: "6px 18px", borderRadius: "999px",
                  background: "rgba(124,58,237,0.15)",
                  border: "1px solid rgba(124,58,237,0.35)",
                  color: "#C4B5FD", fontSize: "13px", fontWeight: 600,
                  letterSpacing: "0.02em",
                }}
              >
                ✨ مدعوم بالذكاء الاصطناعي
              </div>

              {/* Install button — only shown when browser offers PWA install */}
              {isInstallable && (
                <button
                  type="button"
                  onClick={install}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "7px",
                    padding: "6px 18px", borderRadius: "999px",
                    background: "linear-gradient(135deg, rgba(255,61,0,0.18), rgba(124,58,237,0.18))",
                    border: "1px solid rgba(255,61,0,0.35)",
                    color: "#FCA5A5", fontSize: "13px", fontWeight: 600,
                    cursor: "pointer", transition: "all 0.2s",
                    fontFamily: "'Cairo', sans-serif",
                    letterSpacing: "0.02em",
                  }}
                >
                  <Download style={{ width: 13, height: 13 }} />
                  تثبيت التطبيق
                </button>
              )}
            </div>

            {/* Icon badge */}
            <div
              style={{
                width: 72, height: 72, borderRadius: 20,
                background: "linear-gradient(135deg, rgba(255,61,0,0.2), rgba(124,58,237,0.2))",
                border: "1px solid rgba(255,61,0,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 0 40px rgba(255,61,0,0.2)",
              }}
            >
              <Youtube style={{ width: 36, height: 36, color: "#FF3D00" }} />
            </div>

            {/* Title */}
            <h1
              style={{
                fontSize: "clamp(2.4rem, 7vw, 4rem)",
                fontWeight: 800,
                lineHeight: 1.1,
                background: "linear-gradient(135deg, #FF3D00 0%, #FF6B35 28%, #E91E8C 62%, #7C3AED 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                letterSpacing: "-0.02em",
              }}
            >
              Ali YouTube
            </h1>

            {/* Subtitle */}
            <p
              style={{
                color: "#94A3B8", fontSize: "clamp(0.95rem, 2.5vw, 1.15rem)",
                maxWidth: 480, lineHeight: 1.7, fontWeight: 400,
              }}
            >
              شاهد أي فيديو يوتيوب بترجمة عربية ذكية ومتزامنة.
            </p>
          </header>

          {/* ── MAIN MODE TABS ── */}
          <div
            style={{
              display: "flex", padding: 5, borderRadius: 999,
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.08)",
              gap: 5, width: "fit-content", margin: "0 auto",
            }}
          >
            {([
              { id: "youtube" as const, label: "يوتيوب", Icon: Youtube },
              { id: "whisper" as const, label: "رفع + ويسبر", Icon: Upload },
            ] as const).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMainTab(id)}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "10px 24px", borderRadius: 999,
                  fontSize: "0.9rem", fontWeight: 600,
                  cursor: "pointer", transition: "all 0.2s",
                  fontFamily: "'Cairo', sans-serif",
                  border: "none",
                  background: mainTab === id
                    ? "linear-gradient(135deg, #FF3D00, #7C3AED)"
                    : "transparent",
                  color: mainTab === id ? "#fff" : "#64748B",
                  boxShadow: mainTab === id
                    ? "0 2px 16px rgba(255,61,0,0.3)"
                    : "none",
                }}
              >
                <Icon style={{ width: 16, height: 16 }} />
                {label}
              </button>
            ))}
          </div>

          {/* ── WHISPER MODE ── */}
          {mainTab === "whisper" && <WhisperUpload />}

          {/* ── YOUTUBE MODE ── */}
          {mainTab === "youtube" && (
            <>
              {/* INPUT CARD */}
              <div
                className="glass gradient-border w-full"
                style={{ borderRadius: 24, padding: "clamp(20px, 4vw, 32px)" }}
              >
                {/* Segmented tabs */}
                <div
                  style={{
                    display: "flex", padding: 4, borderRadius: 999,
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.05)",
                    marginBottom: 20, width: "fit-content", margin: "0 auto 20px",
                    gap: 4,
                  }}
                >
                  {[
                    { id: "link" as const, label: "رابط", Icon: Link2 },
                    { id: "search" as const, label: "بحث", Icon: Search },
                  ].map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      className={activeTab === id ? "tab-active" : "tab-inactive"}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "8px 20px", borderRadius: 999,
                        fontSize: "0.875rem", fontWeight: 600,
                        cursor: "pointer", transition: "all 0.2s",
                        fontFamily: "'Cairo', sans-serif",
                      }}
                    >
                      <Icon style={{ width: 15, height: 15 }} />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Input form */}
                <form onSubmit={handleTranslate} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ position: "relative" }}>
                    {activeTab === "link" ? (
                      <Link2
                        style={{
                          position: "absolute", right: 16, top: "50%",
                          transform: "translateY(-50%)", width: 18, height: 18,
                          color: "#94A3B8", pointerEvents: "none",
                        }}
                      />
                    ) : (
                      <Search
                        style={{
                          position: "absolute", right: 16, top: "50%",
                          transform: "translateY(-50%)", width: 18, height: 18,
                          color: "#94A3B8", pointerEvents: "none",
                        }}
                      />
                    )}
                    <input
                      data-testid="input-youtube-url"
                      type={activeTab === "link" ? "url" : "text"}
                      placeholder={
                        activeTab === "link"
                          ? "https://www.youtube.com/watch?v=..."
                          : "ابحث عن فيديو يوتيوب..."
                      }
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      required
                      className="glass-input"
                      style={{
                        width: "100%", height: 56, borderRadius: 14,
                        paddingRight: 48, paddingLeft: 16,
                        fontSize: "1rem", fontFamily: "'Cairo', sans-serif",
                        direction: activeTab === "search" ? "rtl" : "ltr",
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      data-testid="button-translate"
                      type="submit"
                      disabled={isLoading || !url.trim()}
                      className="btn-gradient"
                      style={{
                        flex: 1, height: 56, borderRadius: 14,
                        fontSize: "1.05rem", display: "flex",
                        alignItems: "center", justifyContent: "center", gap: 8,
                        fontFamily: "'Cairo', sans-serif",
                      }}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 style={{ width: 20, height: 20, animation: "spin 1s linear infinite" }} />
                          جارٍ الترجمة...
                        </>
                      ) : (
                        <>
                          <Zap style={{ width: 18, height: 18 }} />
                          ترجم وشغّل
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>

              {/* CONTENT AREA */}
              <div className="w-full">

                {/* Loading state */}
                {isLoading && (
                  <div
                    className="loading-shimmer"
                    style={{
                      borderRadius: 20, padding: "40px 24px",
                      display: "flex", flexDirection: "column",
                      alignItems: "center", gap: 16, textAlign: "center",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <div
                      style={{
                        width: 56, height: 56, borderRadius: 16,
                        background: "rgba(255,61,0,0.1)",
                        border: "1px solid rgba(255,61,0,0.2)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Loader2
                        style={{ width: 28, height: 28, color: "#FF3D00", animation: "spin 1s linear infinite" }}
                      />
                    </div>
                    <div>
                      <p style={{ fontWeight: 700, fontSize: "1.1rem", color: "#fff", marginBottom: 4 }}>
                        جارٍ ترجمة الفيديو...
                      </p>
                      <p style={{ color: "#94A3B8", fontSize: "0.88rem" }}>
                        قد يستغرق الأمر بضع ثوانٍ حسب طول الفيديو
                      </p>
                    </div>
                  </div>
                )}

                {/* Error state */}
                {errorMsg && !isLoading && (
                  <div
                    data-testid="status-error"
                    style={{
                      borderRadius: 20, padding: "28px 24px",
                      background: "rgba(239,68,68,0.08)",
                      border: "1px solid rgba(239,68,68,0.2)",
                      display: "flex", flexDirection: "column",
                      alignItems: "center", gap: 14, textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 52, height: 52, borderRadius: 14,
                        background: "rgba(239,68,68,0.12)",
                        border: "1px solid rgba(239,68,68,0.25)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <AlertCircle style={{ width: 26, height: 26, color: "#F87171" }} />
                    </div>
                    <div>
                      <p style={{ fontWeight: 700, color: "#FCA5A5", fontSize: "1rem", marginBottom: 4 }}>
                        حدث خطأ
                      </p>
                      <p style={{ color: "#94A3B8", fontSize: "0.9rem", lineHeight: 1.6 }} dir="rtl">
                        {errorMsg}
                      </p>
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {showEmpty && (
                  <div
                    style={{
                      borderRadius: 20, padding: "48px 24px",
                      background: "rgba(20,27,45,0.4)",
                      border: "1px solid rgba(255,255,255,0.05)",
                      display: "flex", flexDirection: "column",
                      alignItems: "center", gap: 16, textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 72, height: 72, borderRadius: 20,
                        background: "rgba(124,58,237,0.1)",
                        border: "1px solid rgba(124,58,237,0.2)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Film style={{ width: 34, height: 34, color: "#A78BFA" }} />
                    </div>
                    <div>
                      <p style={{ fontWeight: 700, color: "#fff", fontSize: "1.05rem", marginBottom: 6 }}>
                        ابدأ بإدخال رابط أو البحث عن فيديو
                      </p>
                      <p style={{ color: "#94A3B8", fontSize: "0.88rem", lineHeight: 1.6 }}>
                        الصق رابط يوتيوب وسنقوم بترجمته فوراً إلى العربية
                      </p>
                    </div>
                  </div>
                )}

                {/* Player */}
                {result && result.subtitles.length > 0 && (
                  <div
                    className="gradient-border"
                    style={{ borderRadius: 24, padding: 3 }}
                  >
                    <div
                      style={{
                        borderRadius: 22, overflow: "hidden",
                        background: "#000",
                        boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 60px rgba(124,58,237,0.15)",
                      }}
                    >
                      <YoutubePlayer
                        videoId={result.videoId}
                        subtitles={result.subtitles}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
