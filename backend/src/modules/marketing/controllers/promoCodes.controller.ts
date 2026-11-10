import type { Request, Response } from "express";
import type { PromoStatusCode } from "../models/promoCodesModel";
import * as service from "../services/promoCodesService";
import type { PromoDto, PromoInput } from "../services/promoCodesService";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for Marketing Tools → Promocode (#sub-110). Reads and writes go
 * through the service; this file only maps request fields, audits the mutations
 * and turns the current listing into a CSV for the export permission.
 */

/** Audit events for promo codes. */
export const PromoCodeEvents = {
  Created: "promo_code_created",
  Updated: "promo_code_updated",
  StatusChanged: "promo_code_status_changed",
  Deleted: "promo_code_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** Pull the write fields out of a request body. */
function readInput(body: Record<string, unknown>): PromoInput {
  return {
    code: body.code,
    description: body.description,
    discount: body.discount,
    discountType: body.discountType,
    validity: body.validity,
    activeDate: body.activeDate,
    expiryDate: body.expiryDate,
    usageLimit: body.usageLimit,
    systemType: body.systemType,
    fly: body.fly,
    promoType: body.promoType,
    storeScope: body.storeScope,
    companyId: body.companyId,
    serviceId: body.serviceId,
    freeDelivery: body.freeDelivery,
    locationId: body.locationId,
  };
}

/** GET /api/promocodes/list — every coupon that has not been deleted. */
export async function list(_req: Request, res: Response) {
  const promos = await service.listPromos();
  res.json({ promos, total: promos.length });
}

/** GET /api/promocodes/options — services / locations / stores for the form. */
export async function options(_req: Request, res: Response) {
  res.json(await service.getOptions());
}

/** GET /api/promocodes/:id — one promo (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ promo: await service.getPromo(Number(req.params.id)) });
}

/** POST /api/promocodes — create a promo code. */
export async function create(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const promo = await service.createPromo({ ...readInput(body), status: body.status });
  await writeAudit(req, PromoCodeEvents.Created);
  res.status(201).json({ promo });
}

/** PUT /api/promocodes/:id — edit (status and redemption count have their own paths). */
export async function update(req: Request, res: Response) {
  const promo = await service.updatePromo(Number(req.params.id), readInput(req.body as Record<string, unknown>));
  await writeAudit(req, PromoCodeEvents.Updated);
  res.json({ promo });
}

/** PATCH /api/promocodes/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: PromoStatusCode };
  const promo = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, PromoCodeEvents.StatusChanged);
  res.json({ promo });
}

/** DELETE /api/promocodes/:id — soft delete (`eStatus` = 'Deleted'). */
export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  await service.deletePromo(id);
  await writeAudit(req, PromoCodeEvents.Deleted);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// CSV export — same RFC 4180 shape as the report exports (BOM for Excel).
// ---------------------------------------------------------------------------

/** Escape a single CSV field per RFC 4180. */
function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  "ID", "Code", "Description", "Discount", "Type", "Validity", "Starts", "Expires",
  "Used", "Usage Limit", "Service", "Location", "Store Scope", "Store", "System",
  "Promo Type", "Free Delivery", "Fly", "Status",
];

function csvCell(p: PromoDto): (string | number)[] {
  return [
    p.id,
    p.code,
    p.description,
    p.discount,
    p.discountType,
    p.validity,
    p.activeDate,
    p.expiryDate,
    p.used,
    p.usageLimit === 0 ? "Unlimited" : p.usageLimit,
    p.serviceName,
    p.locationName || "Everywhere",
    p.storeScope || "Not store-scoped",
    p.storeName,
    p.systemType,
    p.promoType,
    p.freeDelivery ? "Yes" : "No",
    p.fly ? "Yes" : "No",
    p.status,
  ];
}

/** GET /api/promocodes/export — CSV of the promo codes matching the listing filters. */
export async function exportCsv(req: Request, res: Response) {
  const rows = await service.exportPromos(req.query as Record<string, unknown>);
  const lines = [CSV_HEADER.map(csvField).join(","), ...rows.map((r) => csvCell(r).map(csvField).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="promocodes.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

