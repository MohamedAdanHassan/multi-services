import type { Request, Response } from "express";
import type { ChargeStatus } from "../models/deliveryChargeModel";
import { requireDeliveryChargeApp } from "../models/deliveryChargeModel";
import * as service from "../services/deliveryChargeService";
import type { DeliveryChargeInput } from "../services/deliveryChargeService";
import * as audit from "../../audit/services/auditService";

/** Audit events for delivery charges (shared across the menus that expose the table). */
export const DeliveryChargeEvents = {
  Created: "delivery_charge_created",
  Updated: "delivery_charge_updated",
  StatusChanged: "delivery_charge_status_changed",
  Deleted: "delivery_charge_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/delivery-charge/:app/list — the pricing schemes of this table. With no
 * `page`/`limit`/`search`/`status`/`sort` query the full list is returned; once any
 * is present it switches to a filtered SQL page and adds `page`/`limit`/`pages`.
 * Both shapes carry `features`, `currency` and `locations`, because which columns
 * exist at all is a server-side decision (the module switches), not a client one.
 */
export async function list(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined ||
    q.limit !== undefined ||
    q.search !== undefined ||
    q.status !== undefined ||
    q.sort !== undefined;
  if (paginated) {
    const p = await service.listChargesPaged(scope, q);
    res.json({
      items: p.rows,
      total: p.total,
      page: p.page,
      limit: p.limit,
      pages: p.pages,
      features: p.meta.features,
      currency: p.meta.currency,
      locations: p.meta.locations,
    });
    return;
  }
  const { rows, meta } = await service.listCharges(scope);
  res.json({
    items: rows,
    total: rows.length,
    features: meta.features,
    currency: meta.currency,
    locations: meta.locations,
  });
}

/**
 * GET /api/delivery-charge/:app/defaults — what a new scheme would start with: the
 * switches, the zone choices and the field specs its form must satisfy. Registered
 * before the `/:app/:id` routes, which would otherwise swallow "defaults" as an id.
 */
export async function defaults(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  res.json({ item: await service.blankRecord(scope) });
}

/** GET /api/delivery-charge/:app/:id — one scheme with its specs and choices. */
export async function getOne(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  res.json({ item: await service.getCharge(scope, Number(req.params.id)) });
}

/** POST /api/delivery-charge/:app — price a location (and, when the switch is on, a band). */
export async function create(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  const item = await service.createCharge(scope, req.body as DeliveryChargeInput);
  await writeAudit(req, DeliveryChargeEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/delivery-charge/:app/:id — write the changed amounts in one UPDATE. */
export async function update(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  const item = await service.updateCharge(scope, Number(req.params.id), req.body as DeliveryChargeInput);
  await writeAudit(req, DeliveryChargeEvents.Updated);
  res.json({ item });
}

/** PATCH /api/delivery-charge/:app/:id/status — activate / deactivate a scheme. */
export async function setStatus(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  const { status } = req.body as { status: ChargeStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, DeliveryChargeEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/delivery-charge/:app/:id — location-confirmed soft delete. */
export async function remove(req: Request, res: Response) {
  const scope = requireDeliveryChargeApp(req.params.app);
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteCharge(scope, Number(req.params.id), confirm);
  await writeAudit(req, DeliveryChargeEvents.Deleted);
  res.json({ ok: true, ...result });
}

