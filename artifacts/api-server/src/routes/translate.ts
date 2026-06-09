import { Router, type IRouter } from "express";
import {
  YoutubeTranscript,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

import fs, { promises as fsp } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { downloadYoutubeAudio, runWhisper } from "../lib/media";

const router: IRouter = Router();

const CACHE_DIR = path.resolve("cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCachePath(videoId: string, engine: string): string {
  return path.join(CACHE_DIR, `${videoId}_ar_${engine}_v1.json`);
}

type RawEntry = { text: string; duration: number; offset: number };

/**
 * Mirrors the Python YouTubeTranscriptApi.list_transcripts() fallback chain:
 *
 * 1. Try manual English subtitles (en, en-US, en-GB)
 * 2. Try auto-generated English subtitles via same codes
 *    (the package tries both; NotAvailableLanguageError tells us what IS available)
 * 3. Iterate available languages and pick the first en* variant
 * 4. Fall back to no-lang (picks the first track — catches auto-generated captions)
 * 5. Only then raise "No English subtitles found"
 */
async function fetchEnglishTranscript(
  videoId: string,
  log: { info: (m: string) => void; warn: (m: string) => void }
): Promise<RawEntry[]> {
  const manualCodes = ["en", "en-US", "en-GB"];

  // Step 1 & 2 — try explicit English codes (covers both manual and auto-generated)
  log.info("Trying manual/auto-generated English transcript...");
  for (const lang of manualCodes) {
    try {
      const t = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      if (t && t.length > 0) {
        log.info(`Selected transcript: ${lang}`);
        return t;
      }
    } catch (err) {
      if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
        // Step 3 — parse available language codes from the error message and
        // look for any en* variant we haven't tried yet
        const msg = err.message;
        const afterColon = msg.split("Available languages:")[1] ?? "";
        const available = afterColon
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        log.info(`Trying generated English transcript... (available: ${available.join(", ")})`);

        const enVariant = available.find(
          (code) => code.startsWith("en") && !manualCodes.includes(code)
        );
        if (enVariant) {
          try {
            const t = await YoutubeTranscript.fetchTranscript(videoId, { lang: enVariant });
            if (t && t.length > 0) {
              log.info(`Selected transcript: ${enVariant}`);
              return t;
            }
          } catch { /* fall through */ }
        }
        // No en* variant found in this error — keep trying other manualCodes
      }
      // For any other error (disabled, unavailable, network) keep trying next code
    }
  }

  // Step 4 — no-lang fallback: the package picks the first caption track,
  // which includes auto-generated captions even when explicit lang codes fail
  log.info("Trying generated English transcript (no-lang fallback)...");
  try {
    const t = await YoutubeTranscript.fetchTranscript(videoId);
    if (t && t.length > 0) {
      log.info("Selected transcript: (first available)");
      return t;
    }
  } catch (err) {
    if (
      err instanceof YoutubeTranscriptDisabledError ||
      err instanceof YoutubeTranscriptNotAvailableError
    ) {
      throw new Error("DISABLED");
    }
    if (err instanceof YoutubeTranscriptVideoUnavailableError) {
      throw new Error("UNAVAILABLE");
    }
    throw err;
  }

  // Step 5
  throw new Error("NO_EN_SUBTITLES");
}

