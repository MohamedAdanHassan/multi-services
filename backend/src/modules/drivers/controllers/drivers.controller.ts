import type { NextFunction, Request, Response } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import * as model from "../models/driversModel";
import type {
  DriverRow,
  DriverStatus,
  Availability,
  DriverDocumentRow,
} from "../models/driversModel";
import { deleteUploadedMedia, resolveStoredMedia, uploadDir } from "../../../utils/media";
import * as pwd from "../../auth/services/passwordService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for driver lifecycle operations. */
export const DriverEvents = {
  Created: "driver_created",
  Updated: "driver_updated",
  StatusChanged: "driver_status_changed",
  Deleted: "driver_deleted",
  AvailabilityChanged: "driver_availability_changed",
  WalletCredited: "driver_wallet_credited",
  DocUpdated: "driver_doc_updated",
  DocReviewed: "driver_doc_reviewed",
  DocUploaded: "driver_doc_uploaded",
  ServicesUpdated: "driver_services_updated",
  PhotoChanged: "driver_photo_changed",
  FeatureToggled: "driver_feature_toggled",
} as const;

function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** The legacy "unknown date" sentinel (dBirthDate default) maps back to blank. */
function cleanBirthDate(v: string | null): string {
  if (!v || v.startsWith("0000") || v.startsWith("1000-01-01")) return "";
  return v;
}

function toDto(r: DriverRow) {
  const first = r.vName ?? "";
  const last = r.vLastName ?? "";
  return {
    id: r.iDriverId,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    email: r.vEmail ?? "",
    phone: r.vPhone ?? "",
    company: r.vCompany ?? "",
    carType: r.vCarType ?? "",
    availability: r.vAvailability ?? "",
    status: r.eStatus,
    walletBalance: Number(r.walletBalance) || 0,
    hasImage: Boolean(r.vImage && r.vImage.trim()),
    isFeatured: r.eIsFeatured === "Yes",
    vehicleCount: Number(r.vehicleCount) || 0,
    hasDocument: Boolean(Number(r.hasDocument)),
    docExpiredCount: Number(r.docExpiredCount) || 0,
    docExpiringSoonCount: Number(r.docExpiringSoonCount) || 0,
    gender: r.gender ?? "",
    birthDate: cleanBirthDate(r.birthDate),
    address: r.address ?? "",
    address2: r.address2 ?? "",
    city: r.city ?? "",
    state: r.state ?? "",
    zip: r.zip ?? "",
    country: r.country ?? "",
    phoneCode: r.phoneCode ?? "",
    language: r.language ?? "",
    currency: r.currency ?? "",
    paymentEmail: r.paymentEmail ?? "",
    accountHolderName: r.accountHolderName ?? "",
    accountNumber: r.accountNumber ?? "",
    bankName: r.bankName ?? "",
    bankLocation: r.bankLocation ?? "",
    swiftCode: r.swiftCode ?? "",
    description: r.description ?? "",
    companyId: Number(r.companyId) || 0,
    companyName: r.companyName ?? "",
    createdAt: cleanDate(r.tRegistrationDate),
  };
}

function walletDto(t: model.WalletTransactionRow) {
  return {
    id: t.iUserWalletId,
    type: t.eType,
    for: t.eFor,
    amount: Number(t.amount) || 0,
    description: t.tDescription ?? "",
    date: cleanDate(t.dDate),
  };
}

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

function documentDto(d: DriverDocumentRow) {
  const file = (d.docFile ?? "").trim();
  return {
    masterId: d.masterId,
    name: d.name ?? "",
    serviceType: d.serviceType ?? "",
    userType: d.userType ?? "",
    docId: d.docId ?? null,
    hasFile: file !== "",
    fileName: file,
    expiryDate: cleanDocDate(d.exDate),
    // Empty when the driver has not uploaded this document yet.
    status: d.docStatus ?? "",
    rejectReason: (d.rejectReason ?? "").trim(),
  };
}

