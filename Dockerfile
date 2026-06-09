# syntax=docker/dockerfile:1
#
# Railway (and any container host) image for AliTube AI.
# Single web service: the API server serves the built SPA + the /api routes,
# and shells out to `python3` (faster-whisper) and `ffmpeg`/`ffprobe`.

FROM node:24-bookworm-slim

# ---- System dependencies -------------------------------------------------
# python3 + venv  → faster-whisper transcription (app spawns bare `python3`)
# ffmpeg          → provides both `ffmpeg` (audio extract) and `ffprobe` (dubbing)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- Python deps (faster-whisper) ----------------------------------------
# Use a venv and put it first on PATH so the `python3` the server spawns
# resolves to the interpreter that has faster-whisper installed.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
# faster-whisper → speech-to-text;  yt-dlp → download YouTube audio for the
# no-captions transcription fallback (yt-dlp also uses the ffmpeg installed above).
RUN pip install --no-cache-dir "faster-whisper>=1.2.1" "yt-dlp>=2026.3.17"

# ---- pnpm (lockfile is pnpm v10) -----------------------------------------
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# ---- JS deps + build -----------------------------------------------------
# Install full deps (incl. dev — required to build). Use --no-frozen-lockfile
# so the build succeeds whether or not pnpm-lock.yaml is present in the repo
# (a committed lockfile is still used when available; otherwise it's resolved).
# NODE_ENV is intentionally NOT "production" here so devDependencies install.
COPY . .
RUN pnpm install --no-frozen-lockfile

# Build the front-end first (the API serves its static output), then the API.
RUN pnpm --filter @workspace/youtube-arabic run build \
    && pnpm --filter @workspace/api-server run build

# Pre-download the Whisper "tiny" model so the first request isn't delayed by
# the ~39 MB download. Non-fatal: the server also warms up on startup.
RUN python3 artifacts/api-server/whisper_warmup.py || true

# ---- Runtime -------------------------------------------------------------
ENV NODE_ENV=production
# Railway injects PORT at runtime; the server reads process.env.PORT.
EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
