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
  resolveStoredArtwork,
  uploadDir,
} from "../../../utils/media";
import * as service from "../services/bannerService";
import type { BannerCreate, BannerUpdate } from "../services/bannerService";
import type { BannerStatus } from "../models/bannerModel";
import { requireBannerApp } from "../models/bannerModel";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for the Banners screen, which three apps share through the `:app` segment:
 * Parcel Delivery (#sub-140, display group 32), Delivery Genie (#sub-142, display group
 * 33) and Delivery Runner (#sub-143, display group 34). Each handler resolves the
 * segment to a `BannerAppScope` before touching the service, so the same code reads and
 * rewrites only the caller's `eType` slice.
 *
 * Everything group-shaped is the service's problem; this file only moves bytes. A
 * banner's picture is a bare file name in `vImage`, and the shipped artwork lives in a
 * third, FLAT root the other screens never touch, so reads go through
 * `resolveStoredArtwork` — this app's own upload folder first, then the legacy media
 * tree, then the artwork the apps ship. Deletes stay inside the upload folder: a file
 * the legacy product wrote is shared by rows this screen does not own.
 */

/** Audit events for banners. */
export const BannerEvents = {
  Created: "banner_created",
  Updated: "banner_updated",
  StatusChanged: "banner_status_changed",
  Deleted: "banner_deleted",
  ImageUploaded: "banner_image_uploaded",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/banner/:app/list — banner groups of one app's slice. With no
 * `page`/`limit`/`search`/`status` query the whole slice is returned; once any is
 * present it switches to a filtered page and adds `page`/`limit`/`pages` for the pager.
 */
export async function list(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listBannersPaged(scope, q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listBanners(scope);
  res.json({ items, total: items.length });
}

/**
 * GET /api/banner/:app/defaults — the next free display slot of this slice and the 26
 * languages the add form has to offer, so the form asks the server what may be filled
 * in.
 */
export async function defaults(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  res.json({ item: await service.blankRecord(scope) });
}

/** GET /api/banner/:app/:id — one banner with every language row. */
export async function getOne(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  res.json({ item: await service.getBanner(scope, Number(req.params.id)) });
}

/** POST /api/banner/:app — add a banner to this app's slice (its picture attaches separately). */
export async function create(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const item = await service.createBanner(scope, req.body as BannerCreate);
  await writeAudit(req, BannerEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/banner/:app/:id — write the changed languages, slot and colour. */
export async function update(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const item = await service.updateBanner(scope, Number(req.params.id), req.body as BannerUpdate);
  await writeAudit(req, BannerEvents.Updated);
  res.json({ item });
}

/** PATCH /api/banner/:app/:id/status — activate / deactivate every row of the group. */
export async function setStatus(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const { status } = req.body as { status: BannerStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, BannerEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/banner/:app/:id — name-confirmed hard delete of the whole group. */
export async function remove(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteBanner(scope, Number(req.params.id), confirm);
  await writeAudit(req, BannerEvents.Deleted);
  // A hard delete leaves nothing to show, so the picture goes too — but only when no
  // surviving row names it, and only when this app wrote it.
  if (result.image && !result.imageStillReferenced) {
    deleteUploadedMedia(IMAGE_DIR, path.basename(result.image));
  }
  res.json({ ok: true, ...result });
}

// ---------------------------------------------------------------------------
// Image. `vImage` holds a bare file name that the apps resolve against their own
// `/assets/img/images/` directory, so the flat artwork root is part of every read.
// ---------------------------------------------------------------------------

/** Sub-directory new banner pictures are written to (created on demand). */
const IMAGE_DIR = "Banners";

/** Resolve a stored banner picture on disk, including the shipped flat artwork root. */
function resolveImage(filename: string): string | null {
  return resolveStoredArtwork(IMAGE_DIR, filename);
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
export function imageUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  imageUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 5 MB)."));
    }
    return next(err);
  });
}

/** GET /api/banner/:app/:id/image — stream the stored picture (404 when missing). */
export async function image(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const filename = await service.getImageFilename(scope, Number(req.params.id));
  if (!filename) throw AppError.notFound("No image on file");
  const abs = resolveImage(filename);
  if (!abs) throw AppError.notFound("Image file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/** POST /api/banner/:app/:id/image — attach or replace the group's picture. */
export async function uploadImage(req: Request, res: Response) {
  const scope = requireBannerApp(req.params.app);
  const id = Number(req.params.id);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  try {
    // The group is read inside the try: multer has written the file by now, so every
    // failure below — an unknown id, a stuck statement — has to undo that write
    // rather than leave an orphan nothing points at.
    const result = await service.attachImage(scope, id, req.file.filename);
    if (result.previousImage && result.previousImage !== req.file.filename) {
      // Best effort: the rows already point at the new file. One the legacy data still
      // names from another banner is deliberately left on disk.
      if (!result.previousStillReferenced) {
        deleteUploadedMedia(IMAGE_DIR, path.basename(result.previousImage));
      }
    }
    await writeAudit(req, BannerEvents.ImageUploaded);
    res.json({ item: result.banner });
  } catch (err) {
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

