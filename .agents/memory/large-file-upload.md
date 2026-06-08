---
name: Large file upload (direct-to-object-storage + server-side audio extraction)
description: Why uploads go directly to object storage (Autoscale 32MiB edge limit), how /api/whisper processes a stored object, and the NDJSON progress contract.
---

# Large file upload + server-side audio extraction

Audio extraction for the Whisper/translate flow happens on the **server** (FFmpeg), not the browser.

**Why:** the browser used to read the whole file into memory and `decodeAudioData()` it to PCM, which expands to multiple GB for a feature-length film and OOM-crashed the tab. Never decode large media client-side.

## The production upload ceiling is the Autoscale edge proxy = 32 MiB (hard)

The **published** Autoscale deployment rejects any request body **≥ 32 MiB** with an HTTP 413 that **never reaches Express** (no `POST /api/whisper` in deployment logs). Probed precisely against the live URL: 24MB passed, 32MB/48MB/64MB → 413. The dev proxy (localhost:80 / *.replit.dev) is far more permissive (passes 800MB+), so a multipart-to-`/api/whisper` design works in dev but silently breaks in prod even for small clips.

**Why this matters:** any design that streams the file body through the deployment is capped at ~32 MiB in production. Do not "fix" this with a size cap/message — the cap would have to be ~30 MiB, which is useless for video.

## Fix in place: direct-to-object-storage presigned upload (bypasses the edge limit)

Flow:
1. Client `POST /api/storage/uploads/request-url` with JSON `{name,size,contentType}` → returns `{uploadURL, objectPath}` (presigned PUT to GCS).
2. Client `PUT`s the file **directly to GCS** (storage.googleapis.com) with XHR upload progress — never through the app, so no edge body limit.
3. Client `POST /api/whisper` with small JSON `{objectPath, filename, engine}`. Server downloads the object to tmp, runs the **unchanged** FFmpeg → whisper_worker → translate pipeline, streams NDJSON, then deletes the tmp file **and** the GCS object in `finally`.

Server libs `lib/objectStorage.ts` + `lib/objectAcl.ts` are copied from the object-storage skill (Replit sidecar auth — do not edit the GCS client setup; the only needed tweak was typing the `signed_url` json()).

**Dual backend (Replit GCS sidecar OR S3-compatible like Cloudflare R2):** `objectStorage.ts` auto-selects S3 when `S3_ENDPOINT`+`S3_BUCKET`+`S3_ACCESS_KEY_ID`+`S3_SECRET_ACCESS_KEY` are all set, else falls back to the Replit sidecar so the app keeps working on-platform. The public contract (`getObjectEntityUploadURL`/`getObjectEntityFile`/`normalizeObjectEntityPath`) is unchanged; both backends return a small `StorageObject` interface (`getMetadata`/`download`/`delete`) — that is the ONLY type whisper.ts depends on (no longer the raw GCS `File`). objectPath stays `/objects/uploads/<uuid>` for BOTH backends so `UPLOAD_OBJECT_RE` and routes are untouched. S3 key for an upload is `uploads/<uuid>`; `normalizeObjectEntityPath` strips the leading bucket segment (path-style, `forcePathStyle:true`). Uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (lazy `await import`, externalized by esbuild — loads from node_modules at runtime like `@google-cloud/*`). `S3_REGION` defaults to `auto` (R2); `S3_PUBLIC_BASE_URL` optional, only used by `getPublicObjectUrl` (not in the core private-upload flow).

**Security invariants (enforced in whisper.ts — keep them):** because the route deletes the referenced object, `/whisper` only accepts paths matching `^/objects/uploads/<uuid>$` (`UPLOAD_OBJECT_RE`), and enforces the real size from `objectFile.getMetadata()` before download (client-reported size at issuance is untrusted). `MAX_UPLOAD_BYTES`/`MAX_UPLOAD_LABEL` live in `routes/upload-limits.ts`, shared by storage + whisper; the client constants must stay in lockstep.

**Still deferred for long movies:** `runWhisper` has a 300s timeout and Autoscale caps request duration, so a 90-min film still won't finish synchronously even though it now uploads. Free translate APIs also 429 on thousands of segments. Real movie support needs a background job.

## Request/response contract

- Step 2 upload uses `XMLHttpRequest` PUT for real progress; step 3 uses XHR POST for incremental NDJSON reads.
- `/api/whisper` streams newline-delimited JSON: one `{"phase":"extract"|"whisper"|"translate"}` per phase, then `{"result":{...}}`. Once a phase line is written, status is locked to 200, so mid-stream failures can only be reported as a final `{"error":...}` line.
- Validation errors (no/invalid path, unsupported type, oversized) return plain JSON with the proper status (400/413/404) **before** streaming starts.
- User-facing errors are Arabic in the `error` field only; internal exception text is logged, never returned to the client.

**Gotchas:** the edge proxy may buffer the NDJSON stream; `X-Accel-Buffering: no` + `Cache-Control: no-transform` are set but don't guarantee flush. Keep the client phase→Arabic-label map in sync with server phase names. `formidable` is no longer used by whisper.ts (left in deps, harmless).
