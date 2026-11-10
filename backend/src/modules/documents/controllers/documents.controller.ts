import type { Request, Response } from "express";
import * as model from "../models/documentsModel";
import type { DocumentRow, DocumentInput } from "../models/documentsModel";
import * as geoScope from "../models/documentGeoModel";
import type { GeoScope } from "../models/documentGeoModel";
import * as service from "../services/documentsService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for document-catalog operations. */
export const DocumentEvents = {
  Created: "document_type_created",
  Updated: "document_type_updated",
  StatusChanged: "document_type_status_changed",
  Deleted: "document_type_deleted",
  Translated: "document_type_translated",
} as const;

/** MySQL zero-dates survive DATE_FORMAT; surface them honestly as null. */
function cleanDate(v: string | null): string | null {
  if (!v || v.startsWith("0000")) return null;
  return v;
}

/** Public shape consumed by the document-management UI. */
function toDto(r: DocumentRow) {
  return {
    id: r.docMasterId,
    name: (r.name ?? "").trim(),
    userType: r.userType,
    serviceType: r.serviceType ?? "",
    docServiceType: r.docServiceType ?? "General",
    country: (r.country ?? "").trim() || "All",
    exStatus: r.exStatus,
    status: r.status,
    displayOrder: Number(r.displayOrder) || 0,
    createdAt: cleanDate(r.inTime),
  };
}

export async function list(req: Request, res: Response) {
  const userType = req.query.userType as model.DocUserType | undefined;
  const rows = await model.listDocuments(userType);
  res.json({ documents: rows.map(toDto) });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.status === "Deleted") throw AppError.notFound("Document type not found");
  const scopes = await geoScope.listForDocument(id);
  res.json({ document: { ...toDto(row), geoScopes: scopes } });
}

/** Request body for create/update: catalog fields plus the geographic scopes. */
interface WriteBody extends Omit<DocumentInput, "country"> {
  geoScopes?: GeoScope[];
}

/** Build a model input; `country` is derived from scopes by the service. */
function toInput(b: WriteBody): DocumentInput {
  return {
    name: b.name,
    userType: b.userType,
    docServiceType: b.docServiceType,
    country: "All",
    exStatus: b.exStatus,
    status: b.status,
    displayOrder: b.displayOrder,
  };
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;

  if (await model.nameTaken(b.name, b.userType)) {
    throw new AppError(
      409,
      "DUPLICATE_DOCUMENT",
      `A "${b.name}" document type already exists for ${b.userType}.`,
    );
  }

  const id = await service.createDocument(toInput(b), b.geoScopes ?? []);
  audit.logQuiet(req, DocumentEvents.Created, { email: b.name });

  const [row, scopes] = await Promise.all([model.findRow(id), geoScope.listForDocument(id)]);
  res.status(201).json({ document: row ? { ...toDto(row), geoScopes: scopes } : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.status === "Deleted") {
    throw AppError.notFound("Document type not found");
  }
  const b = req.body as WriteBody;

  if (
    (b.name !== existing.name || b.userType !== existing.userType) &&
    (await model.nameTaken(b.name, b.userType, id))
  ) {
    throw new AppError(
      409,
      "DUPLICATE_DOCUMENT",
      `A "${b.name}" document type already exists for ${b.userType}.`,
    );
  }

  await service.updateDocument(id, toInput(b), b.geoScopes ?? []);
  audit.logQuiet(req, DocumentEvents.Updated, { email: b.name });

  const [row, scopes] = await Promise.all([model.findRow(id), geoScope.listForDocument(id)]);
  res.json({ document: row ? { ...toDto(row), geoScopes: scopes } : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.status === "Deleted") {
    throw AppError.notFound("Document type not found");
  }
  const { status } = req.body as { status: model.DocStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a document type");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, DocumentEvents.StatusChanged, { email: existing.name });

  const row = await model.findRow(id);
  res.json({ document: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.status === "Deleted") {
    throw AppError.notFound("Document type not found");
  }

  await model.softDelete(id);
  audit.logQuiet(req, DocumentEvents.Deleted, { email: existing.name });

  res.json({ id, deleted: true });
}

/** All doc_name translations for one catalog row, as { code, label, text }. */
export async function translations(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.status === "Deleted") throw AppError.notFound("Document type not found");
  const map = await model.getTranslations(id);
  const items = model.TRANSLATION_LANGUAGES.map(({ code, label }) => ({
    code,
    label,
    text: map?.[code] ?? "",
  }));
  res.json({ id, name: (row.name ?? "").trim(), languages: items });
}

/** Persist a batch of doc_name translations (`{ languages: { CODE: text } }`). */
export async function updateTranslations(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findRow(id);
  if (!row || row.status === "Deleted") throw AppError.notFound("Document type not found");

  const { languages } = req.body as { languages: Record<string, string> };
  const touched = await model.updateTranslations(id, languages);
  audit.logQuiet(req, DocumentEvents.Translated, { email: row.name });

  res.json({ id, updated: touched });
}

