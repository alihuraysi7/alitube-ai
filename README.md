# AliTube AI — YouTube Arabic Subtitle Translator

Generate **Arabic subtitles** for any English YouTube video or uploaded video/audio file, with **optional Arabic voice dubbing**. The app transcribes audio with Whisper, translates English → Arabic, and can synthesize an Arabic voice track that plays in sync with the video.

> The UI is in Arabic (RTL). This README is in English for contributors.

---

## Features

- **YouTube URL → Arabic subtitles.** Fetches existing English captions (manual or auto-generated) and translates them to Arabic.
- **File upload → Arabic subtitles.** Upload a video/audio file (up to ~1 GB); the server extracts audio, runs Whisper transcription, then translates to Arabic.
- **Optional Arabic dubbing (TTS).** Off by default. Synthesizes Arabic speech per subtitle segment via ElevenLabs and plays it in sync; a single stitched dubbed audio track can also be downloaded.
- **Resilient translation.** Two free translation engines (Google Translate unofficial + MyMemory) with cross-engine fallback and validation that output is actually Arabic (guards against silent English pass-through).
- **Streaming progress.** Long jobs stream phase updates (`extract` → `whisper` → `translate`) as NDJSON.

---

## Architecture

This is a **pnpm monorepo**. Two services make up the running app:

| Package | Type | Role |
| --- | --- | --- |
| `artifacts/youtube-arabic` | Vite + React 19 SPA | Front-end UI (Arabic, RTL). Tailwind + Radix UI. |
| `artifacts/api-server` | Express 5 (Node 24) | All back-end logic: YouTube transcripts, Whisper, translation, TTS, file storage. |
| `artifacts/mockup-sandbox` | Vite (dev only) | Component preview sandbox. Not part of production. |
| `lib/api-spec` | OpenAPI + Orval | Source-of-truth API contract; generates the items below. |
| `lib/api-client-react` | Generated | React Query hooks for the front-end. |
| `lib/api-zod` | Generated | Zod schemas for request/response validation. |
| `lib/db` | Drizzle ORM + `pg` | **Scaffolded but currently unused at runtime** (see note). |

### Request flow

**YouTube URL path** (`POST /api/translate`)
1. Front-end sends the YouTube URL.
2. Server extracts the video ID and pulls English captions via `youtube-transcript`.
3. Text is batched and translated EN → AR (Google → MyMemory fallback).
4. Successful results are cached on disk (`artifacts/api-server/cache/`).

