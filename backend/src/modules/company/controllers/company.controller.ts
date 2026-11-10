import type { Request, Response, NextFunction } from "express";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import * as model from "../models/companyModel";
import type { CompanyRow, CompanyStatus, CompanyDocumentRow } from "../models/companyModel";
import { resolveStoredMedia, uploadDir } from "../../../utils/media";
import * as pwd from "../../auth/services/passwordService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for company lifecycle operations. */
export const CompanyEvents = {
  Created: "company_created",
  Updated: "company_updated",
  StatusChanged: "company_status_changed",
  Deleted: "company_deleted",
  DocReviewed: "company_doc_reviewed",
  DocUploaded: "company_doc_uploaded",
} as const;

/** MySQL zero-dates survive DATE_FORMAT; surface them honestly as null. */
function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** Public shape consumed by the company-management UI. */
function toDto(r: CompanyRow) {
  return {
    id: r.iCompanyId,
    company: r.company ?? "",
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
    status: r.eStatus,
    hasImage: (r.hasImage ?? "").trim() !== "",
    createdAt: cleanDate(r.tRegistrationDate),
  };
}

export async function list(_req: Request, res: Response) {
  const rows = await model.listCompanies();
  res.json({ companies: rows.map(toDto) });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Company not found");
  res.json({ company: toDto(row) });
}

interface WriteBody {
  company: string;
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
  status: Exclude<CompanyStatus, "Deleted">;
  password?: string;
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;

  if (await model.emailTaken(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "A company with this email already exists");
  }

  // Company-panel logins carry bcrypt passwords; hash only if one is given.
  const passwordHash = b.password ? await pwd.hashPassword(b.password) : "";

  const id = await model.createCompany({
    company: b.company,
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
    status: b.status,
    passwordHash,
  });
  audit.logQuiet(req, CompanyEvents.Created, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ company: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Company not found");
  }
  const b = req.body as WriteBody;

  if (b.email !== existing.email && (await model.emailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another company");
  }

  await model.updateCompany(id, {
    company: b.company,
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
  });
  audit.logQuiet(req, CompanyEvents.Updated, { adminId: null, email: b.email });

  const row = await model.findRow(id);
  res.json({ company: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Company not found");
  }
  const { status } = req.body as { status: CompanyStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a company");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, CompanyEvents.StatusChanged, { adminId: null, email: existing.email });

  const row = await model.findRow(id);
  res.json({ company: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Company not found");
  }

  await model.softDelete(id);
  audit.logQuiet(req, CompanyEvents.Deleted, { adminId: null, email: existing.email });
  res.json({ id, deleted: true });
}

// ---------------------------------------------------------------------------
// Company documents (view / approve / reject / upload / replace).
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

function documentDto(d: CompanyDocumentRow) {
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

/** Content-Type for a company document file (images + PDF; defaults to JPEG). */
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

async function requireActiveCompany(id: number): Promise<CompanyRow> {
  const row = await model.findRow(id);
  if (!row || row.eStatus === "Deleted") throw AppError.notFound("Company not found");
  return row;
}

export async function documents(req: Request, res: Response) {
  const id = Number(req.params.id);
  await requireActiveCompany(id);
  const rows = await model.listCompanyDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

export async function documentFile(req: Request, res: Response) {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const filename = await model.getCompanyDocFile(docId, id);
  if (!filename) throw AppError.notFound("No document file on file");

  const abs = resolveStoredMedia("documents", "company", String(id), path.basename(filename));
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
  await requireActiveCompany(id);
  const { status, reason } = req.body as { status: "Active" | "Inactive"; reason?: string };
  const affected = await model.setCompanyDocStatus(docId, id, status, (reason ?? "").trim());
  if (affected === 0) throw AppError.notFound("Document not found for this company");
  audit.logQuiet(req, CompanyEvents.DocReviewed, { adminId: null, email: null });
  const rows = await model.listCompanyDocuments(id);
  res.json({ documents: rows.map(documentDto) });
}

// --- Multer upload config ---

const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOC_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const DOC_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const docStorage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      cb(null, uploadDir("documents", "company", String(req.params.id)));
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
  await requireActiveCompany(id);
  if (!req.file) throw AppError.badRequest("No file uploaded");
  if (!(await model.isValidCompanyDocType(masterId))) {
    throw AppError.badRequest("Unknown company document type");
  }
  const exDate = typeof req.body?.expiryDate === "string" ? req.body.expiryDate.trim() : "";
  try {
    await model.upsertCompanyDocUpload(id, masterId, req.file.filename, exDate);
  } catch (err) {
    try { unlinkSync(req.file.path); } catch { /* ignore */ }
    throw err;
  }
  audit.logQuiet(req, CompanyEvents.DocUploaded, { adminId: null, email: null });
  const rows = await model.listCompanyDocuments(id);
  res.status(201).json({ documents: rows.map(documentDto) });
}

