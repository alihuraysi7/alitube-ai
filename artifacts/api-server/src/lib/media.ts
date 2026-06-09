import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Resolve the artifact root reliably regardless of cwd.
// esbuild bundles everything into dist/index.mjs, so import.meta.url points to
// that single file → dirname = artifacts/api-server/dist/ → ".." = artifact root.
// In dev (tsx), this file is at src/lib/media.ts → dirname = src/lib/
// → "../.." = artifacts/api-server/  ✓ same result.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ARTIFACT_ROOT = __dirname.endsWith("dist")
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "..", "..");

/** Run a subprocess and return stdout; throws on non-zero exit. */
export function runProcess(
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

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/** Extract audio to 16 kHz mono WAV (best for Whisper). */
export async function extractAudio(src: string, dst: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-i", src,
    "-ar", "16000",
    "-ac", "1",
    "-f", "wav",
    "-y",
    dst,
  ], 120_000);
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperResult {
  segments: WhisperSegment[];
  language: string;
  language_probability: number;
}

/** Invoke whisper_worker.py and parse its JSON stdout. */
export async function runWhisper(audioPath: string): Promise<WhisperResult> {
  const script = path.join(ARTIFACT_ROOT, "whisper_worker.py");
  const raw = await runProcess("python3", [script, audioPath], 300_000);
  const parsed = JSON.parse(raw.trim()) as WhisperResult & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

/**
 * Download the audio track of a YouTube video and transcode it to a 16 kHz mono
 * WAV at `destWavPath`, ready for Whisper. Uses yt-dlp (invoked via the same
 * `python3` interpreter that hosts faster-whisper) plus ffmpeg for extraction.
 *
 * NOTE: YouTube can refuse downloads from datacenter/server IPs (bot checks),
 * especially from cloud hosts. The caller treats any failure here as a normal
 * "couldn't transcribe" outcome rather than a crash.
 */
export async function downloadYoutubeAudio(
  videoUrl: string,
  destWavPath: string,
): Promise<void> {
  if (!destWavPath.endsWith(".wav")) {
    throw new Error("downloadYoutubeAudio: destWavPath must end with .wav");
  }
  // yt-dlp expands the output template; with `-x --audio-format wav` the final
  // file is "<base>.wav", which we point straight at destWavPath.
  const base = destWavPath.slice(0, -".wav".length);
  const outTemplate = `${base}.%(ext)s`;

  const args = [
    "-m", "yt_dlp",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "wav",
    // resample to what Whisper expects during yt-dlp's ffmpeg post-processing
    "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "-o", outTemplate,
  ];

  // YouTube challenges anonymous downloads from datacenter/cloud IPs with a
  // "confirm you're not a bot" wall. Supplying the user's exported cookies
  // (Netscape cookies.txt format, stored in the YOUTUBE_COOKIES secret) lets
  // yt-dlp authenticate and bypass that wall. Without cookies we still try —
  // it works from un-flagged IPs — but it usually fails on hosted servers.
  const cookieFile = getCookieFile();
  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  args.push(videoUrl);

  await runProcess("python3", args, 180_000);
}

// Lazily materialise the cookies.txt from the YOUTUBE_COOKIES secret to a 0600
// file inside a randomly-named private temp dir the first time it's needed, and
// schedule its removal on process exit. Returns null when the secret is unset.
let cachedCookiePath: string | null | undefined;
function getCookieFile(): string | null {
  if (cachedCookiePath !== undefined) return cachedCookiePath;
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw || !raw.trim()) {
    cachedCookiePath = null;
    return null;
  }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytc-"));
    const p = path.join(dir, "cookies.txt");
    fs.writeFileSync(p, raw.endsWith("\n") ? raw : raw + "\n", { mode: 0o600 });
    process.once("exit", () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    cachedCookiePath = p;
  } catch {
    cachedCookiePath = null;
  }
  return cachedCookiePath;
}