async function requireActive(id: number): Promise<DriverRow> {
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Driver not found");
  return row;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/drivers/list — backwards-compatible: with no `page`/`limit`/`search`/
 * `status` query the full list is returned as before; once any is present it
 * switches to a filtered SQL page (store-management's contract) plus totals.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (!paginated) {
    const rows = await model.listDrivers();
    res.json({ drivers: rows.map(toDto), total: rows.length, page: 1, limit: rows.length, pages: 1 });
    return;
  }
  const search = String(q.search ?? "").trim();
  const rawStatus = String(q.status ?? "");
  const status =
    rawStatus === "active" || rawStatus === "inactive" || rawStatus === "Suspend"
      ? (rawStatus as Exclude<DriverStatus, "Deleted">)
      : undefined;
  const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let page = Math.max(Number(q.page) || 1, 1);

  const filters: model.DriverListFilters = { search, status };
  const [total, firstRows] = await Promise.all([
    model.countDrivers(filters),
    model.listDriverPage({ ...filters, page, limit }),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  let rows = firstRows;
  if (page > pages) {
    page = pages;
    rows = await model.listDriverPage({ ...filters, page, limit });
  }
  res.json({ drivers: rows.map(toDto), total, page, limit, pages });
}

/**
 * Service categories for the create form's "Service Category" picker. The
 * legacy screen treats it as a single choice ("General" = no category), which
 * is stored as one `provider_service` row.
 */
export async function serviceCategories(_req: Request, res: Response) {
  const rows = await model.listServiceOptions();
  res.json({ categories: rows });
}

/**
 * Company / store options for the provider form. Stores are only listed once a
 * service category is chosen (mirrors the legacy `storeId` box that stays
 * hidden until a store-bearing service is selected). Passing `driverId` also
 * returns that driver's current company and first assigned category so the
 * edit form can pre-select both lists.
 */
export async function companyOptions(req: Request, res: Response) {
  const serviceId = Number(req.query.serviceId) || 0;
  const driverId = Number(req.query.driverId) || 0;
  const { companies, stores } = await model.listCompanyOptions(serviceId);

  let currentCompanyId = 0;
  let currentServiceId = 0;
  if (driverId) {
    const row = await model.findRow(driverId);
    currentCompanyId = Number(row?.companyId) || 0;
    currentServiceId = (await model.getDriverServiceIds(driverId))[0] ?? 0;
  }
  res.json({
    companies,
    stores,
    currentCompanyId,
    currentServiceId: driverId ? currentServiceId : 0,
  });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await requireActive(id);
  res.json({ driver: toDto(row) });
}

/** Content-Type for a legacy image extension (defaults to JPEG). */
function imageContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

/** Content-Type for a driver document file (images + PDF; defaults to JPEG). */
function documentContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    default:
      return imageContentType(filePath);
  }
}

/**
 * Stream a driver's profile photo from the legacy uploads directory.
 * The stored filename is reduced to its basename and the resolved path is
 * verified to stay inside the media root, so a crafted DB value cannot
 * traverse the filesystem. Returns 404 when no photo exists on disk.
 */
