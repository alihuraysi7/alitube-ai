import { Router, type IRouter } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const router: IRouter = Router();

const TTS_CACHE_DIR = path.resolve("cache", "tts");
if (!fs.existsSync(TTS_CACHE_DIR)) {
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

// ElevenLabs text-to-speech. Uses the user's own ELEVENLABS_API_KEY (raw fetch,
// matching the existing external-service pattern in this codebase — no SDK, no codegen).
const TTS_MODEL = "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";

// Allowlist of premade ElevenLabs voices offered for Arabic dubbing. The client
// may only request one of these — guards against arbitrary voice ids.
const ALLOWED_VOICES: Record<string, true> = {
  "21m00Tcm4TlvDq8ikWAM": true, // Rachel  (أنثى)
  EXAVITQu4vr4xnSDxMaL: true,   // Bella   (أنثى)
  pNInz6obpgDQGcFmaJgB: true,   // Adam    (ذكر)
  ErXwobaYiN019PkySvjV: true,   // Antoni  (ذكر)
};
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

const MAX_SEGMENTS_PER_REQUEST = 24;
const MAX_TEXT_LEN = 800;

interface TtsSegmentInput {
  index: number;
  text: string;
}

interface TtsClipOutput {
  index: number;
  audio: string | null; // base64 mp3, or null when empty / failed
}

function cacheKey(voiceId: string, text: string): string {
  return crypto
    .createHash("sha1")
    .update(`${TTS_MODEL}|${voiceId}|${text}`)
    .digest("hex");
}

class ElevenLabsTtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function synthesize(text: string, voiceId: string, apiKey: string): Promise<Buffer> {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ElevenLabsTtsError(resp.status, body.slice(0, 200));
  }

  return Buffer.from(await resp.arrayBuffer());
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

router.post("/tts", async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "خدمة الدبلجة غير مُهيّأة — مفتاح ElevenLabs غير موجود.",
    });
    return;
  }

  const body = req.body as { segments?: unknown; voiceId?: unknown };
  const rawSegments = Array.isArray(body.segments) ? body.segments : null;
  if (!rawSegments) {
    res.status(400).json({ error: "segments array is required" });
    return;
  }
  if (rawSegments.length > MAX_SEGMENTS_PER_REQUEST) {
    res.status(400).json({
      error: `Too many segments — max ${MAX_SEGMENTS_PER_REQUEST} per request`,
    });
    return;
  }

  const voiceId =
    typeof body.voiceId === "string" && ALLOWED_VOICES[body.voiceId]
      ? body.voiceId
      : DEFAULT_VOICE;

  const segments: TtsSegmentInput[] = [];
  for (const s of rawSegments) {
    const seg = s as { index?: unknown; text?: unknown };
    if (typeof seg.index !== "number" || typeof seg.text !== "string") {
      res.status(400).json({ error: "each segment needs numeric index and string text" });
      return;
    }
    segments.push({ index: seg.index, text: seg.text.slice(0, MAX_TEXT_LEN) });
  }

  let fatal: ElevenLabsTtsError | null = null;

  const clips = await mapLimit<TtsSegmentInput, TtsClipOutput>(
    segments,
    3,
    async (seg) => {
      const text = seg.text.trim();
      if (!text) return { index: seg.index, audio: null };

      const file = path.join(TTS_CACHE_DIR, `${cacheKey(voiceId, text)}.mp3`);

      // Serve from disk cache when available
      try {
        if (fs.existsSync(file)) {
          const buf = await fs.promises.readFile(file);
          return { index: seg.index, audio: buf.toString("base64") };
        }
      } catch {
        /* fall through to regenerate */
      }

      if (fatal) return { index: seg.index, audio: null };

      try {
        const buf = await synthesize(text, voiceId, apiKey);
        await fs.promises.writeFile(file, buf).catch(() => undefined);
        return { index: seg.index, audio: buf.toString("base64") };
      } catch (err) {
        if (err instanceof ElevenLabsTtsError && (err.status === 401 || err.status === 429)) {
          // Auth or quota failure affects every clip — remember and stop hitting the API
          fatal = err;
        }
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err), index: seg.index },
          "TTS segment failed",
        );
        return { index: seg.index, audio: null };
      }
    },
  );

  if (fatal) {
    const status = (fatal as ElevenLabsTtsError).status;
    if (status === 401) {
      res.status(502).json({ error: "مفتاح ElevenLabs غير صالح — تحقق من المفتاح." });
    } else {
      res.status(502).json({ error: "تم تجاوز حد ElevenLabs — لا يمكن توليد الصوت حالياً." });
    }
    return;
  }

  res.json({ clips });
});

/* ── Download: stitch cached per-segment clips into one timed MP3 ──────────── */

const MAX_DOWNLOAD_SEGMENTS = 2000;

