# Deployment Guide

How AliTube AI is built and served, how it runs on Replit, and **exact step-by-step instructions to run it outside Replit**.

---

## How the app is served

The app runs as **a single Node process in production**:

1. The front-end (`artifacts/youtube-arabic`) is built to static files (`artifacts/youtube-arabic/dist/public`).
2. The API server (`artifacts/api-server`) is bundled with esbuild to `artifacts/api-server/dist/index.mjs`.
3. In production (`NODE_ENV=production`) the API server:
   - serves the static SPA from `youtube-arabic/dist/public`,
   - serves the API under `/api/*`,
   - returns `index.html` for client-side routes.
4. In development (`NODE_ENV=development`) the API server instead **proxies** non-`/api` requests to the Vite dev server (`VITE_PORT`, default `24245`), so you run two processes.

Health check endpoint: `GET /api/healthz`.

---

## Build commands

```bash
# Build front-end, then API bundle (order matters — API serves the SPA output)
pnpm --filter @workspace/youtube-arabic run build
pnpm --filter @workspace/api-server run build

# Start the production server (serves SPA + API on one port)
PORT=8080 NODE_ENV=production node --enable-source-maps artifacts/api-server/dist/index.mjs
```

---

## Deploying on Replit (current setup)

The project is configured as an **Autoscale** deployment with a single API service that also serves the built SPA.

- Production build: builds `youtube-arabic` then `api-server` (`NODE_ENV=production`).
- Production run: `node --enable-source-maps artifacts/api-server/dist/index.mjs` on `PORT=8080`.
- Health check: `/api/healthz`.
- Object storage is provisioned automatically (env vars injected by Replit).

To deploy: open the Replit **Publish/Deploy** panel and publish. Set `ELEVENLABS_API_KEY` in the deployment's secrets if you want dubbing in production.

> **Autoscale request-body limit:** the Replit Autoscale edge rejects request bodies **≥ 32 MiB**. This is exactly why file uploads go **directly to object storage** via a presigned URL instead of through `/api/whisper`. Keep this design if you stay on Autoscale. A Reserved VM deployment does not have this limit.

---

## Deploying on Railway

Railway builds from the committed **`Dockerfile`** (Node 24 + Python 3.11 + FFmpeg + faster-whisper) and reads **`railway.json`** for the start command and health check. The whole app runs as **one web service** — no separate Python service is needed.

### One-time setup

1. In Railway, create a project → **Deploy from GitHub repo** → select `alihuraysi7/alitube-ai`. Railway auto-detects the `Dockerfile` (no build/start command to type in the UI).
2. Open the service → **Variables** and add the environment variables below. **Do not set `PORT`** — Railway injects it automatically and the server reads it.
3. Deploy. Railway builds the image, waits for the health check at `/api/healthz`, then routes public traffic to it.
4. *(Optional, recommended)* Add a **Volume** mounted at `/app/artifacts/api-server/cache` so the translation/TTS disk cache survives restarts and redeploys.

### Build & start commands

You normally don't type these into Railway — the `Dockerfile` and `railway.json` provide them — but for reference:

- **Build (inside the Dockerfile):**
  ```bash
  pnpm install --no-frozen-lockfile   # tolerates a missing pnpm-lock.yaml
  pnpm --filter @workspace/youtube-arabic run build
  pnpm --filter @workspace/api-server run build
  pip install "faster-whisper>=1.2.1"   # into the image's Python venv
  ```
- **Start (from `railway.json`):**
  ```bash
  node --enable-source-maps artifacts/api-server/dist/index.mjs
  ```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | auto | Injected by Railway — **never set it yourself**. The server fails to boot if it's missing, which Railway handles for you. |
| `NODE_ENV` | no | Baked as `production` in the image. |
| `ELEVENLABS_API_KEY` | only for dubbing | Enables Arabic voice dubbing. Without it, dubbing is off; subtitles still work. |
| `YOUTUBE_COOKIES` | only for no-caption YouTube videos | Netscape `cookies.txt` contents (paste the whole file). When a YouTube video has **no** subtitles, the server downloads its audio with yt-dlp and transcribes it with Whisper — but YouTube blocks anonymous downloads from cloud/datacenter IPs with a "confirm you're not a bot" wall. Supplying your exported YouTube cookies lets yt-dlp authenticate and bypass it. Without this, the no-caption fallback usually fails on hosted servers. Cookies expire periodically and must be refreshed. |
| `S3_ENDPOINT` | only for file uploads | S3-compatible endpoint (e.g. Cloudflare R2). |
| `S3_REGION` | optional | `auto` for R2; the real region for AWS S3. |
| `S3_BUCKET` | only for file uploads | Bucket name. |
| `S3_ACCESS_KEY_ID` | only for file uploads | Access key ID. |
| `S3_SECRET_ACCESS_KEY` | only for file uploads | Secret access key. |
| `S3_PUBLIC_BASE_URL` | optional | Public/CDN base URL for the bucket. |