**File upload path** (Whisper pipeline)
1. Front-end requests a presigned upload URL: `POST /api/storage/uploads/request-url`.
2. Browser uploads the file **directly to object storage** (bypasses the platform's request-body size limit), then sends the object reference to `POST /api/whisper`.
3. Server downloads the object to a temp file, extracts 16 kHz mono WAV with **FFmpeg**, transcribes with **`faster-whisper` (tiny model, CPU/int8)** via `whisper_worker.py`, then translates EN → AR.
4. Progress streams back as NDJSON; the temp file and stored object are deleted afterward.

**Optional dubbing** (`POST /api/tts`, `POST /api/tts/download`)
1. Front-end requests base64 MP3 clips per subtitle segment from ElevenLabs (batched, cached under `cache/tts/`).
2. The browser schedules clips via the Web Audio API to stay in sync with the video.
3. For download, the server stitches clips into one timed MP3 with FFmpeg (`adelay` + `amix`).

> **Database note:** `lib/db` (Drizzle + Postgres) is wired up but **no runtime route currently reads or writes the database** — caching is on the local filesystem. `DATABASE_URL` is therefore **not required to run the app**; it's only needed if you run `pnpm --filter @workspace/db run push`.

> **Object storage note:** The upload pipeline uses Replit's object-storage sidecar (`@google-cloud/storage` signed through a Replit-only local endpoint). The **YouTube-URL and dubbing flows work anywhere**, but the **file-upload flow depends on Replit object storage** unless you replace `artifacts/api-server/src/lib/objectStorage.ts` with a standard GCS/S3 implementation. See `DEPLOYMENT.md`.

---

## Tech stack

- **Runtime:** Node.js 24, Python 3.11
- **Front-end:** React 19, Vite 7, Tailwind CSS 4, Radix UI, Wouter, TanStack Query
- **Back-end:** Express 5, Pino logging
- **Transcription:** `faster-whisper` (tiny) + FFmpeg/FFprobe
- **Translation:** `@vitalets/google-translate-api`, MyMemory API
- **TTS:** ElevenLabs API
- **Validation / contract:** Zod, OpenAPI, Orval
- **Package manager:** pnpm (workspaces)

See `REQUIREMENTS.md` for the full dependency and system-package list.

---

## Repository layout

```
.
├── artifacts/
│   ├── api-server/          # Express back-end (+ whisper_worker.py, whisper_warmup.py)
│   │   ├── src/             # routes/, lib/, app.ts, index.ts
│   │   └── cache/           # on-disk translation + TTS cache (gitignored content)
│   ├── youtube-arabic/      # React front-end
│   └── mockup-sandbox/      # dev-only component preview
├── lib/
│   ├── api-spec/            # openapi.yaml + orval config
│   ├── api-client-react/    # generated React Query hooks
│   ├── api-zod/             # generated Zod schemas
│   └── db/                  # Drizzle schema (scaffolded, unused at runtime)
├── scripts/                 # workspace utility scripts
├── pyproject.toml           # Python deps (faster-whisper)
├── pnpm-workspace.yaml
└── package.json
```

---

## Environment variables

| Variable | Required? | Used by | Purpose |
| --- | --- | --- | --- |
| `PORT` | Yes (defaults 8080 api / 24245 web) | both | Port each service binds to. |
| `NODE_ENV` | Recommended | api-server | `development` proxies to Vite; `production` serves the built SPA. |
| `BASE_PATH` | Web (default `/`) | front-end | Base path the SPA is mounted at. |
| `VITE_PORT` | Dev only (default `24245`) | api-server | Where the API proxies non-`/api` requests in dev. |
| `LOG_LEVEL` | No (default `info`) | api-server | Pino log level. |
| `ELEVENLABS_API_KEY` | Only for dubbing | api-server | ElevenLabs TTS auth. Dubbing is disabled without it. |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Only for file upload | api-server | Replit object-storage public search paths. |
| `PRIVATE_OBJECT_DIR` | Only for file upload | api-server | Replit object-storage private dir for uploads. |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Only for file upload | api-server (sidecar) | Replit object-storage bucket id. |
| `DATABASE_URL` | Only for `db push` | lib/db | Postgres connection string. **Not needed to run the app.** |

> `OPENAI_API_KEY` and `SESSION_SECRET` may exist in the environment but are **not referenced anywhere in the code**. They can be ignored.

---

## Quick start (local dev)

> Full, exact, copy-paste instructions for running **outside Replit** are in `DEPLOYMENT.md` → "Running outside Replit". This is the short version.

Prerequisites: Node 24, pnpm, Python 3.11, FFmpeg.

```bash
# 1. Install JS deps
pnpm install

# 2. Install the Python transcription dependency
pip install "faster-whisper>=1.2.1"        # or: uv sync

# 3a. Terminal 1 — front-end (Vite)
PORT=24245 BASE_PATH=/ pnpm --filter @workspace/youtube-arabic run dev

# 3b. Terminal 2 — API server (proxies the SPA in dev)
PORT=8080 NODE_ENV=development VITE_PORT=24245 \
  pnpm --filter @workspace/api-server run dev
```

Then open `http://localhost:8080/`.

- The YouTube-URL translation and dubbing features work locally as long as `ELEVENLABS_API_KEY` is set (dubbing only).
- The **file-upload** feature needs object storage configured — see `DEPLOYMENT.md`.

---

## Useful commands

```bash
pnpm run typecheck                                   # typecheck everything
pnpm --filter @workspace/api-server run typecheck    # one package
pnpm --filter @workspace/api-spec run codegen        # regenerate hooks + Zod from OpenAPI
pnpm --filter @workspace/db run push                 # push DB schema (needs DATABASE_URL)
```

---

## Documentation

- **`DEPLOYMENT.md`** — production deployment + exact steps to run outside Replit.
- **`REQUIREMENTS.md`** — full system, Node, and Python dependency list.
