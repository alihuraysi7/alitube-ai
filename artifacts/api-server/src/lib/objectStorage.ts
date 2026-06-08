import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/**
 * Minimal contract that the rest of the app (e.g. routes/whisper.ts) relies on.
 *
 * Both backends — Replit object storage (Google Cloud Storage via the Replit
 * sidecar) and any S3-compatible store (Cloudflare R2, AWS S3, MinIO) — return
 * an object that satisfies this interface, so route code never needs to know
 * which backend is active.
 */
export interface StorageObjectMetadata {
  size?: number;
  contentType?: string;
}

export interface StorageObject {
  getMetadata(): Promise<[StorageObjectMetadata]>;
  download(opts: { destination: string }): Promise<void>;
  delete(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
// If a full set of S3_* env vars is present we use the S3-compatible backend.
// Otherwise we fall back to Replit object storage so the app keeps working
// unchanged inside Replit.

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

function getS3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION || "auto",
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || undefined,
  };
}

/** True when the S3-compatible backend is configured (otherwise Replit is used). */
export function isS3Configured(): boolean {
  return getS3Config() !== null;
}

// Cache the S3 client per process (credentials are static for the process life).
let s3ClientCache: import("@aws-sdk/client-s3").S3Client | null = null;
async function getS3Client(
  cfg: S3Config
): Promise<import("@aws-sdk/client-s3").S3Client> {
  if (s3ClientCache) return s3ClientCache;
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3ClientCache = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    // Path-style works across R2, MinIO and S3; virtual-host endpoints also accept it.
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  return s3ClientCache;
}

function isS3NotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.$metadata?.httpStatusCode === 404 ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey"
  );
}

/** Wraps an S3 object key in the StorageObject contract. */
function s3StorageObject(cfg: S3Config, key: string): StorageObject {
  return {
    async getMetadata(): Promise<[StorageObjectMetadata]> {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(cfg);
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })
        );
        return [{ size: r.ContentLength, contentType: r.ContentType }];
      } catch (err) {
        if (isS3NotFound(err)) throw new ObjectNotFoundError();
        throw err;
      }
    },
    async download({ destination }: { destination: string }): Promise<void> {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(cfg);
      try {
        const r = await client.send(
          new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
        );
        if (!r.Body) throw new ObjectNotFoundError();
        await pipeline(r.Body as Readable, createWriteStream(destination));
      } catch (err) {
        if (isS3NotFound(err)) throw new ObjectNotFoundError();
        throw err;
      }
    },
    async delete(): Promise<void> {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(cfg);
      await client.send(
        new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })
      );
    },
  };
}

/** Wraps a Google Cloud Storage File in the StorageObject contract. */
function gcsStorageObject(file: File): StorageObject {
  return {
    async getMetadata(): Promise<[StorageObjectMetadata]> {
      const [m] = await file.getMetadata();
      return [
        {
          size: m.size != null ? Number(m.size) : undefined,
          contentType: m.contentType,
        },
      ];
    },
    async download({ destination }: { destination: string }): Promise<void> {
      await file.download({ destination });
    },
    async delete(): Promise<void> {
      await file.delete();
    },
  };
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  /**
   * Returns a presigned PUT URL the browser uploads directly to. The returned
   * URL is later passed to `normalizeObjectEntityPath` to derive the stable
   * `/objects/uploads/<uuid>` path used everywhere else.
   */
  async getObjectEntityUploadURL(): Promise<string> {
    const cfg = getS3Config();
    if (cfg) {
      const objectId = randomUUID();
      const key = `uploads/${objectId}`;
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const client = await getS3Client(cfg);
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key }),
        { expiresIn: 900 }
      );
    }

    // ---- Replit object storage fallback (unchanged) ----
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  /**
   * Resolves an `/objects/...` path to a backend object implementing the
   * StorageObject contract. Throws ObjectNotFoundError when the object is
   * missing (parity across both backends).
   */
  async getObjectEntityFile(objectPath: string): Promise<StorageObject> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const cfg = getS3Config();
    if (cfg) {
      const key = objectPath.slice("/objects/".length);
      if (!key) throw new ObjectNotFoundError();
      const obj = s3StorageObject(cfg, key);
      // Verify existence up front (mirrors the GCS `exists()` check).
      await obj.getMetadata();
      return obj;
    }

    // ---- Replit object storage fallback ----
    const file = await this.getGcsEntityFile(objectPath);
    return gcsStorageObject(file);
  }

  /** Replit/GCS-only: resolve the raw GCS File for an `/objects/...` path. */
  private async getGcsEntityFile(objectPath: string): Promise<File> {
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    const cfg = getS3Config();
    if (cfg) {
      // Turn a presigned S3 URL into the stable `/objects/<key>` form.
      let pathname: string;
      try {
        pathname = new URL(rawPath).pathname;
      } catch {
        return rawPath;
      }
      let segments = pathname.replace(/^\/+/, "").split("/");
      // Path-style URLs include the bucket as the first segment; drop it.
      if (segments[0] === cfg.bucket) {
        segments = segments.slice(1);
      }
      const key = segments.map((s) => decodeURIComponent(s)).join("/");
      if (!key) return rawPath;
      return `/objects/${key}`;
    }

    // ---- Replit object storage fallback (unchanged) ----
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  /**
   * Build a public URL for an `/objects/...` path. Uses S3_PUBLIC_BASE_URL when
   * the S3 backend is active (falls back to endpoint/bucket), otherwise the GCS
   * public host. Not used by the core upload pipeline (uploads are private and
   * fetched server-side) but available for serving public assets.
   */
  getPublicObjectUrl(objectPath: string): string {
    const key = objectPath.startsWith("/objects/")
      ? objectPath.slice("/objects/".length)
      : objectPath.replace(/^\/+/, "");
    const cfg = getS3Config();
    if (cfg) {
      const base = (
        cfg.publicBaseUrl || `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}`
      ).replace(/\/$/, "");
      return `${base}/${key}`;
    }
    return `https://storage.googleapis.com/${key}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    if (getS3Config()) {
      // ACL policies stored as object metadata are a Replit/GCS concept. With
      // S3-compatible stores, access is governed by bucket policy/credentials,
      // so this is a no-op. (Not exercised by the current routes.)
      return normalizedPath;
    }

    const objectFile = await this.getGcsEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = (await response.json()) as { signed_url: string };
  return signedURL;
}