> The **YouTube-URL translator** needs **no** env vars for videos that already have subtitles. Videos with **no** subtitles fall back to downloading + transcribing the audio, which needs `YOUTUBE_COOKIES` to get past YouTube's bot wall on hosted servers. **Dubbing** needs `ELEVENLABS_API_KEY`. **File uploads** need the `S3_*` vars — the Replit object-storage fallback does **not** work on Railway (there is no Replit sidecar off-platform). See *Object storage outside Replit* below for Cloudflare R2 setup.

### Known limitations on Railway

- **CPU transcription is slow for long videos.** Whisper runs the `tiny` model on CPU with a 300 s per-job timeout, so feature-length videos won't finish in a single request (this needs a background-job architecture, not yet implemented).
- **Free translation rate limits.** The free Google/MyMemory engines rate-limit (HTTP 429) on very large transcripts; results are cached on disk to reduce repeat calls.
- **Ephemeral filesystem.** Uploaded temp files and the on-disk translation/TTS cache are wiped on restart/redeploy unless you mount a volume at the cache path (see step 4).
- **No 32 MiB body cap** (unlike Replit Autoscale), but uploads still go direct-to-storage via a presigned URL, so the `S3_*` vars are still required for the upload feature.
- **Image size & first build.** The image bundles Node, Python, FFmpeg, and the JS/Python dependencies (~1–2 GB total), so the first build takes a few minutes; subsequent builds are faster via layer caching. The Dockerfile also best-effort pre-downloads the Whisper `tiny` model (~39 MB) so the first request isn't delayed; if that step is skipped the server downloads it on the first transcription instead.

---

## Running outside Replit

You can run AliTube AI on any Linux/macOS/Windows machine or VM. There is **one Replit-specific dependency** — object storage — which only affects the **file-upload** feature. The **YouTube-URL translation** and **dubbing** features work anywhere.

### Step 0 — Install prerequisites

Install Node 24, pnpm, Python 3.11, and FFmpeg (see `REQUIREMENTS.md` for OS-specific commands). Verify:

```bash
node -v          # v24.x
pnpm -v
python3 --version  # 3.11.x
ffmpeg -version
ffprobe -version
```

### Step 1 — Get the code and install dependencies

```bash
git clone https://github.com/alihuraysi7/alitube-ai.git
cd alitube-ai

# JavaScript deps (all workspace packages)
pnpm install

# Python transcription dep
pip install "faster-whisper>=1.2.1"     # or: uv sync
```

### Step 2 — Configure environment

Create a `.env` (or export in your shell). Minimum for the YouTube-URL feature:

```bash
export PORT=8080
export NODE_ENV=production
```

Add for **dubbing**:
```bash
export ELEVENLABS_API_KEY=your_elevenlabs_key
```

Add for **no-caption YouTube videos** (audio download + Whisper transcription). Export your YouTube `cookies.txt` so yt-dlp can get past the bot wall:
```bash
export YOUTUBE_COOKIES="$(cat cookies.txt)"
```

Add for **file uploads** (see "Object storage outside Replit" below). Pick **one** backend:

**Option A — S3-compatible storage (Cloudflare R2, AWS S3, MinIO)** — recommended off Replit:
```bash
export S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
export S3_REGION=auto                       # "auto" for R2; the region name for AWS S3
export S3_BUCKET=alitube
export S3_ACCESS_KEY_ID=your_access_key_id
export S3_SECRET_ACCESS_KEY=your_secret_access_key
export S3_PUBLIC_BASE_URL=https://cdn.example.com   # optional: public/CDN base for the bucket
```

**Option B — Replit object storage** (only works inside Replit; used automatically as a fallback when no `S3_*` vars are set):
```bash
export PRIVATE_OBJECT_DIR=/your-bucket/private
export PUBLIC_OBJECT_SEARCH_PATHS=/your-bucket/public
export DEFAULT_OBJECT_STORAGE_BUCKET_ID=your-bucket-id
```

> The app auto-detects the backend: if `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are all set it uses S3; otherwise it falls back to the Replit sidecar. `S3_REGION` and `S3_PUBLIC_BASE_URL` are optional.

> `DATABASE_URL`, `OPENAI_API_KEY`, and `SESSION_SECRET` are **not needed** to run the app.

### Step 3 — Build

```bash
pnpm --filter @workspace/youtube-arabic run build
pnpm --filter @workspace/api-server run build
```

### Step 4 — Run

```bash
PORT=8080 NODE_ENV=production node --enable-source-maps artifacts/api-server/dist/index.mjs
```

Open **http://localhost:8080/**. Verify health: `curl http://localhost:8080/api/healthz`.

### Alternative — development mode (two processes, hot reload)

