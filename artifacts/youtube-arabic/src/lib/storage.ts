/* ── Types ───────────────────────────────────────────────────── */

export interface SubtitleSettings {
  fontSize: number;          // 12–32
  color: string;             // hex, e.g. "#ffffff"
  bgOpacity: number;         // 0–1
  fontFamily: "tajawal" | "cairo";
  position: "bottom" | "top";
  bold: boolean;
  shadow: boolean;
  translationEngine: "mymemory" | "google";
  dubbingVoice: string;      // ElevenLabs voice id used for optional Arabic dubbing
  dubbingEnabled: boolean;   // default on/off preference for dubbing (off by default)
  hideSubsWhileDubbing: boolean; // hide on-screen + exported subtitles while dubbing is active
}

export const DEFAULT_SETTINGS: SubtitleSettings = {
  fontSize: 20,
  color: "#ffffff",
  bgOpacity: 0.82,
  fontFamily: "tajawal",
  position: "bottom",
  bold: true,
  shadow: true,
  translationEngine: "mymemory",
  dubbingVoice: "21m00Tcm4TlvDq8ikWAM",
  dubbingEnabled: false,
  hideSubsWhileDubbing: false,
};

/* Premade ElevenLabs voices offered for Arabic dubbing (must match server allowlist) */
export const DUBBING_VOICES: { id: string; label: string; gender: string }[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "راشيل",  gender: "أنثى" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "بيلا",   gender: "أنثى" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "آدم",    gender: "ذكر" },
  { id: "ErXwobaYiN019PkySvjV", label: "أنطوني", gender: "ذكر" },
];

export interface HistoryItem {
  id: string;
  type: "youtube" | "whisper";
  title: string;
  date: number;
  isFavorite: boolean;
  /* YouTube */
  videoId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subtitles?: any[];
  /* Whisper */
  fileName?: string;
  segments?: Array<{ start: number; end: number; english: string; arabic: string }>;
}

/* ── Keys ────────────────────────────────────────────────────── */
const SETTINGS_KEY = "ali-yt-settings";
const HISTORY_KEY  = "ali-yt-history";
const MAX_HISTORY  = 40;

/* ── Settings ────────────────────────────────────────────────── */
export function loadSettings(): SubtitleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: SubtitleSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  window.dispatchEvent(new Event("ali-settings-changed"));
}

/* ── History ─────────────────────────────────────────────────── */
export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

export function addHistoryItem(item: Omit<HistoryItem, "id" | "date" | "isFavorite">) {
  const items = loadHistory();
  const newItem: HistoryItem = {
    ...item,
    id: Date.now().toString(),
    date: Date.now(),
    isFavorite: false,
  };
  const updated = [newItem, ...items].slice(0, MAX_HISTORY);
  persistHistory(updated);
}

export function toggleFavorite(id: string) {
  const items = loadHistory().map(i =>
    i.id === id ? { ...i, isFavorite: !i.isFavorite } : i
  );
  persistHistory(items);
}

export function deleteHistoryItem(id: string) {
  persistHistory(loadHistory().filter(i => i.id !== id));
}

export function clearHistory() {
  persistHistory([]);
}
