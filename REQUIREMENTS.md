# Requirements

Everything needed to build and run AliTube AI (the YouTube Arabic subtitle translator).

---

## 1. System / runtime requirements

| Requirement | Version | Why |
| --- | --- | --- |
| **Node.js** | **24.x** | Back-end (Express) and front-end build (Vite). |
| **pnpm** | 9.x+ (10.x recommended) | Monorepo package manager. `npm`/`yarn` are blocked by design. |
| **Python** | **3.11** | Runs `whisper_worker.py` for transcription. |
| **FFmpeg** | recent (6.x+) | Audio extraction and dubbing audio stitching. Provides the `ffmpeg` binary. |
| **FFprobe** | ships with FFmpeg | Reads audio duration during dubbing. |
| **uv** *(optional)* | latest | Convenient way to install the Python dep from `pyproject.toml`. `pip` works too. |

### Installing the system binaries

**Debian / Ubuntu**
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg python3.11 python3-pip
```

**macOS (Homebrew)**
```bash
brew install ffmpeg python@3.11 pnpm
```

**Windows**
- Install FFmpeg from https://www.gnu.org/software/ffmpeg/ (or `winget install Gyan.FFmpeg`) and ensure `ffmpeg`/`ffprobe` are on `PATH`.
- Install Python 3.11 from python.org and Node 24 from nodejs.org.
- Enable pnpm with `corepack enable pnpm`.

Verify:
```bash
node -v        # v24.x
pnpm -v
python3 --version   # 3.11.x
ffmpeg -version
ffprobe -version
```

---

## 2. Python dependencies

Declared in `pyproject.toml`:

```
faster-whisper >= 1.2.1
```

Install with either:
```bash
uv sync                              # uses pyproject.toml + uv.lock
# or
pip install "faster-whisper>=1.2.1"
```

> The Whisper **tiny** model (~39 MB) is downloaded automatically by `faster-whisper` on first transcription and cached in the user's home cache dir. The first run needs internet access; subsequent runs are offline.

---

## 3. Node / JavaScript dependencies

Install all workspace packages from the repo root:
```bash
pnpm install
```

Key runtime dependencies (`artifacts/api-server`):

| Package | Purpose |
| --- | --- |
| `express` | HTTP server |
| `youtube-transcript` | Fetch YouTube captions |
| `@vitalets/google-translate-api` | Translation engine #1 |
| `@google-cloud/storage`, `google-auth-library` | Object storage (uploads) |
| `formidable` | (legacy multipart helper; upload now goes direct-to-storage) |
| `http-proxy-middleware` | Dev-mode SPA proxy |
| `cors`, `cookie-parser` | HTTP middleware |
| `pino`, `pino-http` | Structured logging |
| `drizzle-orm` | DB layer (scaffolded, unused at runtime) |

Front-end (`artifacts/youtube-arabic`): React 19, Vite 7, Tailwind CSS 4, Radix UI, TanStack Query, Wouter, Framer Motion (full list in its `package.json`).

> A second translation engine, **MyMemory**, is called over plain HTTP and needs no package or key.

---

## 4. External services / API keys

| Service | Needed for | Env var |
| --- | --- | --- |
| **ElevenLabs** | Arabic dubbing (TTS) — optional, off by default | `ELEVENLABS_API_KEY` |
| **Object storage** (GCS via Replit sidecar, or your own GCS/S3) | File-upload transcription pipeline | `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID` |
| **PostgreSQL** | Only if you run `db push` (no runtime use) | `DATABASE_URL` |
| Google Translate / MyMemory | Core translation | none (no key required) |

> Not required: `OPENAI_API_KEY`, `SESSION_SECRET` — present in some environments but unused by the code.

---

## 5. Feature → requirement matrix

| Feature | Node deps | Python + FFmpeg | ElevenLabs key | Object storage |
| --- | :---: | :---: | :---: | :---: |
| YouTube URL → Arabic subtitles | ✅ | — | — | — |
| File upload → Arabic subtitles | ✅ | ✅ | — | ✅ |
| Arabic dubbing (play + download) | ✅ | ✅ (download stitch) | ✅ | — |

This means you can run a fully working **YouTube-URL translator** with just Node + pnpm. The upload pipeline adds Python/FFmpeg/object-storage; dubbing adds an ElevenLabs key.
