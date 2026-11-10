import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import type { AdBannerStatus } from "../models/adBannersModel";
import * as service from "../services/adBannersService";
import * as model from "../models/adBannersModel";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for Marketing Tools → Advertisement Banners (#sub-109). Reads and
 * writes go through the service; the image is streamed from (and uploaded to) a
 * dedicated folder under the legacy web-images root, exactly like donations.
 */

/** Audit events for advertisement banners. */
export const AdBannerEvents = {
  Created: "ad_banner_created",
  Updated: "ad_banner_updated",
  StatusChanged: "ad_banner_status_changed",
  Deleted: "ad_banner_deleted",
  ImageUploaded: "ad_banner_image_uploaded",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/advertise-banners/list — every banner in display order. */
export async function list(_req: Request, res: Response) {
  const banners = await service.listBanners();
  res.json({ banners, total: banners.length });
}

/** GET /api/advertise-banners/:id — one banner (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ banner: await service.getBanner(Number(req.params.id)) });
}

/** POST /api/advertise-banners — create (the image attaches separately). */
export async function create(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const row = await service.createBanner({
    title: body.title,
    redirectUrl: body.redirectUrl,
    impressionMode: body.impressionMode,
    impressionCap: body.impressionCap,
    validityMode: body.validityMode,
    startDate: body.startDate,
    expiryDate: body.expiryDate,
    displayOrder: body.displayOrder,
    status: body.status as AdBannerStatus | undefined,
  });
  await writeAudit(req, AdBannerEvents.Created);
  res.status(201).json({ banner: row });
}

/** PUT /api/advertise-banners/:id — edit (status and image have their own routes). */
export async function update(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const row = await service.updateBanner(Number(req.params.id), {
    title: body.title,
    redirectUrl: body.redirectUrl,
    impressionMode: body.impressionMode,
    impressionCap: body.impressionCap,
    validityMode: body.validityMode,
    startDate: body.startDate,
    expiryDate: body.expiryDate,
    displayOrder: body.displayOrder,
  });
  await writeAudit(req, AdBannerEvents.Updated);
  res.json({ banner: row });
}

/** PATCH /api/advertise-banners/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: AdBannerStatus };
  const row = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, AdBannerEvents.StatusChanged);
  res.json({ banner: row });
}

/** DELETE /api/advertise-banners/:id — hard delete (no 'Deleted' enum member). */
export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findBanner(id);
  await service.deleteBanner(id);
  await writeAudit(req, AdBannerEvents.Deleted);
  // Remove the picture file too — a hard-deleted banner leaves nothing to show.
  if (row?.image) deleteImageFile(row.image);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Image: streamed from `<webImagesRoot>/AdvImages/` — the folder the legacy
// panel already used for these banners (it holds two historic
// `<timestamp>_<seq>.png` files that no other banner table references), so
// uploads stay reachable for the apps too. Uploads write a new timestamped
// file next to the old ones.
// ---------------------------------------------------------------------------

const IMAGE_DIR = "AdvImages";
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function imageContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

/** Resolve a banner image on disk: upload dir first, then the legacy dir. */
function resolveImage(filename: string): string | null {
  return resolveStoredMedia(IMAGE_DIR, path.basename(filename));
}

/**
 * Best-effort file removal used by the delete and replace paths. Anything that
 * lives in the legacy media dir is left in place — the old panel shares it.
 */
function deleteImageFile(filename: string) {
  deleteUploadedMedia(IMAGE_DIR, path.basename(filename));
}

/** GET /api/advertise-banners/:id/image — stream the stored image (404 when missing). */
export async function image(req: Request, res: Response) {
  const row = await model.findBanner(Number(req.params.id));
  if (!row || !row.image) throw AppError.notFound("No image on file");
  const abs = resolveImage(row.image);
  if (!abs) throw AppError.notFound("Image file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

const imageStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, uploadDir(IMAGE_DIR));
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

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: IMAGE_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXT.has(ext) && /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported file type. Use JPG, PNG, WEBP or GIF."));
    }
  },
});

/** Multer single-file middleware translating upload errors into AppError. */
export function imageUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  imageUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 5 MB)."));
    }
    return next(err);
  });
}

/** POST /api/advertise-banners/:id/image — attach or replace the banner image. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findBanner(id);
  if (!row) throw AppError.notFound(`Banner #${id} not found.`);
  if (!req.file) throw AppError.badRequest("No file uploaded.");

  try {
    await model.updateImage(id, req.file.filename);
  } catch (err) {
    // Don't leave an orphaned file behind when the DB write fails.
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
  await writeAudit(req, AdBannerEvents.ImageUploaded);
  // The previous picture is no longer referenced once the row points at the new one.
  if (row.image && row.image !== req.file.filename) deleteImageFile(row.image);
  res.json({ banner: await service.getBanner(id) });
}

