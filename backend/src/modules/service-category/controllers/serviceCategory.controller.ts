import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import type { CategoryStatus } from "../models/serviceCategoryModel";
import * as service from "../services/serviceCategoryService";
import type { ServiceCategoryCreate, ServiceCategoryUpdate } from "../services/serviceCategoryService";
import * as audit from "../../audit/services/auditService";

/** Audit events for Ride service categories. */
export const ServiceCategoryEvents = {
  Created: "service_category_created",
  Updated: "service_category_updated",
  StatusChanged: "service_category_status_changed",
  IconChanged: "service_category_icon_changed",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/service-category/list — live Ride categories (3 today). */
export async function list(_req: Request, res: Response) {
  const items = await service.listCategories();
  res.json({ items, total: items.length });
}

/** POST /api/service-category/create — add a new Ride category (name + status). */
export async function create(req: Request, res: Response) {
  const { name, status } = req.body as ServiceCategoryCreate;
  const item = await service.createCategory({ name, status });
  await writeAudit(req, ServiceCategoryEvents.Created);
  res.json({ item });
}

/** GET /api/service-category/:id — one category with every editable column. */
export async function getOne(req: Request, res: Response) {
  res.json({ item: await service.getCategory(Number(req.params.id)) });
}

/** PUT /api/service-category/:id — write the changed texts, artwork, settings and blocks. */
export async function update(req: Request, res: Response) {
  const item = await service.updateCategory(
    Number(req.params.id),
    req.body as ServiceCategoryUpdate,
  );
  await writeAudit(req, ServiceCategoryEvents.Updated);
  res.json({ item });
}

/** PATCH /api/service-category/:id/status — activate / deactivate a category. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: CategoryStatus };
  const item = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, ServiceCategoryEvents.StatusChanged);
  res.json({ item });
}

// ---------------------------------------------------------------------------
// Category icon. The legacy panel uploaded one image per category into
// `MasterServiceCategories/` and kept the bare file name in the `vLogo` column, so
// only that directory name is a promise to the apps — the bytes are found either in
// this app's own upload dir (where new icons are written) or in the read-only legacy
// media dir. Both are streamed back here, cookie-authenticated, so an existing icon
// stays visible and the apps resolve the same file name unchanged.
// ---------------------------------------------------------------------------

/** Sub-directory (relative to either media root) holding category icons. */
const ICON_DIR = "MasterServiceCategories";
const ICON_MAX_BYTES = 5 * 1024 * 1024;
const ICON_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function iconContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/** Resolve a stored icon on disk: this app's upload dir, then the legacy dir. */
function resolveIcon(filename: string): string | null {
  return resolveStoredMedia(ICON_DIR, path.basename(filename));
}

/** GET /api/service-category/:id/image — stream the stored icon (404 when missing). */
export async function image(req: Request, res: Response) {
  const filename = await service.getIconFilename(Number(req.params.id));
  if (!filename) throw AppError.notFound("No icon on file");
  const abs = resolveIcon(filename);
  if (!abs) throw AppError.notFound("Icon file missing");
  res.setHeader("Content-Type", iconContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
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
  limits: { fileSize: ICON_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ICON_EXT.has(ext) && /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
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

/** POST /api/service-category/:id/image — attach or replace the icon. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  // mustFind (via getIconFilename) 404s before any file is written when the row is out of scope.
  const previous = await service.getIconFilename(id);
  try {
    const item = await service.setIcon(id, req.file.filename);
    if (previous && previous !== req.file.filename) {
      // Best-effort cleanup of the replaced file; the DB already points at the new
      // one. A legacy-panel icon is intentionally left on disk (shared file).
      deleteUploadedMedia(ICON_DIR, path.basename(previous));
    }
    await writeAudit(req, ServiceCategoryEvents.IconChanged);
    res.json({ item });
  } catch (err) {
    // Don't leave an orphaned file behind when the DB write fails.
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
