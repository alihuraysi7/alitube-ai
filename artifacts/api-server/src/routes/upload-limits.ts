/**
 * Shared upload constraints for the media → subtitle pipeline.
 *
 * Files are uploaded directly to object storage via a presigned URL, so they
 * bypass the deployment's request-body limit (32 MiB on Autoscale). This cap
 * is therefore a product limit, not a platform one.
 */
export const ALLOWED_EXT = new Set([
  "mp4", "mov", "mkv", "webm", "mp3", "wav", "m4a",
]);

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MAX_UPLOAD_LABEL = "1 جيجابايت";

/** Lowercase file extension without the dot, or "" when absent. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