export async function photo(req: Request, res: Response) {
  const id = Number(req.params.id);
  const filename = await model.getDriverPhoto(id);
  if (!filename) throw AppError.notFound("No photo on file");

  // Missing files and zero-byte files both 404 (the resolver only accepts non-empty
  // regular files, and some legacy rows do point at empty ones), so the client
  // avatar falls back to initials instead of rendering a broken image.
  const abs = resolveStoredMedia("Driver", String(id), path.basename(filename));
  if (!abs) throw AppError.notFound("Photo file missing");

  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

interface WriteBody {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  carType: string;
  status: Exclude<DriverStatus, "Deleted">;
  availability: Availability;
  password?: string;
  gender?: string;
  birthDate?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  /** Dial code copied from `country.vPhoneCode` into `register_driver.vCode`. */
  phoneCode?: string;
  /** `vLang` — ISO language code of the provider app language. */
  language?: string;
  /** `vCurrencyDriver` — currency code the provider is paid in. */
  currency?: string;
  paymentEmail?: string;
  accountHolderName?: string;
  accountNumber?: string;
  bankName?: string;
  bankLocation?: string;
  swiftCode?: string;
  description?: string;
  /** `register_driver.iCompanyId` — the chosen company / store row. */
  companyId?: number;
  /** Only on create: seeds the single `provider_service` row (0 = none). */
  serviceId?: number;
}

/**
 * Create a provider. Mirrors the legacy "Add Service Provider" screen: the
 * geo/banking/language fields all land on `register_driver`, and a chosen
 * service category seeds `provider_service` (later edits go through the
 * Manage Services dialog, so update never touches it).
 */
export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;
  if (await model.emailTaken(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "A driver with this email already exists");
  }
  const passwordHash = b.password ? await pwd.hashPassword(b.password) : "";

  const id = await model.createDriver({
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    company: b.company,
    carType: b.carType,
    status: b.status,
    availability: b.availability,
    passwordHash,
    gender: b.gender ?? "",
    birthDate: b.birthDate ?? "",
    address: b.address ?? "",
    address2: b.address2 ?? "",
    city: b.city ?? "",
    state: b.state ?? "",
    zip: b.zip ?? "",
    country: b.country ?? "",
    phoneCode: b.phoneCode ?? "",
    language: b.language ?? "",
    currency: b.currency ?? "",
    paymentEmail: b.paymentEmail ?? "",
    accountHolderName: b.accountHolderName ?? "",
    accountNumber: b.accountNumber ?? "",
    bankName: b.bankName ?? "",
    bankLocation: b.bankLocation ?? "",
    swiftCode: b.swiftCode ?? "",
    description: b.description ?? "",
    companyId: b.companyId ?? 0,
  });
  if (b.serviceId) await model.setDriverServices(id, [b.serviceId]);
  audit.logQuiet(req, DriverEvents.Created, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ driver: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const b = req.body as WriteBody;

  if (b.email !== existing.vEmail && (await model.emailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another driver");
  }
  await model.updateDriver(id, {
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    company: b.company,
    carType: b.carType,
    gender: b.gender ?? "",
    birthDate: b.birthDate ?? "",
    address: b.address ?? "",
    address2: b.address2 ?? "",
    city: b.city ?? "",
    state: b.state ?? "",
    zip: b.zip ?? "",
    country: b.country ?? "",
    phoneCode: b.phoneCode ?? "",
    language: b.language ?? "",
    currency: b.currency ?? "",
    paymentEmail: b.paymentEmail ?? "",
    accountHolderName: b.accountHolderName ?? "",
    accountNumber: b.accountNumber ?? "",
    bankName: b.bankName ?? "",
    bankLocation: b.bankLocation ?? "",
    swiftCode: b.swiftCode ?? "",
    description: b.description ?? "",
    // Never orphan a row that was linked to a company: fall back to the stored id.
    companyId: b.companyId ?? existing.companyId ?? 0,
  });
  audit.logQuiet(req, DriverEvents.Updated, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.json({ driver: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const { status } = req.body as { status: DriverStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a driver");
  }
  await model.setStatus(id, status);
  audit.logQuiet(req, DriverEvents.StatusChanged, { adminId: null, email: existing.vEmail });
  const row = await model.findRow(id);
  res.json({ driver: row ? toDto(row) : null });
}

export async function setAvailability(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const { availability } = req.body as { availability: Availability };
  await model.setAvailability(id, availability);
  audit.logQuiet(req, DriverEvents.AvailabilityChanged, { adminId: null, email: existing.vEmail });
  const row = await model.findRow(id);
  res.json({ driver: row ? toDto(row) : null });
}

export async function toggleFeatured(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const { featured } = req.body as { featured: boolean };
  await model.setFeatured(id, featured);
  audit.logQuiet(req, DriverEvents.FeatureToggled, { adminId: null, email: existing.vEmail });
  const row = await model.findRow(id);
  res.json({ driver: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  await model.softDelete(id);
  audit.logQuiet(req, DriverEvents.Deleted, { adminId: null, email: existing.vEmail });
  res.json({ id, deleted: true });
}

interface WalletBody {
  amount: number;
  eFor: string;
  description?: string;
}

export async function getWallet(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const txns = await model.listWalletTransactions(id);
  res.json({ balance: Number(existing.walletBalance) || 0, transactions: txns.map(walletDto) });
}

export async function addWallet(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  const b = req.body as WalletBody;
  if (!(b.amount > 0)) throw AppError.badRequest("Amount must be greater than zero");

  await model.addWalletBalance({
    driverId: id,
    amount: b.amount,
    eFor: b.eFor,
    description: b.description ?? "Admin credit",
  });
  audit.logQuiet(req, DriverEvents.WalletCredited, { adminId: null, email: existing.vEmail });

  const [row, txns] = await Promise.all([
    model.findRow(id),
    model.listWalletTransactions(id),
  ]);
  res.status(201).json({
    balance: Number(row?.walletBalance) || 0,
    transactions: txns.map(walletDto),
  });
}

export async function documents(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActive(id);
  const rows = await model.listDriverDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

/**
 * Stream one uploaded driver document from the legacy media root
 * (`<root>/documents/driver/<id>/<file>`). The filename is read from the DB and
 * reduced to its basename, and the resolved path is verified to stay inside the
 * media root, so a crafted value cannot traverse the filesystem.
 */
export async function documentFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const filename = await model.getDriverDocFile(docId, id);
  if (!filename) throw AppError.notFound("No document file on file");

  const abs = resolveStoredMedia("documents", "driver", String(id), path.basename(filename));
  if (!abs) {
    throw AppError.notFound("Document file missing");
  }

  res.setHeader("Content-Type", documentContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

/**
 * Approve or reject one uploaded driver document. A rejection must carry a
 * reason; approval clears any stored reason. Returns the refreshed document
 * list so the client can re-render without a separate fetch.
 */
export async function updateDocumentStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  await requireActive(id);
  const { status, reason } = req.body as { status: "Active" | "Inactive"; reason?: string };
  const affected = await model.setDriverDocStatus(docId, id, status, (reason ?? "").trim());
  if (affected === 0) throw AppError.notFound("Document not found for this driver");
  audit.logQuiet(req, DriverEvents.DocReviewed, { adminId: null, email: null });
  const rows = await model.listDriverDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

// ---------------------------------------------------------------------------
// Driver document file upload (multipart). Files land under
// `<webImagesRoot>/documents/driver/<id>/` alongside the legacy uploads.
// ---------------------------------------------------------------------------

const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const DOC_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const docStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("documents", "driver", String(req.params.id)));
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

/** Multer single-file middleware that translates upload errors into AppError. */
export function docUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  docUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 10 MB)."));
    }
    return next(err);
  });
}

/**
 * Attach or replace the uploaded file for one driver document type. The new
 * upload resets the row to "pending review" so it must be re-approved. Returns
 * the refreshed document list. On a DB failure the just-written file is removed.
 */
export async function uploadDocument(req: Request, res: Response) {
  const id = Number(req.params.id);
  const masterId = Number(req.params.masterId);
  await requireActive(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");
  if (!(await model.isValidDriverDocType(masterId))) {
    throw AppError.badRequest("Unknown driver document type");
  }
  const exDate = typeof req.body?.expiryDate === "string" ? req.body.expiryDate.trim() : "";
  try {
    await model.upsertDriverDocUpload(id, masterId, req.file.filename, exDate);
  } catch (err) {
    try {
      unlinkSync(req.file.path);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  audit.logQuiet(req, DriverEvents.DocUploaded, { adminId: null, email: null });
  const rows = await model.listDriverDocuments(id);
  res.status(201).json({ documents: rows.map(documentDto) });
}

// ---------------------------------------------------------------------------
// Driver profile photo upload (multipart). Files land under
// `<webImagesRoot>/Driver/<id>/`, the same directory the legacy panel and the
// streaming `photo` handler above use.
// ---------------------------------------------------------------------------

const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const photoStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("Driver", String(req.params.id)));
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

const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: PHOTO_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (PHOTO_EXT.has(ext) && PHOTO_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported image type. Use JPG, PNG, WEBP or GIF."));
    }
  },
});

/** Multer single-file middleware for the profile photo, with friendly errors. */
export function photoUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  photoUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("Image too large (max 10 MB)."));
    }
    return next(err);
  });
}

