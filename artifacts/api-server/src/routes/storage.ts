import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectStorageService } from "../lib/objectStorage";
import { ALLOWED_EXT, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, extOf } from "./upload-limits";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Client sends JSON metadata only (name, size, contentType) — NOT the file.
 * Returns a presigned PUT URL the browser uploads to directly, bypassing the
 * deployment's request-body limit. The returned objectPath is then passed to
 * POST /whisper, which downloads the object server-side and processes it.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { name?: unknown; size?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  const size = typeof body.size === "number" ? body.size : NaN;

  if (!name || !Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: "بيانات الملف غير صالحة." });
    return;
  }

  const ext = extOf(name);
  if (!ALLOWED_EXT.has(ext)) {
    res.status(400).json({
      error: `نوع ملف غير مدعوم: .${ext} — الأنواع المدعومة: ${[...ALLOWED_EXT].join(", ")}`,
    });
    return;
  }

  if (size > MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `الملف كبير جداً. الحدّ الأقصى المسموح هو ${MAX_UPLOAD_LABEL}.`,
    });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "تعذّر تجهيز الرفع. حاول مرة أخرى." });
  }
});

export default router;
