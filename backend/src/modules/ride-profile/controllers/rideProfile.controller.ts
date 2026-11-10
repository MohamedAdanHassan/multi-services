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
  storedMediaSegments,
  uploadDir,
} from "../../../utils/media";
import * as service from "../services/rideProfileService";
import type { RideProfileCreate, RideProfileUpdate } from "../services/rideProfileService";
import type { ProfileStatus } from "../models/rideProfileModel";
import * as audit from "../../audit/services/auditService";

/** Audit events for ride profiles. */
export const RideProfileEvents = {
  Created: "ride_profile_created",
  Updated: "ride_profile_updated",
  StatusChanged: "ride_profile_status_changed",
  Deleted: "ride_profile_deleted",
  MediaChanged: "ride_profile_media_changed",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/ride-profile/list — live profiles. With no `page`/`limit`/`search`/
 * `status` query the full list is returned; once any is present it switches to a
 * filtered SQL page and adds `page`/`limit`/`pages` for the pager.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listProfilesPaged(q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listProfiles();
  res.json({ items, total: items.length });
}

/** GET /api/ride-profile/defaults — an empty profile, so the form knows its 26 tabs. */
export async function defaults(_req: Request, res: Response) {
  res.json({ item: await service.blankRecord() });
}

/** GET /api/ride-profile/:id — one profile with every stored language. */
export async function getOne(req: Request, res: Response) {
  res.json({ item: await service.getProfile(Number(req.params.id)) });
}

/** POST /api/ride-profile — add a profile. */
export async function create(req: Request, res: Response) {
  const item = await service.createProfile(req.body as RideProfileCreate);
  await writeAudit(req, RideProfileEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/ride-profile/:id — merge the copy and artwork that changed. */
export async function update(req: Request, res: Response) {
  const item = await service.updateProfile(Number(req.params.id), req.body as RideProfileUpdate);
  await writeAudit(req, RideProfileEvents.Updated);
  res.json({ item });
}

/** PATCH /api/ride-profile/:id/status — activate / deactivate a profile. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: ProfileStatus };
  const item = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, RideProfileEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/ride-profile/:id — name-confirmed, usage-guarded soft delete. */
export async function remove(req: Request, res: Response) {
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteProfile(Number(req.params.id), confirm);
  await writeAudit(req, RideProfileEvents.Deleted);
  res.json({ ok: true, ...result });
}

// ---------------------------------------------------------------------------
// Artwork. A profile owns two columns (`image`, `welcomeImage`), each storing a bare
// file name the apps concatenate into a URL, so the upload is keyed by `?field=` and
// both write into one flat directory.
// ---------------------------------------------------------------------------

/**
 * The legacy panel keeps profile artwork in `ProfileMaster/`, and `resolveStoredMedia`
 * looks up the same relative path in the read-only root, so the directory is named after
 * the old one rather than after this module: profile #1's `profileicon.png` only reads back
 * because the two trees agree on the folder name.
 */
const MEDIA_DIR = "ProfileMaster";

/** Which of the two columns this request is about; the service refuses an unknown key. */
function mediaField(req: Request): string {
  const raw = (req.query as Record<string, unknown>).field;
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}

/** Resolve a stored name on disk: this app's upload dir, then the legacy dir. */
function resolveMedia(filename: string): string | null {
  return resolveStoredMedia(...storedMediaSegments(MEDIA_DIR, filename));
}

const mediaStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, uploadDir(MEDIA_DIR));
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

const mediaUpload = multer({
  storage: mediaStorage,
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
export function mediaUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  mediaUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 5 MB)."));
    }
    return next(err);
  });
}

/** GET /api/ride-profile/:id/image?field=image|welcomeImage — stream the artwork. */
export async function image(req: Request, res: Response) {
  const filename = await service.getMediaFilename(Number(req.params.id), mediaField(req));
  if (!filename) throw AppError.notFound("No image on file");
  const abs = resolveMedia(filename);
  if (!abs) throw AppError.notFound("Image file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/** POST /api/ride-profile/:id/image?field=… — attach or replace one artwork column. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  const field = mediaField(req);
  if (!req.file) throw AppError.badRequest("No file uploaded.");

  const stored = req.file;
  try {
    // The row is read inside the try: multer has already written the file by now, so
    // every failure below — unknown field, deleted profile, stuck statement — has to
    // undo that write rather than leave an orphan nothing points at.
    const previous = await service.getMediaFilename(id, field);
    const item = await service.setMediaFilename(id, field, stored.filename);
    if (previous && previous !== stored.filename) {
      // Best effort: the row already points at the new file, and a name the legacy
      // panel owns is deliberately left on disk because other rows share it.
      deleteUploadedMedia(...storedMediaSegments(MEDIA_DIR, previous));
    }
    await writeAudit(req, RideProfileEvents.MediaChanged);
    res.json({ item });
  } catch (err) {
    // Undo the disk write, so a refused upload leaves no file behind.
    try {
      unlinkSync(stored.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

