import type { NextFunction, Request, Response } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import * as model from "../models/usersModel";
import type { UserRow, UserStatus, UserType, UserDocumentRow } from "../models/usersModel";
import { resolveStoredMedia, uploadDir } from "../../../utils/media";
import * as pwd from "../../auth/services/passwordService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for user lifecycle operations. */
export const UserEvents = {
  Created: "user_created",
  Updated: "user_updated",
  StatusChanged: "user_status_changed",
  Deleted: "user_deleted",
  WalletCredited: "user_wallet_credited",
  DocReviewed: "user_doc_reviewed",
  DocUploaded: "user_doc_uploaded",
} as const;

/** MySQL zero-dates survive DATE_FORMAT; surface them honestly as null. */
function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** Public shape consumed by the user-management UI. */
function toDto(r: UserRow) {
  const first = r.vName ?? "";
  const last = r.vLastName ?? "";
  return {
    id: r.iUserId,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    email: r.vEmail ?? "",
    phone: r.vPhone ?? "",
    phoneCode: r.vPhoneCode ?? "",
    gender: r.eGender ?? "",
    birthDate: cleanDate(r.dBirthDate ? String(r.dBirthDate) : null),
    userType: r.eRefType,
    status: r.eStatus,
    walletBalance: Number(r.walletBalance) || 0,
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/users/list — backwards-compatible: with no `page`/`limit`/`search`/
 * `status` query the full list is returned exactly as before; once any is
 * present it switches to a filtered SQL page (store-management's contract) and
 * adds `total`/`page`/`limit`/`pages` so the UI pager can drive itself.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (!paginated) {
    const rows = await model.listUsers();
    res.json({ users: rows.map(toDto), total: rows.length, page: 1, limit: rows.length, pages: 1 });
    return;
  }
  const search = String(q.search ?? "").trim();
  const status = q.status === "Active" || q.status === "Inactive" ? q.status : undefined;
  const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let page = Math.max(Number(q.page) || 1, 1);

  const filters: model.UserListFilters = { search, status };
  const [total, firstRows] = await Promise.all([
    model.countUsers(filters),
    model.listUserPage({ ...filters, page, limit }),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  let rows = firstRows;
  if (page > pages) {
    page = pages;
    rows = await model.listUserPage({ ...filters, page, limit });
  }
  res.json({ users: rows.map(toDto), total, page, limit, pages });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("User not found");
  res.json({ user: toDto(row) });
}

interface WriteBody {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  gender: string;
  birthDate: string;
  userType: UserType;
  status: Exclude<UserStatus, "Deleted">;
  password?: string;
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;

  if (await model.emailTaken(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "A user with this email already exists");
  }

  // App users authenticate via OTP and carry no password; hash only if one given.
  const passwordHash = b.password ? await pwd.hashPassword(b.password) : "";

  const id = await model.createUser({
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    phoneCode: b.phoneCode,
    gender: b.gender,
    birthDate: b.birthDate,
    userType: b.userType,
    status: b.status,
    passwordHash,
  });
  audit.logQuiet(req, UserEvents.Created, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ user: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("User not found");
  }
  const b = req.body as WriteBody;

  if (b.email !== existing.vEmail && (await model.emailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another user");
  }

  await model.updateUser(id, {
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    phone: b.phone,
    phoneCode: b.phoneCode,
    gender: b.gender,
    birthDate: b.birthDate,
  });
  audit.logQuiet(req, UserEvents.Updated, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.json({ user: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("User not found");
  }
  const { status } = req.body as { status: UserStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a user");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, UserEvents.StatusChanged, { adminId: null, email: existing.vEmail });

  const row = await model.findRow(id);
  res.json({ user: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("User not found");
  }

  await model.softDelete(id);
  audit.logQuiet(req, UserEvents.Deleted, { adminId: null, email: existing.vEmail });
  res.json({ id, deleted: true });
}

interface WalletBody {
  amount: number;
  eFor: string;
  description?: string;
}

export async function getWallet(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("User not found");
  }
  const txns = await model.listWalletTransactions(id);
  res.json({ balance: Number(existing.walletBalance) || 0, transactions: txns.map(walletDto) });
}

export async function addWallet(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("User not found");
  }
  const b = req.body as WalletBody;
  if (!(b.amount > 0)) {
    throw AppError.badRequest("Amount must be greater than zero");
  }

  await model.addWalletBalance({
    userId: id,
    userType: existing.eRefType,
    amount: b.amount,
    eFor: b.eFor,
    description: b.description ?? "Admin credit",
  });
  audit.logQuiet(req, UserEvents.WalletCredited, { adminId: null, email: existing.vEmail });

  const [row, txns] = await Promise.all([
    model.findRow(id),
    model.listWalletTransactions(id),
  ]);
  res.status(201).json({
    balance: Number(row?.walletBalance) || 0,
    transactions: txns.map(walletDto),
  });
}

// ---------------------------------------------------------------------------
// User documents (view / approve / reject / upload / replace).
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

function documentDto(d: UserDocumentRow) {
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

/** Content-Type for a user document file (images + PDF; defaults to JPEG). */
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

async function requireActiveUser(id: number): Promise<UserRow> {
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("User not found");
  return row;
}

export async function documents(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActiveUser(id);
  const rows = await model.listUserDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

export async function documentFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const filename = await model.getUserDocFile(docId, id);
  if (!filename) throw AppError.notFound("No document file on file");

  const abs = resolveStoredMedia("documents", "user", String(id), path.basename(filename));
  if (!abs) {
    throw AppError.notFound("Document file missing");
  }

  res.setHeader("Content-Type", documentContentType(abs));
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filename)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

export async function updateDocumentStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  await requireActiveUser(id);
  const { status, reason } = req.body as { status: "Active" | "Inactive"; reason?: string };
  const affected = await model.setUserDocStatus(docId, id, status, (reason ?? "").trim());
  if (affected === 0) throw AppError.notFound("Document not found for this user");
  audit.logQuiet(req, UserEvents.DocReviewed, { adminId: null, email: null });
  const rows = await model.listUserDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

// --- Multer upload config ---

const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const DOC_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const docStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("documents", "user", String(req.params.id)));
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
  await requireActiveUser(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");
  if (!(await model.isValidUserDocType(masterId))) {
    throw AppError.badRequest("Unknown user document type");
  }
  const exDate = typeof req.body?.expiryDate === "string" ? req.body.expiryDate.trim() : "";
  try {
    await model.upsertUserDocUpload(id, masterId, req.file.filename, exDate);
  } catch (err) {
    try { unlinkSync(req.file.path); } catch { /* ignore */ }
    throw err;
  }
  audit.logQuiet(req, UserEvents.DocUploaded, { adminId: null, email: null });
  const rows = await model.listUserDocuments(id);
  res.status(201).json({ documents: rows.map(documentDto) });
}
