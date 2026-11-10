import type { NextFunction, Request, Response } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import * as model from "../models/storeModel";
import type { StoreRow, StoreStatus, StoreDocumentRow, StoreListFilters } from "../models/storeModel";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import * as pwd from "../../auth/services/passwordService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for store lifecycle operations. */
export const StoreEvents = {
  Created: "store_created",
  Updated: "store_updated",
  StatusChanged: "store_status_changed",
  Deleted: "store_deleted",
  ImageChanged: "store_image_changed",
  DocReviewed: "store_doc_reviewed",
  DocUploaded: "store_doc_uploaded",
} as const;

/** MySQL zero-dates survive DATE_FORMAT; surface them honestly as null. */
function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** Public shape consumed by the store-management UI. */
function toDto(r: StoreRow) {
  return {
    id: r.iCompanyId,
    serviceId: r.iServiceId,
    serviceName: r.serviceName,
    store: r.store ?? "",
    contactName: r.contactName ?? "",
    firstName: r.firstName ?? "",
    lastName: r.lastName ?? "",
    name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
    email: r.email ?? "",
    phone: r.phone ?? "",
    phoneCode: r.phoneCode ?? "",
    address: r.address ?? "",
    city: r.city ?? "",
    state: r.state ?? "",
    country: r.country ?? "",
    zip: r.zip ?? "",
    location: r.location ?? "",
    locationLat: r.locationLat ?? "",
    locationLng: r.locationLng ?? "",
    maxItemQty: r.maxItemQty ?? 0,
    language: r.language ?? "",
    currency: r.currency ?? "",
    status: r.eStatus,
    hasImage: (r.hasImage ?? "").trim() !== "",
    createdAt: cleanDate(r.tRegistrationDate),
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/store/list — one filtered page of live stores plus the totals the
 * UI needs for its pager. Search / status / industry are applied in SQL so the
 * browser never holds the whole (dual-purpose) company table in memory.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const search = String(q.search ?? "").trim();
  const status = q.status === "Active" || q.status === "Inactive" ? q.status : undefined;
  const serviceId = Number(q.serviceId ?? 0);
  const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let page = Math.max(Number(q.page) || 1, 1);

  const filters: StoreListFilters = {
    search,
    status,
    serviceId: serviceId > 0 ? serviceId : undefined,
  };
  // COUNT and the page fetch run concurrently; the rare out-of-range page
  // (e.g. after deleting the last row) costs one small refetch.
  const [total, firstRows] = await Promise.all([
    model.countStores(filters),
    model.listStorePage({ ...filters, page, limit }),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  let rows = firstRows;
  if (page > pages) {
    page = pages;
    rows = await model.listStorePage({ ...filters, page, limit });
  }
  res.json({ stores: rows.map(toDto), total, page, limit, pages });
}

export async function industries(_req: Request, res: Response) {
  const options = await model.listIndustries();
  res.json({ options });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Store not found");
  res.json({ store: toDto(row) });
}

interface WriteBody {
  store: string;
  serviceId: number;
  contactName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  location: string;
  locationLat: string;
  locationLng: string;
  maxItemQty: number;
  language: string;
  currency: string;
  status: Exclude<StoreStatus, "Deleted">;
  password?: string;
}

async function requireKnownIndustry(serviceId: number, current?: number): Promise<void> {
  // Editing a store back to its (now inactive) industry stays honest: only a
  // CHANGE must reference an existing service_categories row.
  if (current !== undefined && current === serviceId) return;
  if (!(await model.industryExists(serviceId))) {
    throw AppError.badRequest("Unknown industry");
  }
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;
  await requireKnownIndustry(b.serviceId);

  if (await model.emailTaken(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "A store with this email already exists");
  }

  // Store-panel logins carry bcrypt passwords; hash only if one is given.
  const passwordHash = b.password ? await pwd.hashPassword(b.password) : "";

  const id = await model.createStore({
    store: b.store,
    serviceId: b.serviceId,
    contactName: b.contactName,
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    phoneCode: b.phoneCode,
    address: b.address,
    city: b.city,
    state: b.state,
    country: b.country,
    zip: b.zip,
    location: b.location,
    locationLat: b.locationLat,
    locationLng: b.locationLng,
    maxItemQty: b.maxItemQty,
    language: b.language,
    currency: b.currency,
    status: b.status,
    passwordHash,
  });
  audit.logQuiet(req, StoreEvents.Created, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ store: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Store not found");
  }
  const b = req.body as WriteBody;
  await requireKnownIndustry(b.serviceId, existing.iServiceId);

  if (b.email !== existing.email && (await model.emailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another store");
  }

  await model.updateStore(id, {
    store: b.store,
    serviceId: b.serviceId,
    contactName: b.contactName,
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    phoneCode: b.phoneCode,
    address: b.address,
    city: b.city,
    state: b.state,
    country: b.country,
    zip: b.zip,
    location: b.location,
    locationLat: b.locationLat,
    locationLng: b.locationLng,
    maxItemQty: b.maxItemQty,
    language: b.language,
    currency: b.currency,
  });
  audit.logQuiet(req, StoreEvents.Updated, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.json({ store: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Store not found");
  }
  const { status } = req.body as { status: StoreStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a store");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, StoreEvents.StatusChanged, { adminId: null, email: existing.email });

  const row = await model.findRow(id);
  res.json({ store: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Store not found");
  }

  await model.softDelete(id);
  audit.logQuiet(req, StoreEvents.Deleted, { adminId: null, email: existing.email });
  res.json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// CSV export (matches the on-screen listing).
// ---------------------------------------------------------------------------

/** Quote a CSV cell the legacy-export way (BOM + CRLF added at send time). */
function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  "ID", "Store", "Industry", "Contact", "Email", "Phone",
  "Address", "City", "Country", "Location", "Status", "Registered",
];

export async function exportCsv(req: Request, res: Response) {
  const rows = await model.listStores();
  const lines = [
    CSV_HEADER.map(csvField).join(","),
    ...rows.map((r) =>
      [
        r.iCompanyId,
        r.store ?? "",
        r.serviceName,
        r.contactName || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
        r.email ?? "",
        `${r.phoneCode ?? ""} ${r.phone ?? ""}`.trim(),
        r.address ?? "",
        r.city ?? "",
        r.country ?? "",
        r.location ?? "",
        r.eStatus,
        cleanDate(r.tRegistrationDate) ?? "",
      ]
        .map(csvField)
        .join(","),
    ),
  ];
  audit.logQuiet(req, "store_exported", { adminId: null, email: null });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="stores.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------------------
// Store logo — streamed from the legacy `Company/<id>/` image directory.
// ---------------------------------------------------------------------------

/** Content-Type for an image file (defaults to JPEG, like the legacy panel). */
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

export async function imageFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Store not found");
  const filename = (row.hasImage ?? "").trim();
  if (!filename) throw AppError.notFound("No logo on file");

  const abs = resolveStoredMedia("Company", String(id), path.basename(filename));
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
    const id = Number(req.params.id);
    try {
      cb(null, uploadDir("Company", String(id)));
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `${Math.floor(Date.now() / 1000)}_${rand}${ext}`);
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

export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Store not found");
  }
  if (!req.file) throw AppError.badRequest("No file uploaded");

  const previous = (existing.hasImage ?? "").trim();
  await model.setImage(id, req.file.filename);
  if (previous && previous !== req.file.filename) {
    // Best-effort cleanup of the replaced file; the DB already points at the new
    // one. Legacy-panel logos stay on disk — the old app shares them.
    deleteUploadedMedia("Company", String(id), path.basename(previous));
  }
  audit.logQuiet(req, StoreEvents.ImageChanged, { adminId: null, email: null });

  const row = await model.findRow(id);
  res.status(201).json({ store: row ? toDto(row) : null });
}

// ---------------------------------------------------------------------------
// Store documents (view / approve / reject / upload / replace).
// ---------------------------------------------------------------------------

/** Legacy placeholder expiry dates (zero / epoch / sentinel) map back to blank. */
function cleanDocDate(v: string | null): string {
  if (
    !v ||
    v.startsWith("0000") ||
    v.startsWith("1970-01-01") ||
    v.startsWith("1969-12-31") ||
    v.startsWith("1000-01-01")
  ) {
    return "";
  }
  return v;
}

function documentDto(d: StoreDocumentRow) {
  const file = (d.docFile ?? "").trim();
  return {
    masterId: d.masterId,
    name: d.name ?? "",
    serviceType: d.serviceType ?? "",
    docId: d.docId ?? null,
    hasFile: file !== "",
    fileName: file,
    expiryDate: cleanDocDate(d.exDate),
    status: d.docStatus ?? "",
    rejectReason: (d.rejectReason ?? "").trim(),
  };
}

async function requireActiveStore(id: number): Promise<StoreRow> {
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Store not found");
  return row;
}

export async function documents(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActiveStore(id);
  const rows = await model.listStoreDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

export async function documentFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const filename = await model.getStoreDocFile(docId, id);
  if (!filename) throw AppError.notFound("No document file on file");

  const abs = resolveStoredMedia("documents", "store", String(id), path.basename(filename));
  if (!abs) {
    throw AppError.notFound("Document file missing");
  }

  res.setHeader("Content-Type", documentContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/** Content-Type for a document file (images + PDF; defaults to JPEG). */
function documentContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
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

export async function updateDocumentStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  await requireActiveStore(id);
  const { status, reason } = req.body as { status: "Active" | "Inactive"; reason?: string };
  const affected = await model.setStoreDocStatus(docId, id, status, (reason ?? "").trim());
  if (affected === 0) throw AppError.notFound("Document not found for this store");
  audit.logQuiet(req, StoreEvents.DocReviewed, { adminId: null, email: null });
  const rows = await model.listStoreDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

// --- Document upload (images + PDF) ---

const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const DOC_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const docStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("documents", "store", String(req.params.id)));
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

const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: DOC_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DOC_EXT.has(ext) && DOC_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported file type. Use JPG, PNG, WEBP, GIF or PDF."));
    }
  },
});

export function docUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  docUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 10 MB)."));
    }
    return next(err);
  });
}

export async function uploadDocument(req: Request, res: Response) {
  const id = Number(req.params.id);
  const masterId = Number(req.params.masterId);
  await requireActiveStore(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");
  if (!(await model.isValidStoreDocType(masterId))) {
    throw AppError.badRequest("Unknown store document type");
  }
  const exDate = typeof req.body?.expiryDate === "string" ? req.body.expiryDate.trim() : "";
  try {
    await model.upsertStoreDocUpload(id, masterId, req.file.filename, exDate);
  } catch (err) {
    try { unlinkSync(req.file.path); } catch { /* ignore */ }
    throw err;
  }
  audit.logQuiet(req, StoreEvents.DocUploaded, { adminId: null, email: null });
  const rows = await model.listStoreDocuments(id);
  res.status(201).json({ documents: rows.map(documentDto) });
}