/**
 * Attach or replace a provider's profile picture. The previous file is removed
 * best-effort once the DB already points at the new one.
 */
export async function uploadPhoto(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await requireActive(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");

  const previous = (existing.vImage ?? "").trim();
  try {
    await model.setDriverPhoto(id, req.file.filename);
  } catch (err) {
    try {
      unlinkSync(req.file.path);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  if (previous && previous !== req.file.filename) {
    // Best effort; a legacy-panel photo is deliberately left in place because the
    // old app shares that file with us.
    deleteUploadedMedia("Driver", String(id), path.basename(previous));
  }
  audit.logQuiet(req, DriverEvents.PhotoChanged, { adminId: null, email: existing.vEmail });

  const row = await model.findRow(id);
  res.status(201).json({ driver: row ? toDto(row) : null });
}

export async function getServices(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActive(id);
  const [categories, assigned] = await Promise.all([
    model.listServiceCategories(),
    model.getDriverServiceIds(id),
  ]);
  res.json({
    categories: categories.map((c) => ({ id: c.iServiceId, name: c.name })),
    serviceIds: assigned,
  });
}

export async function setServices(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActive(id);
  const { serviceIds } = req.body as { serviceIds: number[] };
  const applied = await model.setDriverServices(id, Array.isArray(serviceIds) ? serviceIds : []);
  audit.logQuiet(req, DriverEvents.ServicesUpdated, { adminId: null, email: null });
  res.json({ serviceIds: applied });
}