```bash
# Terminal 1 — front-end
PORT=24245 BASE_PATH=/ pnpm --filter @workspace/youtube-arabic run dev

# Terminal 2 — API (proxies the SPA)
PORT=8080 NODE_ENV=development VITE_PORT=24245 \
  pnpm --filter @workspace/api-server run dev
```

Open **http://localhost:8080/**.

---

## Object storage outside Replit

The upload pipeline lives in `artifacts/api-server/src/lib/objectStorage.ts`. It supports **two backends** and picks one automatically at runtime:

- **S3-compatible storage** (Cloudflare R2, AWS S3, MinIO) — used when the `S3_*` env vars are set. This is the recommended backend off Replit and uses the AWS SDK to generate presigned PUT URLs and to read/delete objects server-side.
- **Replit object storage** — the fallback when no `S3_*` vars are present. It signs upload URLs through a **Replit-only local sidecar** (`http://127.0.0.1:1106`). That sidecar **does not exist off-platform**, so this backend only works inside Replit.

The public function contract (`getObjectEntityUploadURL`, `getObjectEntityFile`, `normalizeObjectEntityPath`) is identical for both backends, so the routes (`storage.ts`, `whisper.ts`) work without changes regardless of which one is active.

> If you only need the **YouTube-URL** translator (and dubbing), you can skip object storage entirely — those flows never touch it.

### Setting up Cloudflare R2

R2 is S3-compatible and has **no egress fees**, which makes it a good fit for video files.

1. **Create a bucket.** In the Cloudflare dashboard go to **R2 → Create bucket**, name it (e.g. `alitube`), and create it. No public access is required — uploads are private and downloaded server-side.
2. **Create an API token.** **R2 → Manage R2 API Tokens → Create API token**. Give it **Object Read & Write** permission, scoped to your bucket. Copy the **Access Key ID** and **Secret Access Key** (shown once).
3. **Find your endpoint.** On the bucket's **Settings** page, copy the **S3 API** endpoint — it looks like `https://<accountid>.r2.cloudflarestorage.com`. (Do **not** append the bucket name; the app adds it.)
4. **Configure CORS so the browser can upload via the presigned PUT URL.** On the bucket → **Settings → CORS policy**, add:
   ```json
   [
     {
       "AllowedOrigins": ["https://your-app-domain.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Use your real app origin(s); add `http://localhost:8080` for local testing.
5. **Set the env vars** (see *Step 2 — Configure environment → Option A*):
   ```bash
   export S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
   export S3_REGION=auto
   export S3_BUCKET=alitube
   export S3_ACCESS_KEY_ID=<access key id>
   export S3_SECRET_ACCESS_KEY=<secret access key>
   # export S3_PUBLIC_BASE_URL=https://cdn.example.com   # optional, only for serving public assets
   ```
6. **Restart and verify.** Start the server, then exercise the upload roundtrip:
   ```bash
   # request a presigned URL + objectPath
   curl -s -X POST http://localhost:8080/api/storage/uploads/request-url \
     -H 'Content-Type: application/json' \
     -d '{"name":"clip.mp4","size":1048576}'
   ```
   The response's `objectPath` should look like `/objects/uploads/<uuid>`. Upload a file to the returned `uploadURL` with an HTTP `PUT`, then pass the `objectPath` to `POST /api/whisper`.

> **AWS S3 / MinIO** work the same way: set `S3_ENDPOINT` to the service endpoint (for AWS, e.g. `https://s3.us-east-1.amazonaws.com`), set `S3_REGION` to the real region, and provide credentials with read/write access to the bucket.

---

## Production notes & limitations

- **CPU transcription.** Whisper runs the `tiny` model on CPU (`int8`). It's fast for short clips but slow for long videos. The worker has a **300-second timeout** per job (`artifacts/api-server/src/routes/whisper.ts`). Feature-length videos will not finish synchronously — that needs a background-job architecture (not yet implemented).
- **Free translation rate limits.** Google/MyMemory are unofficial/free and will rate-limit (HTTP 429) on very large transcripts. Results are cached on disk to reduce repeat calls.
- **Disk cache.** Translation and TTS caches are written under `artifacts/api-server/cache/`. On ephemeral/containerized hosts this cache is not persistent; mount a volume if you want it to survive restarts.
- **First Whisper run** downloads the model (~39 MB) and needs outbound internet.
- **Scaling.** The server is stateless apart from the on-disk cache, so it can run behind a load balancer; point all instances at shared object storage and (optionally) a shared cache volume.

---

## Quick reference

| Action | Command |
| --- | --- |
| Install JS deps | `pnpm install` |
| Install Python dep | `pip install "faster-whisper>=1.2.1"` |
| Build | `pnpm --filter @workspace/youtube-arabic run build && pnpm --filter @workspace/api-server run build` |
| Run (prod) | `PORT=8080 NODE_ENV=production node --enable-source-maps artifacts/api-server/dist/index.mjs` |
| Health check | `curl http://localhost:8080/api/healthz` |
| Typecheck | `pnpm run typecheck` |
