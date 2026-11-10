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
import * as service from "../services/organizationService";
import type { OrganizationInput } from "../services/organizationService";
import type { OrganizationStatus } from "../models/organizationModel";
import * as audit from "../../audit/services/auditService";

/** Audit events for organizations. */
export const OrganizationEvents = {
  Created: "organization_created",
  Updated: "organization_updated",
  StatusChanged: "organization_status_changed",
  Deleted: "organization_deleted",
  Exported: "organization_exported",
  MediaChanged: "organization_media_changed",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/organization/list — live organizations. With no `page`/`limit`/`search`/
 * `status` query the full list is returned; once any is present it switches to a
 * filtered SQL page and adds `page`/`limit`/`pages` for the pager.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listOrganizationsPaged(q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listOrganizations();
  res.json({ items, total: items.length });
}

/**
 * GET /api/organization/defaults — an empty organization plus the ride profiles the
 * picker may offer, so the add form asks the server what may be filled in.
 */
export async function defaults(_req: Request, res: Response) {
  const [item, profiles] = await Promise.all([
    service.blankRecord(),
    service.listProfileOptions(),
  ]);
  res.json({ item, profiles });
}

/** GET /api/organization/profiles — ride profiles an organization can be filed under. */
export async function profiles(_req: Request, res: Response) {
  res.json({ profiles: await service.listProfileOptions() });
}

/** GET /api/organization/:id — one organization, payout block included. */
export async function getOne(req: Request, res: Response) {
  res.json({ item: await service.getOrganization(Number(req.params.id)) });
}

/** POST /api/organization — add an organization. */
export async function create(req: Request, res: Response) {
  const item = await service.createOrganization(req.body as OrganizationInput);
  await writeAudit(req, OrganizationEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/organization/:id — write the fields the request names. */
export async function update(req: Request, res: Response) {
  const item = await service.updateOrganization(Number(req.params.id), req.body as OrganizationInput);
  await writeAudit(req, OrganizationEvents.Updated);
  res.json({ item });
}

/** PATCH /api/organization/:id/status — activate / deactivate an account. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: OrganizationStatus };
  const item = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, OrganizationEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/organization/:id — name-confirmed, usage-guarded soft delete. */
export async function remove(req: Request, res: Response) {
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteOrganization(Number(req.params.id), confirm);
  await writeAudit(req, OrganizationEvents.Deleted);
  res.json({ ok: true, ...result });
}

/** Quote a CSV cell the legacy-export way (BOM + CRLF added at send time). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * GET /api/organization/export — the on-screen listing as CSV. Rows come from the
 * list projection, so the payout block cannot appear here even by accident.
 */
export async function exportCsv(req: Request, res: Response) {
  const rows = await service.csvRows();
  const lines = [
    service.CSV_HEADER.map(csvField).join(","),
    ...rows.map((r) => r.map(csvField).join(",")),
  ];
  await writeAudit(req, OrganizationEvents.Exported);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="organizations.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------------------
// Artwork. Two columns (`image`, `coverImage`) each store a bare file name, so both are
// served and written through one pair of endpoints keyed by `?field=`.
// ---------------------------------------------------------------------------

/**
 * The legacy panel's folder for this table is `Organization/`, and `resolveStoredMedia`
 * looks up the same relative path in the read-only root, so the directory is named after
 * the old one rather than after this module. New files land in `backend/uploads` with the
 * same shape, which is what lets a name written by either panel be read back; deletions
 * still stop at this app's own root.
 */
const MEDIA_DIR = "Organization";

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

/** GET /api/organization/:id/image?field=image|coverImage — stream the artwork. */
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

/** POST /api/organization/:id/image?field=… — attach or replace one artwork column. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  const field = mediaField(req);
  if (!req.file) throw AppError.badRequest("No file uploaded.");

  const stored = req.file;
  try {
    // The row is read inside the try: multer has already written the file by now, so
    // every failure below — unknown field, deleted organization, stuck statement — has
    // to undo that write rather than leave an orphan nothing points at.
    const previous = await service.getMediaFilename(id, field);
    const item = await service.setMediaFilename(id, field, stored.filename);
    if (previous && previous !== stored.filename) {
      // Best effort: the row already points at the new file, and a name the legacy
      // panel owns is deliberately left on disk because other rows share it.
      deleteUploadedMedia(...storedMediaSegments(MEDIA_DIR, previous));
    }
    await writeAudit(req, OrganizationEvents.MediaChanged);
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

