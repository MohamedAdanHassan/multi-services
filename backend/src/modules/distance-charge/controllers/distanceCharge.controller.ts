import type { Request, Response } from "express";
import { requireDistanceChargeApp } from "../models/distanceChargeModel";
import * as service from "../services/distanceChargeService";
import type { DistanceChargeInput } from "../services/distanceChargeService";
import * as audit from "../../audit/services/auditService";

/**
 * Audit events for the distance-wise charges. There is no status event: these rows are
 * deleted for real, because the apps price with them whatever `eStatus` says (see the
 * model's note on hard deletes), so nothing here can only be deactivated.
 */
export const DistanceChargeEvents = {
  Created: "distance_charge_created",
  Updated: "distance_charge_updated",
  Deleted: "distance_charge_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/distance-charge/:app/list — the distance bands on file. With no
 * `page`/`limit`/`search`/`sort` query the full list is returned; once any is present it
 * switches to a filtered SQL page and adds `page`/`limit`/`pages`. Both shapes carry
 * `features`, `currency`, `distanceUnit`, `vehicleTypes` and `chains`, because which unit
 * a band is written in and where the next band of a vehicle type has to start are the
 * server's business, not the panel's.
 */
export async function list(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.sort !== undefined;
  if (paginated) {
    const p = await service.listBandsPaged(scope, q);
    res.json({
      items: p.rows,
      total: p.total,
      page: p.page,
      limit: p.limit,
      pages: p.pages,
      features: p.meta.features,
      currency: p.meta.currency,
      distanceUnit: p.meta.distanceUnit,
      vehicleTypes: p.meta.vehicleTypes,
      chains: p.chains,
    });
    return;
  }
  const { rows, meta, chains } = await service.listBands(scope);
  res.json({
    items: rows,
    total: rows.length,
    features: meta.features,
    currency: meta.currency,
    distanceUnit: meta.distanceUnit,
    vehicleTypes: meta.vehicleTypes,
    chains,
  });
}

/**
 * GET /api/distance-charge/:app/defaults — what a new band would start with: the field
 * specs, the vehicle-type choices and the chain each type already has. Registered before
 * the `/:app/:id` routes, which would otherwise swallow "defaults" as an id.
 */
export async function defaults(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  res.json({ item: await service.blankRecord(scope) });
}

/** GET /api/distance-charge/:app/:id — one band with its specs and choices. */
export async function getOne(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  res.json({ item: await service.getRecord(scope, Number(req.params.id)) });
}

/** POST /api/distance-charge/:app — price the next band of a vehicle type. */
export async function create(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  const item = await service.createBand(scope, req.body as DistanceChargeInput);
  await writeAudit(req, DistanceChargeEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/distance-charge/:app/:id — write the changed amounts in one UPDATE. */
export async function update(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  const item = await service.updateBand(scope, Number(req.params.id), req.body as DistanceChargeInput);
  await writeAudit(req, DistanceChargeEvents.Updated);
  res.json({ item });
}

/** DELETE /api/distance-charge/:app/:id — row-confirmed, and gone for good. */
export async function remove(req: Request, res: Response) {
  const scope = requireDistanceChargeApp(req.params.app);
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteBand(scope, Number(req.params.id), confirm);
  await writeAudit(req, DistanceChargeEvents.Deleted);
  res.json({ ok: true, ...result });
}

