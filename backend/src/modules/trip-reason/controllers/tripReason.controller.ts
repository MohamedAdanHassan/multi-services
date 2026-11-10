import type { Request, Response } from "express";
import * as service from "../services/tripReasonService";
import type { TripReasonCreate, TripReasonUpdate } from "../services/tripReasonService";
import type { ReasonStatus } from "../models/tripReasonModel";
import * as audit from "../../audit/services/auditService";

/** Audit events for trip reasons. */
export const TripReasonEvents = {
  Created: "trip_reason_created",
  Updated: "trip_reason_updated",
  StatusChanged: "trip_reason_status_changed",
  Deleted: "trip_reason_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/trip-reason/list — live reasons. With no `page`/`limit`/`search`/
 * `status` query the full list is returned as before; once any is present it
 * switches to a filtered SQL page and adds `page`/`limit`/`pages` for the pager.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listReasonsPaged(q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listReasons();
  res.json({ items, total: items.length });
}

/**
 * GET /api/trip-reason/defaults — the language tabs and ride-profile choices a new
 * reason would start from, so the form asks the server what may be filled in.
 */
export async function defaults(_req: Request, res: Response) {
  const [item, profiles] = await Promise.all([
    service.blankRecord(),
    service.listProfileOptions(),
  ]);
  res.json({ item, profiles });
}

/** GET /api/trip-reason/profiles — ride profiles a reason can be filed under. */
export async function profiles(_req: Request, res: Response) {
  res.json({ profiles: await service.listProfileOptions() });
}

/** GET /api/trip-reason/:id — one reason with every stored language. */
export async function getOne(req: Request, res: Response) {
  res.json({ item: await service.getReason(Number(req.params.id)) });
}

/** POST /api/trip-reason — add a reason. */
export async function create(req: Request, res: Response) {
  const item = await service.createReason(req.body as TripReasonCreate);
  await writeAudit(req, TripReasonEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/trip-reason/:id — merge the changed languages, optionally re-file the profile. */
export async function update(req: Request, res: Response) {
  const item = await service.updateReason(Number(req.params.id), req.body as TripReasonUpdate);
  await writeAudit(req, TripReasonEvents.Updated);
  res.json({ item });
}

/** PATCH /api/trip-reason/:id/status — activate / deactivate a reason. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: ReasonStatus };
  const item = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, TripReasonEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/trip-reason/:id — name-confirmed, usage-guarded soft delete. */
export async function remove(req: Request, res: Response) {
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteReason(Number(req.params.id), confirm);
  await writeAudit(req, TripReasonEvents.Deleted);
  res.json({ ok: true, ...result });
}

