import app from "./app";
import { logger } from "./lib/logger";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Resolve paths relative to this file, not process.cwd() — in production
// the server is started from the workspace root, so cwd() is unreliable.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/index.mjs → artifacts/api-server/
const artifactRoot = path.resolve(__dirname, "..");

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Pre-warm the Whisper model in the background so the first upload
  // request doesn't have to wait for the 39 MB model download.
  const script = path.join(artifactRoot, "whisper_warmup.py");
  const proc = spawn("python3", [script], { stdio: "inherit" });
  proc.on("error", (e) => logger.warn({ err: e.message }, "whisper warmup spawn error"));
  proc.on("close", (code) => {
    if (code === 0) logger.info("Whisper model warm-up complete");
    else logger.warn({ code }, "Whisper warm-up exited with non-zero code");
  });
});

// Uploads (capped at 200 MB, see whisper route) over slow connections plus lengthy server-side
// FFmpeg + Whisper processing must not be cut off by the default timeouts.
// headersTimeout is kept at its default so slow-header clients are still
// rejected; only the body-receive and idle timeouts are lifted.
server.requestTimeout = 0; // no cap on time to receive the full request body
server.timeout = 0;        // no socket inactivity timeout during processing
