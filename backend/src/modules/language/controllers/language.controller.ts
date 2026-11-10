import type { Request, Response } from "express";
import * as model from "../models/languageModel";
import type { LanguageInput, LanguageRow, LanguageStatus } from "../models/languageModel";
import * as service from "../services/languageService";
import * as audit from "../../audit/services/auditService";

/** Audit events for language management. */
export const LanguageEvents = {
  Updated: "language_updated",
  StatusChanged: "language_status_changed",
  DefaultSet: "language_default_set",
} as const;

/** Public API shape for a language row. */
function toDto(r: LanguageRow) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    titleEn: r.titleEn,
    gmapLangCode: r.gmapLangCode,
    langCode: r.langCode,
    currencyCode: r.currencyCode,
    currencySymbol: r.currencySymbol,
    displayOrder: r.displayOrder,
    status: r.status,
    isDefault: r.isDefault,
    direction: r.direction,
  };
}

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/languages/list — the whole catalog in display order. */
export async function list(_req: Request, res: Response) {
  const rows = await model.listLanguages();
  res.json({ languages: rows.map(toDto), total: rows.length });
}

/** PUT /api/languages/:id — validate and persist an edit. */
export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const input = req.body as LanguageInput;
  const row = await service.updateLanguage(id, input);
  await writeAudit(req, LanguageEvents.Updated);
  res.json({ language: toDto(row) });
}

/** PATCH /api/languages/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { status } = req.body as { status: LanguageStatus };
  const row = await service.changeStatus(id, status);
  await writeAudit(req, LanguageEvents.StatusChanged);
  res.json({ language: toDto(row) });
}

/** PATCH /api/languages/:id/default — designate as the app default language. */
export async function setDefault(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await service.setDefault(id);
  await writeAudit(req, LanguageEvents.DefaultSet);
  res.json({ language: toDto(row) });
}
