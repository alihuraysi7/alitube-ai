import { Router } from "express";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { randomUUID } from "crypto";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  type StorageObject,
} from "../lib/objectStorage";
import { ALLOWED_EXT, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, extOf } from "./upload-limits";

// Only objects freshly minted by POST /storage/uploads/request-url (which always
// live under uploads/<uuid>) may be processed. This prevents /whisper — which
// deletes the object after use — from touching arbitrary objects in the bucket.
const UPLOAD_OBJECT_RE = /^\/objects\/uploads\/[0-9a-fA-F-]{36}$/;

// Resolve the artifact root reliably regardless of cwd.
// esbuild bundles everything into dist/index.mjs, so import.meta.url always
// points to that single file → dirname = artifacts/api-server/dist/
// → one ".." up reaches artifacts/api-server/ (the artifact root).
// In dev (ts-node / tsx), this file is at src/routes/whisper.ts
// → dirname = src/routes/ → "../.." = artifacts/api-server/  ✓ same result.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/index.mjs  → dirname = dist/         → ".."   = artifacts/api-server/
// src/routes/...  → dirname = src/routes/   → "../.." = artifacts/api-server/
const ARTIFACT_ROOT = __dirname.endsWith("dist")
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "..", "..");

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

/** Run a subprocess and return stdout; throws on non-zero exit. */
function runProcess(
  cmd: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Process timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/** Extract audio to 16 kHz mono WAV (best for Whisper). */
async function extractAudio(src: string, dst: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-i", src,
    "-ar", "16000",
    "-ac", "1",
    "-f", "wav",
    "-y",
    dst,
  ], 120_000);
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperResult {
  segments: WhisperSegment[];
  language: string;
  language_probability: number;
}

