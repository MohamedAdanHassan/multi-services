import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import type { ImageStatus } from "../models/giftCardImagesModel";
import * as service from "../services/giftCardImagesService";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for Marketing Tools → Manage Gift Cards (#sub-111), the artwork
 * half. Rows are one cell of a design × language matrix, so the listing is asked
 * per language and the file itself is uploaded to (and streamed from) the legacy
 * `<webImagesRoot>/GiftCard/` folder the apps already read.
 */

/** Audit events for gift card artwork. */
export const GiftCardImageEvents = {
  Created: "gift_card_image_created",
  Updated: "gift_card_image_updated",
  StatusChanged: "gift_card_image_status_changed",
  Deleted: "gift_card_image_deleted",
  FileUploaded: "gift_card_image_file_uploaded",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/gift-card-images — one language's design set + the language picker. */
export async function list(req: Request, res: Response) {
  const { code } = req.query as { code?: string };
  const page = await service.getPage(code);
  res.json({ ...page, total: page.images.length });
}

/** GET /api/gift-card-images/:id — one row (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ image: await service.getImage(Number(req.params.id)) });
}

/** POST /api/gift-card-images — add a design slot (the file attaches separately). */
export async function create(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const image = await service.createImage({
    code: body.code,
    displayOrder: body.displayOrder,
    status: body.status,
  });
  await writeAudit(req, GiftCardImageEvents.Created);
  res.status(201).json({ image });
}

/** PUT /api/gift-card-images/:id — edit language / slot (status and file have their own routes). */
export async function update(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const image = await service.updateImage(Number(req.params.id), {
    code: body.code,
    displayOrder: body.displayOrder,
  });
  await writeAudit(req, GiftCardImageEvents.Updated);
  res.json({ image });
}

/** PATCH /api/gift-card-images/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: ImageStatus };
  const image = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, GiftCardImageEvents.StatusChanged);
  res.json({ image });
}

/**
 * DELETE /api/gift-card-images/:id — soft delete. No file is touched: the row
 * keeps naming its artwork, and other languages' rows name the same file.
 */
export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  await service.deleteImage(id);
  await writeAudit(req, GiftCardImageEvents.Deleted);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// File: `<webImagesRoot>/GiftCard/` — the folder the legacy panel filled with
// these designs and the apps load card artwork from. One filename is shared by
// every language's row for that design, so a replaced file may only leave the
// disk when no row still names it (the service answers that question).
// ---------------------------------------------------------------------------

const IMAGE_DIR = "GiftCard";
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

/** Resolve an artwork file on disk: upload dir first, then the legacy dir. */
function resolveImage(filename: string): string | null {
  return resolveStoredMedia(IMAGE_DIR, path.basename(filename));
}

/**
 * Best-effort removal of a file the database no longer points at. Legacy-panel
 * artwork is left on disk — it is shared with the old app.
 */
function deleteImageFile(filename: string) {
  deleteUploadedMedia(IMAGE_DIR, path.basename(filename));
}

/** GET /api/gift-card-images/:id/image — stream the stored artwork (404 when missing). */
export async function image(req: Request, res: Response) {
  const row = await service.getImage(Number(req.params.id));
  if (!row.hasFile) throw AppError.notFound("No artwork file on file for this design.");
  const abs = resolveImage(row.image);
  if (!abs) throw AppError.notFound("Artwork file missing from disk.");
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

/** POST /api/gift-card-images/:id/image — attach or replace this row's artwork. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  let result: { previous: string; removable: boolean };
  try {
    result = await service.replaceFile(id, req.file.filename);
  } catch (err) {
    // Don't leave an orphaned file behind when the database write fails.
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
  await writeAudit(req, GiftCardImageEvents.FileUploaded);
  // Only drop the old file when this row was its last reference.
  if (result.previous && result.removable) deleteImageFile(result.previous);
  res.json({ image: await service.getImage(id) });
}