interface DownloadSegmentInput {
  start: number;
  text: string;
}

/** Path of the cached clip for a segment, mirroring the /tts cache logic exactly. */
function clipPath(voiceId: string, rawText: string): string {
  const text = rawText.slice(0, MAX_TEXT_LEN).trim();
  if (!text) return "";
  return path.join(TTS_CACHE_DIR, `${cacheKey(voiceId, text)}.mp3`);
}

/** Read an MP3's duration (seconds) via ffprobe; 0 on any failure. */
function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
    p.on("error", () => resolve(0));
  });
}

router.post("/tts/download", async (req, res) => {
  const body = req.body as { segments?: unknown; voiceId?: unknown };
  const rawSegments = Array.isArray(body.segments) ? body.segments : null;
  if (!rawSegments) {
    res.status(400).json({ error: "segments array is required" });
    return;
  }
  if (rawSegments.length > MAX_DOWNLOAD_SEGMENTS) {
    res.status(400).json({
      error: `عدد المقاطع كبير جداً — الحد الأقصى ${MAX_DOWNLOAD_SEGMENTS}.`,
    });
    return;
  }

  const voiceId =
    typeof body.voiceId === "string" && ALLOWED_VOICES[body.voiceId]
      ? body.voiceId
      : DEFAULT_VOICE;

  const segments: DownloadSegmentInput[] = [];
  for (const s of rawSegments) {
    const seg = s as { start?: unknown; text?: unknown };
    if (typeof seg.start !== "number" || typeof seg.text !== "string") {
      res.status(400).json({ error: "each segment needs numeric start and string text" });
      return;
    }
    segments.push({ start: Math.max(0, seg.start), text: seg.text });
  }

  // Collect only segments whose clip is already cached (download is offered once
  // dubbing has been prepared, so every non-empty clip should be on disk).
  const cached: { start: number; file: string }[] = [];
  for (const seg of segments) {
    const file = clipPath(voiceId, seg.text);
    if (file && fs.existsSync(file)) cached.push({ start: seg.start, file });
  }

  if (cached.length === 0) {
    res.status(409).json({
      error: "لم يتم تجهيز الدبلجة بعد — شغّل الدبلجة أولاً ثم نزّل الصوت.",
    });
    return;
  }

  // Lay clips on a timeline: each starts at its segment start, but never before
  // the previous clip ends (avoids overlapping voices for overlapping captions).
  const durations = await mapLimit(cached, 4, (c) => probeDuration(c.file));
  const items = cached
    .map((c, i) => ({ ...c, dur: durations[i] }))
    .sort((a, b) => a.start - b.start);

  let cursor = 0;
  const delaysMs: number[] = items.map((it) => {
    const delay = Math.max(it.start, cursor);
    cursor = delay + it.dur;
    return Math.round(delay * 1000);
  });

  // Build a single ffmpeg invocation: delay each clip, then mix (no overlap, so
  // normalize=0 keeps original loudness without clipping).
  const args: string[] = ["-y"];
  for (const it of items) args.push("-i", it.file);

  const labels = items.map((_, i) => `[a${i}]`);
  const parts = items.map(
    (_, i) => `[${i}:a]adelay=delays=${delaysMs[i]}:all=1${labels[i]}`,
  );
  let filter: string;
  let mapLabel: string;
  if (items.length === 1) {
    filter = parts[0];
    mapLabel = "[a0]";
  } else {
    filter =
      parts.join(";") +
      ";" +
      labels.join("") +
      `amix=inputs=${items.length}:normalize=0:dropout_transition=0:duration=longest[out]`;
    mapLabel = "[out]";
  }

  args.push(
    "-filter_complex", filter,
    "-map", mapLabel,
    "-c:a", "libmp3lame",
    "-q:a", "4",
    "-f", "mp3",
    "pipe:1",
  );

  const ff = spawn("ffmpeg", args);
  const chunks: Buffer[] = [];
  let stderr = "";
  ff.stdout.on("data", (d: Buffer) => chunks.push(d));
  ff.stderr.on("data", (d) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  ff.on("error", (err) => {
    req.log.error({ err: err.message }, "ffmpeg spawn failed for dub download");
    if (!res.headersSent) {
      res.status(500).json({ error: "تعذّر دمج الصوت — حدث خطأ في الخادم." });
    }
  });
  ff.on("close", (code) => {
    if (res.headersSent) return;
    if (code !== 0 || chunks.length === 0) {
      req.log.error({ code, stderr: stderr.slice(0, 1000) }, "ffmpeg dub stitch failed");
      res.status(500).json({ error: "تعذّر دمج الصوت — حاول مرة أخرى." });
      return;
    }
    const out = Buffer.concat(chunks);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", out.length);
    res.setHeader("Content-Disposition", 'attachment; filename="dubbed-audio.mp3"');
    res.end(out);
  });
});

export default router;