/** Invoke whisper_worker.py and parse its JSON stdout. */
async function runWhisper(audioPath: string): Promise<WhisperResult> {
  const script = path.join(ARTIFACT_ROOT, "whisper_worker.py");
  const raw = await runProcess("python3", [script, audioPath], 300_000);
  const parsed = JSON.parse(raw.trim()) as WhisperResult & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// ── Translation helpers ───────────────────────────────────────────────────────

const SEPARATOR = "\n||||\n";
const MAX_CHUNK = 450;
const MAX_CHUNK_GOOGLE = 3000;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function myMemoryTranslate(text: string, langpair: string): Promise<string> {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    "&langpair=" +
    langpair;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = (await res.json()) as {
    responseData?: { translatedText?: string };
  };
  return data?.responseData?.translatedText ?? text;
}

async function googleTranslate(text: string, sl = "en", tl = "ar"): Promise<string> {
  const url =
    "https://translate.googleapis.com/translate_a/single?" +
    new URLSearchParams({ client: "gtx", sl, tl, dt: "t", q: text }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = (await res.json()) as Array<Array<[string, string]>>;
  if (!Array.isArray(data?.[0])) throw new Error("Unexpected Google Translate response");
  return data[0].map((c) => c[0] ?? "").join("");
}

interface TranslatedSegment extends WhisperSegment {
  arabic: string;
}

type TransLog = { info: (m: string) => void; warn: (m: string) => void };

function looksArabic(s: string): boolean {
  return /[\u0600-\u06FF]/.test(s);
}

/**
 * Translate one (possibly joined) string to Arabic. Tries the preferred engine
 * first, then the other engine, and validates the output actually contains Arabic.
 * Returns null if every engine fails / returns non-Arabic, so the caller never
 * silently keeps the original English without knowing.
 */
async function translateText(
  text: string,
  srcLang: string,
  preferred: "mymemory" | "google",
  log: TransLog,
): Promise<string | null> {
  if (!text.trim()) return text;
  const langpair = `${srcLang}|ar`;
  const order: Array<"mymemory" | "google"> =
    preferred === "google" ? ["google", "mymemory"] : ["mymemory", "google"];
  for (const eng of order) {
    try {
      const out = eng === "google"
        ? await googleTranslate(text, srcLang)
        : await myMemoryTranslate(text, langpair);
      if (out && looksArabic(out)) return out;
      log.warn(`[${eng}] returned non-Arabic output — trying fallback engine`);
    } catch (err) {
      log.warn(`[${eng}] error: ${err instanceof Error ? err.message : String(err)} — trying fallback engine`);
    }
  }
  return null;
}

async function translateSegments(
  segments: WhisperSegment[],
  srcLang: string,
  engine: "mymemory" | "google" = "mymemory",
  log: TransLog,
): Promise<TranslatedSegment[]> {
  // If already Arabic, just echo.
  if (srcLang === "ar") {
    return segments.map((s) => ({ ...s, arabic: s.text }));
  }

  const maxChunk = engine === "google" ? MAX_CHUNK_GOOGLE : MAX_CHUNK;

  const chunks: Array<{ indices: number[]; joined: string }> = [];
  let curIndices: number[] = [];
  let curText = "";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const addition = curText ? SEPARATOR + seg.text : seg.text;
    if (curText && (curText + addition).length > maxChunk) {
      chunks.push({ indices: curIndices, joined: curText });
      curIndices = [i];
      curText = seg.text;
    } else {
      curIndices.push(i);
      curText = curText ? curText + addition : seg.text;
    }
  }
  if (curIndices.length) chunks.push({ indices: curIndices, joined: curText });

  const arabic: string[] = Array(segments.length).fill("");

  for (const chunk of chunks) {
    const translated = await translateText(chunk.joined, srcLang, engine, log);
    const parts = translated !== null ? translated.split(SEPARATOR) : null;

    if (parts && parts.length === chunk.indices.length) {
      chunk.indices.forEach((idx, pos) => {
        arabic[idx] = (parts[pos] ?? segments[idx].text).trim();
      });
    } else {
      // Joined translation failed or line count drifted — translate each line
      // on its own (still cross-engine inside translateText).
      if (translated !== null) {
        log.warn(`Line mismatch in chunk — per-line fallback (${chunk.indices.length} lines)`);
      }
      for (const idx of chunk.indices) {
        const one = await translateText(segments[idx].text, srcLang, engine, log);
        arabic[idx] = (one ?? segments[idx].text).trim();
        await sleep(60);
      }
    }
    await sleep(engine === "google" ? 50 : 300);
  }

  return segments.map((seg, i) => ({ ...seg, arabic: arabic[i] ?? seg.text }));
}

// ── route ─────────────────────────────────────────────────────────────────────

const objectStorageService = new ObjectStorageService();

router.post("/whisper", async (req, res) => {
  let inputPath: string | null = null;
  let audioPath: string | null = null;
  let objectFile: StorageObject | null = null;
  let streaming = false;

  // Once processing starts we stream newline-delimited JSON so the client can
  // show real per-phase progress. Phases: extract → whisper → translate, then
  // a final {"result": ...} line. Validation errors before this stays as plain
  // JSON with the proper HTTP status.
  const sendPhase = (phase: string) => {
    if (!streaming) {
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      streaming = true;
    }
    res.write(JSON.stringify({ phase }) + "\n");
  };

  try {
    // The browser uploads the file directly to object storage via a presigned
    // URL (bypassing the deployment's request-body limit), then calls this route
    // with a small JSON body referencing the stored object.
    const body = (req.body ?? {}) as {
      objectPath?: unknown;
      filename?: unknown;
      engine?: unknown;
    };
    const objectPath = typeof body.objectPath === "string" ? body.objectPath : "";
    const filename = typeof body.filename === "string" ? body.filename : "";

    if (!objectPath || !UPLOAD_OBJECT_RE.test(objectPath)) {
      res.status(400).json({ error: "لم يتم رفع أي ملف." });
      return;
    }

    const ext = extOf(filename);
    if (!ALLOWED_EXT.has(ext)) {
      res.status(400).json({
        error: `نوع ملف غير مدعوم: .${ext} — الأنواع المدعومة: ${[...ALLOWED_EXT].join(", ")}`,
      });
      return;
    }

    // Resolve the object and enforce the real size limit from storage metadata
    // (the client-reported size at URL issuance is not trustworthy).
    objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const [meta] = await objectFile.getMetadata();
    const objSize = Number(meta.size ?? 0);
    if (objSize > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `الملف كبير جداً. الحدّ الأقصى المسموح هو ${MAX_UPLOAD_LABEL}.`,
      });
      return;
    }

    // Pull the uploaded object down to local disk for FFmpeg.
    inputPath = path.join(os.tmpdir(), `whisper-${randomUUID()}.${ext}`);
    audioPath = inputPath + ".wav";
    req.log.info({ ext }, "Downloading uploaded object from storage");
    await objectFile.download({ destination: inputPath });

    // ── Phase: extract audio (server-side FFmpeg, streamed from disk) ──
    req.log.info({ ext }, "Extracting audio with FFmpeg");
    sendPhase("extract");
    if (ext === "wav") {
      await fsp.copyFile(inputPath, audioPath);
    } else {
      await extractAudio(inputPath, audioPath);
    }

    // ── Phase: speech-to-text ──
    req.log.info("Running Whisper (tiny model)");
    sendPhase("whisper");
    const transcript = await runWhisper(audioPath);

    req.log.info(
      { segments: transcript.segments.length, lang: transcript.language },
      "Whisper done — translating to Arabic",
    );

    // ── Phase: translate to Arabic ──
    const useEngine: "mymemory" | "google" = body.engine === "google" ? "google" : "mymemory";
    req.log.info({ engine: useEngine }, "Translation engine");
    sendPhase("translate");

    const translated = await translateSegments(transcript.segments, transcript.language, useEngine, {
      info: (m: string) => req.log.info(m),
      warn: (m: string) => req.log.warn(m),
    });

    res.write(JSON.stringify({
      result: {
        language: transcript.language,
        language_probability: transcript.language_probability,
        segments: translated,
      },
    }) + "\n");
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ err: msg }, "Whisper route error");
    if (streaming || res.headersSent) {
      // Headers already sent — report the failure as a final NDJSON line.
      // The internal message (msg) is logged above only, never sent to the client.
      try { res.write(JSON.stringify({ error: "تعذّرت معالجة الملف. حاول مرة أخرى." }) + "\n"); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    } else if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "تعذّر العثور على الملف المرفوع. حاول الرفع من جديد." });
    } else {
      res.status(500).json({ error: "تعذّرت معالجة الملف. حاول مرة أخرى." });
    }
  } finally {
    if (inputPath) await fsp.unlink(inputPath).catch(() => undefined);
    if (audioPath) await fsp.unlink(audioPath).catch(() => undefined);
    // Best-effort: remove the uploaded object so storage doesn't accumulate.
    if (objectFile) await objectFile.delete().catch(() => undefined);
  }
});

export default router;
