import { useSettings } from "@/contexts/settings-context";
import { DEFAULT_SETTINGS, DUBBING_VOICES } from "@/lib/storage";
import { useVoicePreview } from "@/lib/use-voice-preview";
import { Loader2, Play, RotateCcw, Square } from "lucide-react";

const COLORS = [
  { label: "أبيض",    value: "#ffffff" },
  { label: "أصفر",    value: "#FBBF24" },
  { label: "سماوي",   value: "#22D3EE" },
  { label: "أخضر",    value: "#4ADE80" },
  { label: "وردي",    value: "#F472B6" },
  { label: "برتقالي", value: "#FB923C" },
];

const FONTS: { value: "tajawal" | "cairo"; label: string; family: string }[] = [
  { value: "tajawal", label: "تجوال",  family: "'Tajawal', sans-serif" },
  { value: "cairo",   label: "القاهرة", family: "'Cairo', sans-serif" },
];

/* Live preview box */
function SubtitlePreview() {
  const { settings } = useSettings();
  const fontMap = { tajawal: "'Tajawal', sans-serif", cairo: "'Cairo', sans-serif" };
  return (
    <div
      style={{
        borderRadius: 16, overflow: "hidden",
        background: "linear-gradient(135deg,#1a1f35,#0d1525)",
        border: "1px solid rgba(255,255,255,0.08)",
        aspectRatio: "16/6",
        display: "flex",
        alignItems: settings.position === "bottom" ? "flex-end" : "flex-start",
        justifyContent: "center",
        padding: settings.position === "bottom" ? "0 16px 16px" : "16px 16px 0",
        position: "relative",
      }}
    >
      {/* Fake video bars */}
      <div
        style={{
          position: "absolute", inset: 0,
          background: "repeating-linear-gradient(90deg,rgba(255,255,255,0.02) 0,rgba(255,255,255,0.02) 1px,transparent 1px,transparent 60px)",
          pointerEvents: "none",
        }}
      />
      <span
        dir="rtl"
        style={{
          display: "inline-block",
          background: `rgba(0,0,0,${settings.bgOpacity})`,
          backdropFilter: "blur(8px)",
          color: settings.color,
          fontSize: `${settings.fontSize}px`,
          fontWeight: settings.bold ? 700 : 400,
          fontFamily: fontMap[settings.fontFamily],
          padding: "6px 18px",
          borderRadius: 8,
          lineHeight: 1.6,
          textShadow: settings.shadow ? "0 1px 8px rgba(0,0,0,0.9)" : "none",
          direction: "rtl",
          maxWidth: "90%",
          textAlign: "center",
          zIndex: 1,
        }}
      >
        هذا مثال على الترجمة العربية
      </span>
    </div>
  );
}

