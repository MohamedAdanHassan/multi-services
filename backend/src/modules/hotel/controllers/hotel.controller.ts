import type { Request, Response, NextFunction } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import * as model from "../models/hotelModel";
import type { HotelRow, HotelStatus } from "../models/hotelModel";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import * as pwd from "../../auth/services/passwordService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for hotel lifecycle operations. */
export const HotelEvents = {
  Created: "hotel_created",
  Updated: "hotel_updated",
  StatusChanged: "hotel_status_changed",
  Deleted: "hotel_deleted",
  LogoUploaded: "hotel_logo_uploaded",
} as const;

/** MySQL zero-dates survive DATE_FORMAT; surface them honestly as null. */
function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** Public shape consumed by the hotel-management UI. */
function toDto(r: HotelRow) {
  const first = r.firstName ?? "";
  const last = r.lastName ?? "";
  const image = (r.image ?? "").trim();
  return {
    id: r.iHotelId,
    adminId: r.iAdminId,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    email: r.email ?? "",
    contactNo: r.contactNo ?? "",
    code: r.code ?? "",
    currency: r.currency ?? "",
    language: r.language ?? "",
    avgRating: r.avgRating ?? "0.0",
    status: r.eStatus,
    hasImage: image !== "",
    imageName: image,
    createdAt: cleanDate(r.tRegistrationDate),
  };
}

/** The acting administrator's id, or throw. */
function currentAdminId(req: Request): number {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.adminId;
}

export async function list(_req: Request, res: Response) {
  const rows = await model.listHotels();
  res.json({ hotels: rows.map(toDto) });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Hotel not found");
  res.json({ hotel: toDto(row) });
}

interface WriteBody {
  firstName: string;
  lastName: string;
  email: string;
  contactNo: string;
  code: string;
  currency: string;
  language: string;
  status?: Exclude<HotelStatus, "Deleted">;
  password?: string;
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;

  // A hotel owns an administrators login, so its email must be globally unique
  // and not already the login of another hotel. Blank emails are never checked
  // (many legacy rows are empty and would otherwise collide on '').
  if (b.email.trim() && (await model.adminEmailTaken(b.email))) {
    throw new AppError(409, "EMAIL_TAKEN", "An administrator with this email already exists");
  }
  if (b.email.trim() && (await model.hotelEmailTaken(b.email))) {
    throw new AppError(409, "EMAIL_TAKEN", "A hotel with this email already exists");
  }

  // The owner login requires a password (it gates the hotel panel).
  const password = (b.password ?? "").trim();
  if (!password) throw AppError.badRequest("A password is required for the hotel owner login");
  const passwordHash = await pwd.hashPassword(password);

  const id = await model.createHotel({
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    contactNo: b.contactNo,
    code: b.code,
    passwordHash,
    status: b.status ?? "Active",
    currency: b.currency,
    language: b.language,
  });
  audit.logQuiet(req, HotelEvents.Created, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ hotel: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Hotel not found");
  }
  const b = req.body as WriteBody;

  if (
    b.email.trim() &&
    b.email !== existing.email &&
    (await model.adminEmailTaken(b.email, existing.iAdminId))
  ) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another administrator");
  }
  if (b.email !== existing.email && (await model.hotelEmailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another hotel");
  }

  await model.updateOwnerAdmin(existing.iAdminId, b);
  await model.updateHotel(id, b);
  audit.logQuiet(req, HotelEvents.Updated, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.json({ hotel: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Hotel not found");
  }
  const { status } = req.body as { status: Exclude<HotelStatus, "Deleted"> };

  // Never deactivate the login of the admin performing the action.
  if (existing.iAdminId === currentAdminId(req)) {
    throw AppError.badRequest("You cannot change the status of your own account");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, HotelEvents.StatusChanged, { adminId: null, email: existing.email });

  const row = await model.findRow(id);
  res.json({ hotel: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Hotel not found");
  }
  if (existing.iAdminId === currentAdminId(req)) {
    throw AppError.badRequest("You cannot delete your own account");
  }

  await model.softDelete(id);
  audit.logQuiet(req, HotelEvents.Deleted, { adminId: null, email: existing.email });
  res.json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// Hotel logo (uploaded under `${webImagesRoot}/hotel/<id>/`).
// ---------------------------------------------------------------------------

/** Content-Type for a hotel logo (images only; defaults to JPEG). */
function imageContentType(filePath: string): string {
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

async function requireActiveHotel(id: number): Promise<HotelRow> {
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Hotel not found");
  return row;
}

/** Stream a hotel's stored logo file, guarding against path traversal. */
export async function imageFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const filename = await model.getHotelImage(id);
  if (!filename) throw AppError.notFound("No logo on file");

  const abs = resolveStoredMedia("hotel", String(id), path.basename(filename));
  if (!abs) throw AppError.notFound("Logo file missing");

  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

const IMG_MAX_BYTES = 10 * 1024 * 1024;
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMG_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const imgStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("hotel", String(req.params.id)));
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

const imgUpload = multer({
  storage: imgStorage,
  limits: { fileSize: IMG_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMG_EXT.has(ext) && IMG_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported file type. Use JPG, PNG, WEBP or GIF."));
    }
  },
});

export function imgUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  imgUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 10 MB)."));
    }
    return next(err);
  });
}

/** Replace a hotel's logo: persist the new filename and drop the previous file. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActiveHotel(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");

  const previous = await model.getHotelImage(id);
  try {
    await model.setHotelImage(id, req.file.filename);
  } catch (err) {
    try {
      unlinkSync(req.file.path);
    } catch {
      /* ignore */
    }
    throw err;
  }
  // Best-effort cleanup of the replaced file; never fatal. A legacy-panel logo is
  // deliberately left on disk, since the old app shares it.
  if (previous && previous !== req.file.filename) {
    deleteUploadedMedia("hotel", String(id), path.basename(previous));
  }

  audit.logQuiet(req, HotelEvents.LogoUploaded, { adminId: null, email: null });
  const row = await model.findRow(id);
  res.status(201).json({ hotel: row ? toDto(row) : null });
}

