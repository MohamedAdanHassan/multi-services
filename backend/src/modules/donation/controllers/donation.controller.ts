import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import { resolveStoredMedia, uploadDir } from "../../../utils/media";
import type { DonationStatus } from "../models/donationModel";
import * as service from "../services/donationService";
import * as model from "../models/donationModel";
import * as audit from "../../audit/services/auditService";

/** Audit events for donation management. */
export const DonationEvents = {
  Created: "donation_created",
  Updated: "donation_updated",
  Translated: "donation_translations_updated",
  StatusChanged: "donation_status_changed",
  Deleted: "donation_deleted",
  ImageUploaded: "donation_image_uploaded",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/donations/list — live donations in display order. */
export async function list(_req: Request, res: Response) {
  const donations = await service.listDonations();
  res.json({ donations, total: donations.length });
}

/** GET /api/donations/:id — one donation (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ donation: await service.getDonation(Number(req.params.id)) });
}

/** POST /api/donations — create (English texts; image attaches separately). */
export async function create(req: Request, res: Response) {
  const row = await service.createDonation(
    req.body as { title: unknown; description: unknown; link?: unknown; displayOrder?: unknown; status?: DonationStatus },
  );
  await writeAudit(req, DonationEvents.Created);
  res.status(201).json({ donation: row });
}

/** PUT /api/donations/:id — edit English texts / link / order (other languages preserved). */
export async function update(req: Request, res: Response) {
  const row = await service.updateDonation(
    Number(req.params.id),
    req.body as { title: unknown; description: unknown; link?: unknown; displayOrder?: unknown },
  );
  await writeAudit(req, DonationEvents.Updated);
  res.json({ donation: row });
}

/** GET /api/donations/:id/translations — per-language title/description batch. */
export async function translations(req: Request, res: Response) {
  const id = Number(req.params.id);
  res.json({ id, languages: await service.getTranslations(id) });
}

/** PUT /api/donations/:id/translations — merge `{ titles, descriptions }` maps. */
export async function updateTranslations(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { titles, descriptions } = req.body as {
    titles?: Record<string, string>;
    descriptions?: Record<string, string>;
  };
  const row = await service.updateTranslations(id, { titles, descriptions });
  await writeAudit(req, DonationEvents.Translated);
  res.json({ donation: row });
}

/** PATCH /api/donations/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: DonationStatus };
  const row = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, DonationEvents.StatusChanged);
  res.json({ donation: row });
}

/** DELETE /api/donations/:id — soft delete. */
export async function remove(req: Request, res: Response) {
  await service.deleteDonation(Number(req.params.id));
  await writeAudit(req, DonationEvents.Deleted);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Image: streamed from `<webImagesRoot>/donation/` (legacy layout), replaced
// via a multipart POST that stores a new timestamped file next to the old ones.
// ---------------------------------------------------------------------------

const IMAGE_DIR = "donation";
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

/** Resolve a donation image on disk: upload dir first, then the legacy dir. */
function resolveImage(filename: string): string | null {
  return resolveStoredMedia(IMAGE_DIR, path.basename(filename));
}

/** GET /api/donations/:id/image — stream the stored image (404 when missing). */
export async function image(req: Request, res: Response) {
  const row = await model.findDonation(Number(req.params.id));
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

/** POST /api/donations/:id/image — attach or replace the donation image. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findDonation(id);
  if (!row) throw AppError.notFound(`Donation #${id} not found.`);
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
  await writeAudit(req, DonationEvents.ImageUploaded);
  res.json({ donation: await service.getDonation(id) });
}

