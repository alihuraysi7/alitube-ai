import { useState, useEffect } from "react";
import {
  loadHistory, toggleFavorite, deleteHistoryItem, clearHistory, HistoryItem,
} from "@/lib/storage";
import { YoutubePlayer } from "@/components/youtube-player";
import {
  Star, Trash2, Play, FileText, Youtube, Clock, Trash,
  ChevronDown, ChevronUp,
} from "lucide-react";

type Filter = "all" | "favorites" | "youtube" | "whisper";

function timeAgo(ts: number) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "الآن";
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  const day = Math.floor(h / 24);
  return `منذ ${day} يوم`;
}

export function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [playing, setPlaying] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  function refresh() { setItems(loadHistory()); }
  useEffect(refresh, []);

  function handleFavorite(id: string) {
    toggleFavorite(id);
    refresh();
  }
  function handleDelete(id: string) {
    if (playing === id) setPlaying(null);
    deleteHistoryItem(id);
    refresh();
  }
  function handleClear() {
    if (!confirm("حذف كل السجلات؟")) return;
    clearHistory();
    setPlaying(null);
    refresh();
  }

  const filtered = items.filter(i => {
    if (filter === "favorites") return i.isFavorite;
    if (filter === "youtube")  return i.type === "youtube";
    if (filter === "whisper")  return i.type === "whisper";
    return true;
  });

  const playingItem = filtered.find(i => i.id === playing);

  return (
    <div
      style={{
        minHeight: "100vh", background: "#0B1220",
        fontFamily: "'Cairo', 'Tajawal', sans-serif",
        color: "#fff", paddingBottom: 90,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "20px 20px 0",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: "1.5rem", fontWeight: 800, margin: 0 }}>
          السجلات والمفضلة
        </h2>
        {items.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", borderRadius: 10,
              border: "1px solid rgba(239,68,68,0.25)",
              background: "rgba(239,68,68,0.08)",
              color: "#F87171", fontSize: "0.8rem", fontWeight: 600,
              cursor: "pointer", fontFamily: "'Cairo', sans-serif",
            }}
          >
            <Trash style={{ width: 14, height: 14 }} />
            حذف الكل
          </button>
        )}
      </div>

      {/* Filter chips */}
      <div
        style={{
          padding: "16px 20px 12px",
          display: "flex", gap: 8, flexWrap: "wrap",
        }}
      >
        {([
          { id: "all",       label: "الكل" },
          { id: "favorites", label: "المفضلة ⭐" },
          { id: "youtube",   label: "يوتيوب" },
          { id: "whisper",   label: "ويسبر" },
        ] as const).map(f => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            style={{
              padding: "7px 18px", borderRadius: 999,
              border: `1px solid ${filter === f.id ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.08)"}`,
              background: filter === f.id
                ? "linear-gradient(135deg,rgba(255,61,0,0.25),rgba(124,58,237,0.25))"
                : "rgba(255,255,255,0.04)",
              color: filter === f.id ? "#FF3D00" : "#64748B",
              fontSize: "0.82rem", fontWeight: 600,
              cursor: "pointer", fontFamily: "'Cairo', sans-serif",
              transition: "all 0.15s",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Inline player */}
      {playingItem?.type === "youtube" && playingItem.videoId && playingItem.subtitles && (
        <div style={{ padding: "0 16px 16px" }}>
          <div
            style={{
              borderRadius: 18, overflow: "hidden",
              boxShadow: "0 16px 60px rgba(0,0,0,0.5)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}
          >
            <YoutubePlayer
              videoId={playingItem.videoId}
              subtitles={playingItem.subtitles as any}
            />
          </div>
          <button
            type="button"
            onClick={() => setPlaying(null)}
            style={{
              marginTop: 10, width: "100%",
              padding: "9px", borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.05)",
              color: "#94A3B8", fontSize: "0.85rem",
              cursor: "pointer", fontFamily: "'Cairo', sans-serif",
            }}
          >
            إخفاء المشغّل
          </button>
        </div>
      )}

      {/* List */}
      <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center", padding: "64px 24px",
              color: "#475569", fontSize: "0.95rem",
            }}
          >
            <Clock style={{ width: 48, height: 48, margin: "0 auto 16px", opacity: 0.3 }} />
            <p style={{ margin: 0 }}>لا توجد سجلات بعد</p>
          </div>
        ) : (
          filtered.map(item => {
            const isPlaying = playing === item.id;
            const isExpanded = expanded === item.id;
            return (
              <div
                key={item.id}
                style={{
                  borderRadius: 16, overflow: "hidden",
                  border: `1px solid ${isPlaying ? "rgba(255,61,0,0.3)" : "rgba(255,255,255,0.07)"}`,
                  background: isPlaying
                    ? "rgba(255,61,0,0.06)"
                    : "rgba(255,255,255,0.03)",
                  transition: "all 0.18s",
                }}
              >
                {/* Item header */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 14px 12px" }}>
                  {/* Type icon */}
                  <div
                    style={{
                      width: 42, height: 42, borderRadius: 12, flexShrink: 0,
                      background: item.type === "youtube"
                        ? "rgba(255,61,0,0.12)" : "rgba(124,58,237,0.12)",
                      border: `1px solid ${item.type === "youtube" ? "rgba(255,61,0,0.2)" : "rgba(124,58,237,0.2)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {item.type === "youtube"
                      ? <Youtube style={{ width: 20, height: 20, color: "#FF3D00" }} />
                      : <FileText style={{ width: 20, height: 20, color: "#A78BFA" }} />
                    }
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        margin: "0 0 3px", fontSize: "0.88rem", fontWeight: 700,
                        color: "#E2E8F0",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        direction: "ltr", textAlign: "right",
                      }}
                    >
                      {item.title}
                    </p>
                    <p style={{ margin: 0, fontSize: "0.75rem", color: "#475569" }}>
                      {item.type === "youtube" ? "يوتيوب" : "ويسبر"} · {timeAgo(item.date)}
                    </p>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => handleFavorite(item.id)}
                      style={{
                        width: 34, height: 34, borderRadius: 8,
                        border: "none",
                        background: item.isFavorite
                          ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
                        color: item.isFavorite ? "#FBBf24" : "#475569",
                        cursor: "pointer", display: "flex",
                        alignItems: "center", justifyContent: "center",
                      }}
                      title="مفضلة"
                    >
                      <Star style={{ width: 16, height: 16, fill: item.isFavorite ? "#FBBf24" : "none" }} />
                    </button>

                    {item.type === "youtube" && item.videoId && item.subtitles && (
                      <button
                        type="button"
                        onClick={() => setPlaying(isPlaying ? null : item.id)}
                        style={{
                          width: 34, height: 34, borderRadius: 8,
                          border: "none",
                          background: isPlaying ? "rgba(255,61,0,0.2)" : "rgba(255,255,255,0.05)",
                          color: isPlaying ? "#FF3D00" : "#475569",
                          cursor: "pointer", display: "flex",
                          alignItems: "center", justifyContent: "center",
                        }}
                        title="تشغيل"
                      >
                        <Play style={{ width: 16, height: 16 }} />
                      </button>
                    )}

                    {item.type === "whisper" && item.segments && item.segments.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(isExpanded ? null : item.id)}
                        style={{
                          width: 34, height: 34, borderRadius: 8,
                          border: "none",
                          background: isExpanded ? "rgba(124,58,237,0.2)" : "rgba(255,255,255,0.05)",
                          color: isExpanded ? "#A78BFA" : "#475569",
                          cursor: "pointer", display: "flex",
                          alignItems: "center", justifyContent: "center",
                        }}
                        title="عرض الترجمة"
                      >
                        {isExpanded
                          ? <ChevronUp style={{ width: 16, height: 16 }} />
                          : <ChevronDown style={{ width: 16, height: 16 }} />
                        }
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      style={{
                        width: 34, height: 34, borderRadius: 8,
                        border: "none",
                        background: "rgba(239,68,68,0.08)",
                        color: "#F87171",
                        cursor: "pointer", display: "flex",
                        alignItems: "center", justifyContent: "center",
                      }}
                      title="حذف"
                    >
                      <Trash2 style={{ width: 16, height: 16 }} />
                    </button>
                  </div>
                </div>

                {/* Whisper expanded transcript */}
                {isExpanded && item.segments && (
                  <div
                    style={{
                      borderTop: "1px solid rgba(255,255,255,0.06)",
                      padding: "10px 14px 14px",
                      maxHeight: 280,
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {item.segments.map((seg, i) => (
                      <div
                        key={i}
                        style={{
                          borderRadius: 8,
                          background: "rgba(255,255,255,0.03)",
                          padding: "8px 10px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                        }}
                      >
                        <p style={{ margin: 0, fontSize: "0.82rem", color: "#60A5FA", direction: "ltr" }}>
                          {seg.english}
                        </p>
                        <p style={{ margin: 0, fontSize: "0.85rem", color: "#E2E8F0", fontWeight: 600, direction: "rtl" }}>
                          {seg.arabic}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
