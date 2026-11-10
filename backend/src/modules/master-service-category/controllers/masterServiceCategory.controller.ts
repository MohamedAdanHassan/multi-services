import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import {
  MAX_IMAGE_BYTES,
  deleteUploadedMedia,
  imageContentType,
  isSupportedImage,
  resolveStoredMedia,
  uploadDir,
} from "../../../utils/media";
import type { MasterCategoryScope, MasterCategoryStatus } from "../models/masterServiceCategoryModel";
import { requireScope } from "../models/masterServiceCategoryModel";
import * as service from "../services/masterServiceCategoryService";
import * as audit from "../../audit/services/auditService";

/**
 * Audit events for the app master service category (Parcel Delivery → #sub-136). All
 * three fit the 50-character event column and are prefixed distinctly from the taxi's
 * `service_category_*` names, so an admin log can tell the two screens apart.
 */
export const MasterServiceCategoryEvents = {
  Updated: "master_service_category_updated",
  StatusChanged: "master_service_category_status_changed",
  IconChanged: "master_service_category_icon_changed",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * Which app the request is addressed as. The route's zod enum normally guarantees the
 * name, so this is the backstop that refuses an unmapped path instead of reading a
 * different app's master row.
 */
function scopeOf(req: Request): MasterCategoryScope {
  return requireScope(req.params.app);
}

/** GET /api/master-service-category/:app/list — this app's master rows (1 today). */
export async function list(req: Request, res: Response) {
  const items = await service.listCategories(scopeOf(req));
  res.json({ items, total: items.length });
}

/** GET /api/master-service-category/:app/:id — one row: names, icon, status, cascade preview. */
export async function getOne(req: Request, res: Response) {
  const scope = scopeOf(req);
  res.json({ item: await service.getCategory(scope, Number(req.params.id)) });
}

/** PUT /api/master-service-category/:app/:id — merge changed language names. */
export async function update(req: Request, res: Response) {
  const scope = scopeOf(req);
  const { names } = req.body as { names?: Record<string, unknown> };
  if (!names || typeof names !== "object" || Array.isArray(names)) {
    throw AppError.badRequest("Send a `names` map of language code to text.");
  }
  const item = await service.updateNames(scope, Number(req.params.id), names);
  await writeAudit(req, MasterServiceCategoryEvents.Updated);
  res.json({ item });
}

/** PATCH /api/master-service-category/:app/:id/status — flip this row's switch only. */
export async function setStatus(req: Request, res: Response) {
  const scope = scopeOf(req);
  const { status } = req.body as { status: MasterCategoryStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, MasterServiceCategoryEvents.StatusChanged);
  res.json({ item });
}

// ---------------------------------------------------------------------------
// Icon. One column (`vIconImage1`), one flat directory, a bare file name the apps
// concatenate into an image URL. The directory is named after the LEGACY folder so an
// existing icon only reads back because the two media trees agree on the name.
// ---------------------------------------------------------------------------

/** Sub-directory (relative to either media root) holding the master category icons. */
const ICON_DIR = "MasterServiceCategories";

/** Resolve a stored icon on disk: this app's upload dir, then the read-only legacy dir. */
function resolveIcon(filename: string): string | null {
  return resolveStoredMedia(ICON_DIR, path.basename(filename));
}

const iconStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, uploadDir(ICON_DIR));
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `${Date.now()}_${rand}${ext}`);
  },
});

const iconUpload = multer({
  storage: iconStorage,
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter(_req, file, cb) {
    if (isSupportedImage(file.originalname, file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported file type. Use JPG, PNG, WEBP or GIF."));
    }
  },
});

/** Multer single-file middleware translating upload errors into AppError. */
export function iconUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  iconUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 5 MB)."));
    }
    return next(err);
  });
}

/** GET /api/master-service-category/:app/:id/image — stream the stored icon (404 when missing). */
export async function image(req: Request, res: Response) {
  const filename = await service.getIconFilename(scopeOf(req), Number(req.params.id));
  if (!filename) throw AppError.notFound("No icon on file");
  const abs = resolveIcon(filename);
  if (!abs) throw AppError.notFound("Icon file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/** POST /api/master-service-category/:app/:id/image — attach or replace the icon. */
export async function uploadImage(req: Request, res: Response) {
  const scope = scopeOf(req);
  const id = Number(req.params.id);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  try {
    // The row is read inside the try: multer has already written the file by now, so
    // every failure below — out-of-scope id, stuck statement — has to undo that write
    // rather than leave an orphan nothing points at.
    const previous = await service.getIconFilename(scope, id);
    const item = await service.setIconFilename(scope, id, req.file.filename);
    if (previous && previous !== req.file.filename) {
      // Best effort: the row already points at the new file, and a name the legacy
      // panel owns is deliberately left on disk because other rows share it.
      deleteUploadedMedia(ICON_DIR, path.basename(previous));
    }
    await writeAudit(req, MasterServiceCategoryEvents.IconChanged);
    res.json({ item });
  } catch (err) {
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
