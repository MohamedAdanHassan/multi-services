import type { Request, Response } from "express";
import * as model from "../models/currencyModel";
import type { CurrencyInput, CurrencyRow, CurrencyStatus } from "../models/currencyModel";
import * as service from "../services/currencyService";
import * as audit from "../../audit/services/auditService";

/** Audit events for currency management. */
export const CurrencyEvents = {
  Updated: "currency_updated",
  StatusChanged: "currency_status_changed",
  DefaultSet: "currency_default_set",
} as const;

/** Public API shape for a currency row. */
function toDto(r: CurrencyRow) {
  return {
    id: r.id,
    code: r.code,
    symbol: r.symbol,
    ratio: r.ratio,
    displayOrder: r.displayOrder,
    threshold: r.threshold,
    isDefault: r.isDefault,
    status: r.status,
    reverseFormatting: r.reverseFormatting,
    reverseSymbol: r.reverseSymbol,
    roundingOff: r.roundingOff,
    firstRange: r.firstRange,
    middleRange: r.middleRange,
    secondRange: r.secondRange,
  };
}

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/currencies/list — the whole catalog in display order. */
export async function list(_req: Request, res: Response) {
  const rows = await model.listCurrencies();
  res.json({ currencies: rows.map(toDto), total: rows.length });
}

/** PUT /api/currencies/:id — validate and persist an edit. */
export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const input = req.body as CurrencyInput;
  const row = await service.updateCurrency(id, input);
  await writeAudit(req, CurrencyEvents.Updated);
  res.json({ currency: toDto(row) });
}

/** PATCH /api/currencies/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { status } = req.body as { status: CurrencyStatus };
  const row = await service.changeStatus(id, status);
  await writeAudit(req, CurrencyEvents.StatusChanged);
  res.json({ currency: toDto(row) });
}

/** PATCH /api/currencies/:id/default — designate as the store default. */
export async function setDefault(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await service.setDefault(id);
  await writeAudit(req, CurrencyEvents.DefaultSet);
  res.json({ currency: toDto(row) });
}