function extractVideoId(url: string): string | null {
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const pattern =
    /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:[^/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|shorts\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = trimmed.match(pattern);
  return match ? match[1] : null;
}

/**
 * youtube-transcript has two parse paths:
 *  - srv3/InnerTube: parseInt → integers in MILLISECONDS
 *  - classic XML fallback: parseFloat → decimals already in SECONDS
 * Detect by presence of fractional parts.
 */
function normaliseTimings(
  raw: Array<{ text: string; duration: number; offset: number }>
): Array<{ text: string; start: number; duration: number }> {
  const hasDecimals = raw.some((t) => t.offset % 1 !== 0 || t.duration % 1 !== 0);
  const toSeconds = hasDecimals ? (v: number) => v : (v: number) => v / 1000;
  return raw.map((t) => ({
    text: t.text.replace(/\n/g, " ").trim(),
    start: toSeconds(t.offset),
    duration: toSeconds(t.duration),
  }));
}

interface SubtitleEntry {
  index: number;
  start: number;
  duration: number;
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Translate a single text string via MyMemory API (free, no API key needed).
 * MyMemory accepts up to 500 chars per request.
 */
async function myMemoryTranslate(text: string): Promise<string> {
  const url =
    "https://api.mymemory.translated.net/get?" +
    new URLSearchParams({ q: text, langpair: "en|ar" }).toString();

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`MyMemory HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    responseStatus: number;
    responseData: { translatedText: string };
    responseDetails?: string;
  };

  if (data.responseStatus !== 200) {
    throw new Error(`MyMemory error ${data.responseStatus}: ${data.responseDetails ?? ""}`);
  }

  return data.responseData.translatedText;
}

/**
 * Translate via unofficial Google Translate API (free, no key needed).
 * Handles up to ~5000 chars per request — much higher than MyMemory.
 */
async function googleTranslate(text: string, sl = "en", tl = "ar"): Promise<string> {
  const url =
    "https://translate.googleapis.com/translate_a/single?" +
    new URLSearchParams({ client: "gtx", sl, tl, dt: "t", q: text }).toString();

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`Google Translate HTTP ${resp.status}`);

  // Response shape: [[[chunk, original], ...], ...]
  const data = (await resp.json()) as Array<Array<[string, string]>>;
  if (!Array.isArray(data?.[0])) throw new Error("Unexpected Google Translate response");
  return data[0].map((c) => c[0] ?? "").join("");
}

/**
 * Group subtitle entries into chunks under the char budget, translate each chunk
 * as one request, then split back on the separator. Falls back to per-line, and
 * — critically — falls back to the OTHER translation engine before ever giving up
 * and returning the original English text. Output is validated to actually contain
 * Arabic so a silently-failing API can never leave subtitles in English.
 */
const SEP = "\n||||\n";
const MAX_CHARS = 450;
const MAX_CHARS_GOOGLE = 3000;

type TransLog = { info: (m: string) => void; warn: (m: string) => void };
type Engine = "mymemory" | "google";

function looksArabic(s: string): boolean {
  return /[\u0600-\u06FF]/.test(s);
}

function hasLatinLetters(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

/**
 * Translate one (possibly joined) string. Tries the preferred engine first, then
 * the other engine. Returns Arabic text, or null if every engine failed or
 * returned non-Arabic output. Empty/whitespace input is returned untouched.
 */
async function translateText(
  text: string,
  preferred: Engine,
  log: TransLog
): Promise<string | null> {
  if (!text.trim()) return text;
  const order: Engine[] = preferred === "google" ? ["google", "mymemory"] : ["mymemory", "google"];
  for (const eng of order) {
    try {
      const out = eng === "google" ? await googleTranslate(text) : await myMemoryTranslate(text);
      if (out && looksArabic(out)) return out;
      log.warn(`[${eng}] returned non-Arabic output — trying fallback engine`);
    } catch (err) {
      log.warn(`[${eng}] error: ${err instanceof Error ? err.message : String(err)} — trying fallback engine`);
    }
  }
  return null;
}

/**
 * Translate all entries to Arabic. Returns the translated entries plus the count
 * of lines that could not be translated (so the caller can avoid caching a
 * failed/English result).
 */
async function translateAll(
  entries: SubtitleEntry[],
  preferred: Engine,
  log: TransLog
): Promise<{ results: SubtitleEntry[]; failures: number }> {
  const maxChars = preferred === "google" ? MAX_CHARS_GOOGLE : MAX_CHARS;

  // Build groups that fit within the char budget
  const groups: SubtitleEntry[][] = [];
  let current: SubtitleEntry[] = [];
  let currentLen = 0;

  for (const entry of entries) {
    const addLen = entry.text.length + SEP.length;
    if (current.length > 0 && currentLen + addLen > maxChars) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(entry);
    currentLen += addLen;
  }
  if (current.length > 0) groups.push(current);

  const results: SubtitleEntry[] = [];
  let failures = 0;
  const total = groups.length;

  for (let g = 0; g < total; g++) {
    const group = groups[g];
    log.info(`Translating group ${g + 1}/${total} (${group.length} lines)`);

    const texts = group.map((e) => e.text);
    const joined = texts.join(SEP);

    let lines: string[] | null = null;

    const joinedOut = await translateText(joined, preferred, log);
    if (joinedOut !== null) {
      const parts = joinedOut.split(SEP);
      if (parts.length === texts.length) {
        lines = parts.map((p) => p.trim());
      } else {
        log.warn(`Line mismatch: expected ${texts.length}, got ${parts.length} — per-line fallback`);
      }
    }

    if (!lines) {
      // Per-line fallback — translateText still tries both engines per line.
      lines = [];
      for (const t of texts) {
        const out = await translateText(t, preferred, log);
        lines.push(out ?? t);
        await sleep(80);
      }
    }

    for (let i = 0; i < group.length; i++) {
      const arabicText = lines[i] ?? group[i].text;
      // A line is "failed" only if it had real (Latin) words but came back without Arabic.
      if (hasLatinLetters(group[i].text) && !looksArabic(arabicText)) failures++;
      results.push({ ...group[i], text: arabicText });
    }

    if (g < total - 1) await sleep(preferred === "google" ? 50 : 120);
  }

  return { results, failures };
}

/**
 * Fallback for videos with no captions: download the audio with yt-dlp and run
 * Whisper on it. Returns subtitle entries plus the detected source language so
 * the caller can skip translation when the speech is already Arabic.
 */
async function transcribeViaWhisper(
  videoId: string,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<{ entries: SubtitleEntry[]; language: string }> {
  // Always feed yt-dlp a canonical watch URL built from the validated ID. This
  // also covers raw 11-char ID inputs (which extractVideoId accepts) and Shorts
  // URLs, which yt-dlp resolves fine via the watch?v= form.
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const baseName = `yt-${videoId}-${randomUUID()}`;
  const wavPath = path.join(os.tmpdir(), `${baseName}.wav`);
  try {
    log.info("Downloading audio with yt-dlp...");
    await downloadYoutubeAudio(canonicalUrl, wavPath);
    log.info("Transcribing audio with Whisper (tiny model)...");
    const transcript = await runWhisper(wavPath);
    const entries: SubtitleEntry[] = transcript.segments.map((s, i) => ({
      index: i,
      start: s.start,
      duration: Math.max(0, s.end - s.start),
      text: s.text,
    }));
    return { entries, language: transcript.language };
  } finally {
    // Remove the wav plus any yt-dlp intermediates (.part/.webm/etc.) that may
    // be left behind on a failed/aborted download, all sharing the base name.
    const dir = os.tmpdir();
    await fsp
      .readdir(dir)
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith(baseName))
            .map((n) => fsp.unlink(path.join(dir, n)).catch(() => undefined)),
        ),
      )
      .catch(() => undefined);
  }
}

router.post("/translate", async (req, res) => {
  const { video_url, engine = "mymemory" } = req.body as { video_url?: string; engine?: string };
  if (!video_url || typeof video_url !== "string") {
    res.status(400).json({ error: "رابط الفيديو مطلوب." });
    return;
  }

  const videoId = extractVideoId(video_url.trim());
  if (!videoId) {
    res.status(400).json({ error: "رابط YouTube غير صالح." });
    return;
  }

  const useEngine = engine === "google" ? "google" : "mymemory";

  const log = {
    info: (msg: string) => req.log.info(msg),
    warn: (msg: string) => req.log.warn(msg),
  };

  // Return cached result immediately if available (per-engine cache)
  const cachePath = getCachePath(videoId, useEngine);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      res.json({ video_id: videoId, videoId, subtitles: cached, cached: true });
      return;
    } catch {
      fs.unlinkSync(cachePath);
    }
  }

  // Build subtitle entries: prefer existing YouTube captions, then fall back to
  // downloading the audio and transcribing it with Whisper (for the many videos
  // — especially Shorts — that have no captions at all).
  let entries: SubtitleEntry[];
  let needsTranslation = true;
  try {
    const rawTranscript = await fetchEnglishTranscript(videoId, log);
    const normalised = normaliseTimings(rawTranscript);
    entries = normalised.map((t, i) => ({
      index: i,
      start: t.start,
      duration: t.duration,
      text: t.text,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "UNAVAILABLE") {
      res.status(400).json({ error: "هذا الفيديو غير متاح أو غير موجود." });
      return;
    }
    if (msg !== "DISABLED" && msg !== "NO_EN_SUBTITLES") {
      res.status(400).json({
        error: "تعذّر جلب الترجمة. قد يكون الفيديو خاصًا أو مقيّد العمر أو غير متاح.",
      });
      return;
    }

    // No captions on YouTube → transcribe the audio with Whisper.
    log.info("No captions available — falling back to Whisper transcription");
    try {
      const transcribed = await transcribeViaWhisper(videoId, log);
      entries = transcribed.entries;
      needsTranslation = transcribed.language !== "ar";
    } catch (wErr) {
      log.warn(
        `Whisper fallback failed: ${wErr instanceof Error ? wErr.message : String(wErr)}`,
      );
      res.status(400).json({
        error:
          "لا توجد ترجمة لهذا الفيديو، وتعذّر تفريغ الصوت تلقائيًا. غالبًا يمنع YouTube التنزيل من الخادم — يلزم إعداد ملفات تعريف الارتباط (cookies) لتفعيل التفريغ التلقائي.",
      });
      return;
    }
  }

  if (!entries || entries.length === 0) {
    res.status(400).json({ error: "لا توجد ترجمة إنجليزية لهذا الفيديو." });
    return;
  }

  let translated: SubtitleEntry[];
  let failures: number;
  if (needsTranslation) {
    try {
      log.info(`Using translation engine: ${useEngine}`);
      ({ results: translated, failures } = await translateAll(entries, useEngine, log));
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "فشلت الترجمة. يرجى المحاولة مرة أخرى.", details });
      return;
    }
  } else {
    // Whisper already produced Arabic text — no translation needed.
    log.info("Transcription already Arabic — skipping translation");
    translated = entries;
    failures = 0;
  }

  const subtitles = translated.map(({ start, duration, text }) => ({ start, duration, text }));

  // Only cache a fully-successful translation. Caching a result that fell back to
  // English would serve stale English forever on every re-run for this video.
  if (failures === 0) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(subtitles, null, 2), "utf-8");
    } catch { /* non-fatal */ }
  } else {
    log.warn(`Skipping cache for ${videoId} (${useEngine}): ${failures} line(s) not translated to Arabic`);
  }

  res.json({ video_id: videoId, videoId, subtitles, cached: false });
});

export default router;
