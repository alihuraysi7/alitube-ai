# AliTube AI Local Setup

AliTube AI is a web/PWA plus Express backend project. It is not an Android native project.

## Requirements

- Node.js 24 is the project baseline in `.replit`. Node 22 may work for some checks, but use Node 24 for the least surprising local setup.
- pnpm 11.5.2 via Corepack. The repo uses `pnpm-lock.yaml` lockfile version 9.0.
- Python 3.11+ for Whisper helper scripts.
- `ffmpeg` and `ffprobe` installed and available on `PATH` for media upload, Whisper audio extraction, and dubbed audio export.

## Package Manager

Enable and activate pnpm with Corepack:

```powershell
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm --version
```

If Windows blocks Corepack from creating global shims under `C:\Program Files\nodejs`, you can still run pnpm through Corepack:

```powershell
corepack pnpm --version
corepack pnpm install --frozen-lockfile
```

## Install Dependencies

```powershell
corepack pnpm install --frozen-lockfile
```

Use the frozen lockfile first. If it fails, inspect the error before changing package versions or regenerating the lockfile.

## Environment

Create a local env file from the template:

```powershell
Copy-Item .env.example .env
```

Required or optional variables:

- `PORT`: API server port. Use `8080` for the backend.
- `BASE_PATH`: Vite base path. Use `/` locally.
- `VITE_PORT`: frontend dev server port used by the backend proxy. Use `24245`.
- `PRIVATE_OBJECT_DIR`: required for direct-to-object-storage uploads and Whisper processing.
- `PUBLIC_OBJECT_SEARCH_PATHS`: only needed by public object lookup helpers if those routes are used.
- `ELEVENLABS_API_KEY`: required only when optional dubbing or voice preview is enabled.
- `DATABASE_URL`: required only for Drizzle/Postgres DB tooling or code paths that import `lib/db`.

Do not put real secrets in `.env.example`.

## Run Locally

The default local ports are:

- Backend/proxy: `http://localhost:8080`
- Frontend/Vite: `http://localhost:24245`

### Windows PowerShell Quick Start

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
```

Open `http://localhost:8080`. The backend proxies non-API requests to the Vite frontend.

### macOS/Linux Quick Start

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
```

Open `http://localhost:8080`. The same Node-based dev runner is used on every platform.

### Separate Terminals

Terminal 1, frontend only:

```powershell
corepack pnpm run dev:web
```

Terminal 2, backend/API only:

```powershell
corepack pnpm run dev:api
```

You can override ports with `API_PORT` and `WEB_PORT`:

```powershell
$env:API_PORT="8080"
$env:WEB_PORT="24245"
corepack pnpm run dev
```

```bash
API_PORT=8080 WEB_PORT=24245 corepack pnpm run dev
```

## Build and Typecheck

```powershell
corepack pnpm run typecheck
corepack pnpm run build
```

There is no root `test` or `check` script at the time of writing.

## Online Deployment

Render deployment notes are in `DEPLOYMENT.md`. The first supported online target is a single Render Node web service that builds the frontend and starts the Express API in production mode.

## Windows Notes

- `python3` may not exist on Windows. The API server currently spawns `python3` for Whisper scripts, so install Python with a `python3` shim, use WSL/Git Bash, or adjust your local shell environment accordingly.
- `ffmpeg` and `ffprobe` must be installed and added to `PATH`.
- `faster-whisper` is declared in `pyproject.toml`, but it may require native runtime support and model downloads on first use.
- The dev scripts are Node-based and avoid POSIX-only shell commands such as `fuser`, `sleep`, and `export`.

## Troubleshooting

- Port already in use: `corepack pnpm run kill-port -- 8080 24245`, then retry `corepack pnpm run dev`.
- `ffmpeg` missing: install FFmpeg and make sure both `ffmpeg` and `ffprobe` resolve on `PATH`.
- `python3` missing on Windows: install a Python distribution that provides `python3`, use WSL/Git Bash, or adjust the local environment before using Whisper upload features.
- `faster_whisper` missing: install the Python dependencies from `pyproject.toml`; the YouTube subtitle flow does not need it, but upload/Whisper processing does.
- Corepack cannot create global shims on Windows: use `corepack pnpm ...` commands instead of bare `pnpm ...`.

## Scope Notes

This setup keeps AliTube AI separate from the AliTube AI Offline experiment. It does not add Android, YouTube downloading, or product feature changes.
