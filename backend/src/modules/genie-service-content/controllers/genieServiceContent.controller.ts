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
  resolveLegacySiteFile,
  resolveStoredMedia,
  uploadDir,
} from "../../../utils/media";
import type {
  ImageSlotSpec,
  ServiceContentApp,
  ServiceContentStatus,
} from "../models/genieServiceContentModel";
import { requireScope } from "../models/genieServiceContentModel";
import * as service from "../services/genieServiceContentService";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for "Manage Service/Content": a delivery app's root `vehicle_category` row,
 * its two tabs and its four artwork columns — Delivery Genie (group 33 → #sub-141) and
 * Delivery Runner (group 34 → #sub-144), whichever the `:app` segment names.
 *
 * The audit events are named per app, from the same segment: `service_content_genie_*` for
 * one row and `service_content_runner_*` for the other. Every other module that writes
 * `vehicle_category` calls its own events `service_category_*` / `content_*`, so an admin
 * log can tell "the Genie root row" apart from "the Runner root row", the taxi's Ride
 * categories and the `content_cjx_details` screens instead of guessing from a timestamp.
 */
function eventsOf(app: ServiceContentApp) {
  return {
    updated: `service_content_${app}_updated`,
    statusChanged: `service_content_${app}_status_changed`,
    imageChanged: `service_content_${app}_image_changed`,
  };
}

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** The app whose row this instance serves, from the route's `:app` segment. */
function scopeOf(req: Request) {
  return requireScope(req.params.app);
}

/** GET /api/genie-service-content/:app/list — the app's root row(s). */
export async function list(req: Request, res: Response) {
  const items = await service.listContent(scopeOf(req));
  res.json({ items, total: items.length });
}

/** GET /api/genie-service-content/:app/:id — names, copy, artwork, settings, promotion. */
export async function getOne(req: Request, res: Response) {
  const scope = scopeOf(req);
  res.json({ item: await service.getContent(scope, Number(req.params.id)) });
}

/**
 * PUT /api/genie-service-content/:app/:id — merge the changed names, settings and copy.
 * `promotedCleared` rides along so the editor can say out loud that turning the banner on
 * switched other services off, which is what the legacy tooltip promised.
 */
export async function update(req: Request, res: Response) {
  const scope = scopeOf(req);
  const body = req.body as Record<string, unknown>;
  for (const [group, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw AppError.badRequest(`“${group}” must be a map of the fields that changed.`);
    }
  }
  if (!Object.keys(body).length) {
    throw AppError.badRequest("Send at least one of `names`, `settings` or `copy`.");
  }
  // The shape of each group is checked key by key by the service, which names the field it
  // refused; this layer only proves each group is an object before handing it over.
  const input: service.ServiceContentUpdate = {
    names: body.names as Record<string, unknown> | undefined,
    settings: body.settings as Record<string, unknown> | undefined,
    copy: body.copy as Record<string, Record<string, unknown>> | undefined,
  };
  const { item, promotedCleared } = await service.updateContent(scope, Number(req.params.id), input);
  await writeAudit(req, eventsOf(scope.app).updated);
  res.json({ item, promotedCleared });
}

/** PATCH /api/genie-service-content/:app/:id/status — flip this row's switch only. */
export async function setStatus(req: Request, res: Response) {
  const scope = scopeOf(req);
  const { status } = req.body as { status: ServiceContentStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, eventsOf(scope.app).statusChanged);
  res.json({ item });
}

// ---------------------------------------------------------------------------
// Artwork. Four columns, and the directory a file lives in is part of what the column
// means: the legacy panel filed the list icon and the promotional image per row under
// `webimages/icons/VehicleCategory/<rowId>/`, and the home-page artwork flat under
// `assets/img/home-new/services/`. New uploads land in this app's own upload root, one
// flat folder per legacy tree, so the two are never confused for each other — and a row
// whose bytes only exist in the legacy install still shows its image, because both are
// consulted on read. Nothing is ever written to, or deleted from, the legacy tree.
// ---------------------------------------------------------------------------

/** The slot a request addresses, with its column, write dir and legacy dir. */
function slotOf(req: Request): ImageSlotSpec {
  return service.requireSlot(req.params.slot);
}

/** Resolve one stored file: this app's upload dir first, then the legacy install tree. */
function resolveSlotImage(slot: ImageSlotSpec, id: number, filename: string): string | null {
  const base = path.basename(filename);
  const managed = resolveStoredMedia(slot.dir, base);
  if (managed) return managed;
  return resolveLegacySiteFile(...slot.legacyDir(id), base);
}

const imageStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir(slotOf(req).dir));
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

/** GET /api/genie-service-content/:app/:id/image/:slot — stream the stored file. */
export async function image(req: Request, res: Response) {
  const scope = scopeOf(req);
  const id = Number(req.params.id);
  const slot = slotOf(req);
  const filename = await service.getImageFilename(scope, id, slot);
  if (!filename) throw AppError.notFound(`No ${slot.label.toLowerCase()} on file`);
  const abs = resolveSlotImage(slot, id, filename);
  if (!abs) throw AppError.notFound("Image file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/** POST /api/genie-service-content/:app/:id/image/:slot — attach or replace one file. */
export async function uploadImage(req: Request, res: Response) {
  const scope = scopeOf(req);
  const id = Number(req.params.id);
  const slot = slotOf(req);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  try {
    // The row is read inside the try: multer has already written the file by now, so every
    // failure below — an id belonging to another app, a child row, a stuck statement — has
    // to undo that write rather than leave an orphan nothing points at.
    const previous = await service.getImageFilename(scope, id, slot);
    const item = await service.setImageFilename(scope, id, slot, req.file.filename);
    if (previous && previous !== req.file.filename) {
      // Best effort: the row already points at the new file, and a name the legacy panel
      // owns is deliberately left on disk because other rows and the old app share it.
      deleteUploadedMedia(slot.dir, path.basename(previous));
    }
    await writeAudit(req, eventsOf(scope.app).imageChanged);
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