/* Row wrapper */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 18px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <span style={{ fontSize: "0.9rem", color: "#CBD5E1", fontWeight: 600, flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
        {children}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { settings, update } = useSettings();
  const preview = useVoicePreview();

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
          padding: "20px 20px 16px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: "1.5rem", fontWeight: 800, margin: 0 }}>الإعدادات</h2>
        <button
          type="button"
          onClick={() => update({ ...DEFAULT_SETTINGS })}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 14px", borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.04)",
            color: "#94A3B8", fontSize: "0.8rem", fontWeight: 600,
            cursor: "pointer", fontFamily: "'Cairo', sans-serif",
          }}
        >
          <RotateCcw style={{ width: 13, height: 13 }} />
          إعادة تعيين
        </button>
      </div>

      {/* Preview */}
      <div style={{ padding: "0 16px 20px" }}>
        <p style={{ margin: "0 0 8px", fontSize: "0.78rem", color: "#64748B", fontWeight: 600 }}>
          معاينة
        </p>
        <SubtitlePreview />
      </div>

      {/* Settings card */}
      <div
        style={{
          margin: "0 16px",
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,0.07)",
          background: "rgba(255,255,255,0.03)",
          overflow: "hidden",
        }}
      >
        {/* Section: Typography */}
        <div
          style={{
            padding: "10px 18px 6px",
            fontSize: "0.72rem", color: "#475569",
            fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          الخط
        </div>

        {/* Font size */}
        <Row label={`حجم الخط — ${settings.fontSize}px`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, width: "55%" }}>
            <span style={{ fontSize: "0.75rem", color: "#475569" }}>12</span>
            <input
              type="range" min={12} max={32} step={1}
              value={settings.fontSize}
              onChange={e => update({ fontSize: Number(e.target.value) })}
              style={{ flex: 1, accentColor: "#FF3D00", cursor: "pointer" }}
            />
            <span style={{ fontSize: "0.75rem", color: "#475569" }}>32</span>
          </div>
        </Row>

        {/* Font family */}
        <Row label="نوع الخط">
          <div style={{ display: "flex", gap: 6 }}>
            {FONTS.map(f => (
              <button
                key={f.value}
                type="button"
                onClick={() => update({ fontFamily: f.value })}
                style={{
                  padding: "6px 14px", borderRadius: 8,
                  border: `1px solid ${settings.fontFamily === f.value ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.08)"}`,
                  background: settings.fontFamily === f.value ? "rgba(255,61,0,0.15)" : "transparent",
                  color: settings.fontFamily === f.value ? "#FF6B35" : "#64748B",
                  fontFamily: f.family,
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Row>

        {/* Bold */}
        <Row label="خط عريض">
          <label style={{ display: "flex", alignItems: "center", gap: 0, cursor: "pointer" }}>
            <div
              style={{
                width: 44, height: 26, borderRadius: 13,
                background: settings.bold ? "#FF3D00" : "rgba(255,255,255,0.12)",
                position: "relative", transition: "background 0.2s",
              }}
              onClick={() => update({ bold: !settings.bold })}
            >
              <div
                style={{
                  width: 20, height: 20, borderRadius: "50%",
                  background: "#fff",
                  position: "absolute",
                  top: 3,
                  left: settings.bold ? 21 : 3,
                  transition: "left 0.2s",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                }}
              />
            </div>
          </label>
        </Row>

        {/* Section: Color */}
        <div
          style={{
            padding: "10px 18px 6px",
            fontSize: "0.72rem", color: "#475569",
            fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            marginTop: 4,
          }}
        >
          الألوان
        </div>

        {/* Color presets */}
        <Row label="لون الخط">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {COLORS.map(c => (
              <button
                key={c.value}
                type="button"
                onClick={() => update({ color: c.value })}
                title={c.label}
                style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: c.value,
                  border: settings.color === c.value
                    ? "3px solid #FF3D00"
                    : "2px solid rgba(255,255,255,0.15)",
                  cursor: "pointer",
                  transition: "transform 0.15s",
                  transform: settings.color === c.value ? "scale(1.2)" : "scale(1)",
                }}
              />
            ))}
            {/* Custom color input */}
            <label
              title="لون مخصص"
              style={{
                width: 28, height: 28, borderRadius: "50%",
                border: "2px dashed rgba(255,255,255,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", overflow: "hidden", fontSize: "0.7rem",
                color: "#64748B", background: "rgba(255,255,255,0.05)",
              }}
            >
              +
              <input
                type="color"
                value={settings.color}
                onChange={e => update({ color: e.target.value })}
                style={{ opacity: 0, position: "absolute", width: 1, height: 1 }}
              />
            </label>
          </div>
        </Row>

        {/* Background opacity */}
        <Row label={`شفافية الخلفية — ${Math.round(settings.bgOpacity * 100)}%`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, width: "55%" }}>
            <span style={{ fontSize: "0.75rem", color: "#475569" }}>0%</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={settings.bgOpacity}
              onChange={e => update({ bgOpacity: Number(e.target.value) })}
              style={{ flex: 1, accentColor: "#FF3D00", cursor: "pointer" }}
            />
            <span style={{ fontSize: "0.75rem", color: "#475569" }}>100%</span>
          </div>
        </Row>

        {/* Text shadow */}
        <Row label="ظل الخط">
          <div
            style={{
              width: 44, height: 26, borderRadius: 13,
              background: settings.shadow ? "#FF3D00" : "rgba(255,255,255,0.12)",
              position: "relative", transition: "background 0.2s", cursor: "pointer",
            }}
            onClick={() => update({ shadow: !settings.shadow })}
          >
            <div
              style={{
                width: 20, height: 20, borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 3,
                left: settings.shadow ? 21 : 3,
                transition: "left 0.2s",
                boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        </Row>

        {/* Section: Translation Engine */}
        <div
          style={{
            padding: "10px 18px 6px",
            fontSize: "0.72rem", color: "#475569",
            fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            marginTop: 4,
          }}
        >
          الترجمة
        </div>

        <Row label="محرك الترجمة">
          <div style={{ display: "flex", gap: 6 }}>
            {([
              { id: "mymemory" as const, label: "MyMemory", sub: "افتراضي" },
              { id: "google"   as const, label: "Google",   sub: "بديل مجاني" },
            ]).map(({ id, label, sub }) => (
              <button
                key={id}
                type="button"
                onClick={() => update({ translationEngine: id })}
                style={{
                  padding: "8px 14px", borderRadius: 10,
                  border: `1px solid ${settings.translationEngine === id ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.08)"}`,
                  background: settings.translationEngine === id ? "rgba(255,61,0,0.15)" : "transparent",
                  color: settings.translationEngine === id ? "#FF6B35" : "#64748B",
                  fontSize: "0.82rem", fontWeight: 600,
                  cursor: "pointer", fontFamily: "'Cairo', sans-serif",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                }}
              >
                <span>{label}</span>
                <span style={{ fontSize: "0.68rem", opacity: 0.7 }}>{sub}</span>
              </button>
            ))}
          </div>
        </Row>

        {settings.translationEngine === "google" && (
          <div style={{ padding: "4px 18px 12px" }}>
            <p style={{
              margin: 0, fontSize: "0.75rem",
              color: "#22D3EE",
              background: "rgba(34,211,238,0.07)",
              border: "1px solid rgba(34,211,238,0.15)",
              borderRadius: 8, padding: "8px 12px",
              lineHeight: 1.6,
            }}>
              ✓ Google Translate غير رسمي — مجاني تماماً وبدون حد يومي. جودة ترجمة ممتازة للعربية.
            </p>
          </div>
        )}
        {settings.translationEngine === "mymemory" && (
          <div style={{ padding: "4px 18px 12px" }}>
            <p style={{
              margin: 0, fontSize: "0.75rem",
              color: "#94A3B8",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8, padding: "8px 12px",
              lineHeight: 1.6,
            }}>
              ⚠ MyMemory لديه حد يومي مجاني — إذا ظهر تحذير بانتهاء الحد، غيّر إلى Google.
            </p>
          </div>
        )}

        {/* Section: Dubbing */}
        <div
          style={{
            padding: "10px 18px 6px",
            fontSize: "0.72rem", color: "#475569",
            fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            marginTop: 4,
          }}
        >
          الدبلجة الصوتية
        </div>

        <Row label="تفعيل الدبلجة تلقائياً">
          <div
            style={{
              width: 44, height: 26, borderRadius: 13,
              background: settings.dubbingEnabled ? "#FF3D00" : "rgba(255,255,255,0.12)",
              position: "relative", transition: "background 0.2s", cursor: "pointer",
            }}
            onClick={() => update({ dubbingEnabled: !settings.dubbingEnabled })}
          >
            <div
              style={{
                width: 20, height: 20, borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 3,
                left: settings.dubbingEnabled ? 21 : 3,
                transition: "left 0.2s",
                boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        </Row>

        <Row label="إخفاء الترجمة أثناء الدبلجة">
          <div
            style={{
              width: 44, height: 26, borderRadius: 13,
              background: settings.hideSubsWhileDubbing ? "#FF3D00" : "rgba(255,255,255,0.12)",
              position: "relative", transition: "background 0.2s", cursor: "pointer",
            }}
            onClick={() => update({ hideSubsWhileDubbing: !settings.hideSubsWhileDubbing })}
          >
            <div
              style={{
                width: 20, height: 20, borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 3,
                left: settings.hideSubsWhileDubbing ? 21 : 3,
                transition: "left 0.2s",
                boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
              }}
            />
          </div>
        </Row>

        <Row label="صوت الدبلجة">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {DUBBING_VOICES.map(v => {
              const selected = settings.dubbingVoice === v.id;
              const isActive = preview.activeVoice === v.id;
              const isLoading = isActive && preview.status === "loading";
              const isPlaying = isActive && preview.status === "playing";
              return (
                <div key={v.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => update({ dubbingVoice: v.id })}
                    style={{
                      padding: "8px 14px", borderRadius: 10,
                      border: `1px solid ${selected ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.08)"}`,
                      background: selected ? "rgba(255,61,0,0.15)" : "transparent",
                      color: selected ? "#FF6B35" : "#64748B",
                      fontSize: "0.82rem", fontWeight: 600,
                      cursor: "pointer", fontFamily: "'Cairo', sans-serif",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                    }}
                  >
                    <span>{v.label}</span>
                    <span style={{ fontSize: "0.68rem", opacity: 0.7 }}>{v.gender}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => preview.preview(v.id)}
                    disabled={isLoading}
                    aria-label={isPlaying ? `إيقاف معاينة ${v.label}` : `استماع لصوت ${v.label}`}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                      padding: "5px 10px", borderRadius: 8,
                      border: `1px solid ${isActive ? "rgba(34,211,238,0.4)" : "rgba(255,255,255,0.08)"}`,
                      background: isActive ? "rgba(34,211,238,0.12)" : "rgba(255,255,255,0.03)",
                      color: isActive ? "#22D3EE" : "#94A3B8",
                      fontSize: "0.68rem", fontWeight: 600,
                      cursor: isLoading ? "default" : "pointer",
                      fontFamily: "'Cairo', sans-serif",
                    }}
                  >
                    {isLoading ? (
                      <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                    ) : isPlaying ? (
                      <Square style={{ width: 11, height: 11 }} />
                    ) : (
                      <Play style={{ width: 11, height: 11 }} />
                    )}
                    {isLoading ? "تحميل" : isPlaying ? "إيقاف" : "استماع"}
                  </button>
                </div>
              );
            })}
          </div>
        </Row>

        {preview.status === "error" && preview.error && (
          <div style={{ padding: "0 18px 12px" }}>
            <p style={{
              margin: 0, fontSize: "0.75rem",
              color: "#FCA5A5",
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 8, padding: "8px 12px",
              lineHeight: 1.6,
            }}>
              ⚠ {preview.error}
            </p>
          </div>
        )}

        <div style={{ padding: "4px 18px 12px" }}>
          <p style={{
            margin: 0, fontSize: "0.75rem",
            color: "#94A3B8",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8, padding: "8px 12px",
            lineHeight: 1.6,
          }}>
            🎙️ الدبلجة اختيارية وتعمل عبر ElevenLabs. فعّلها من زر «دبلجة صوتية» أسفل المشغّل، أو شغّل «تفعيل الدبلجة تلقائياً» لبدئها مع كل فيديو. سيتم كتم الصوت الأصلي وتشغيل صوت عربي مُولَّد.
          </p>
        </div>

        {/* Section: Layout */}
        <div
          style={{
            padding: "10px 18px 6px",
            fontSize: "0.72rem", color: "#475569",
            fontWeight: 700, letterSpacing: "0.08em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            marginTop: 4,
          }}
        >
          التخطيط
        </div>

        {/* Position */}
        <Row label="موضع الترجمة">
          <div style={{ display: "flex", gap: 6 }}>
            {(["bottom", "top"] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => update({ position: p })}
                style={{
                  padding: "6px 16px", borderRadius: 8,
                  border: `1px solid ${settings.position === p ? "rgba(255,61,0,0.5)" : "rgba(255,255,255,0.08)"}`,
                  background: settings.position === p ? "rgba(255,61,0,0.15)" : "transparent",
                  color: settings.position === p ? "#FF6B35" : "#64748B",
                  fontSize: "0.85rem", fontWeight: 600,
                  cursor: "pointer", fontFamily: "'Cairo', sans-serif",
                }}
              >
                {p === "bottom" ? "أسفل ↓" : "أعلى ↑"}
              </button>
            ))}
          </div>
        </Row>
      </div>

      <p
        style={{
          textAlign: "center", color: "#334155",
          fontSize: "0.75rem", marginTop: 24, padding: "0 16px",
        }}
      >
        تُطبَّق الإعدادات فوراً على جميع مقاطع الترجمة
      </p>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
