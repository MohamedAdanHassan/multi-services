import type { Request, Response } from "express";
import type { TypeStatus } from "../models/vehicleTypeModel";
import { requireVehicleTypeApp } from "../models/vehicleTypeModel";
import * as service from "../services/vehicleTypeService";
import type { VehicleTypeCreate, VehicleTypeUpdate } from "../services/vehicleTypeService";
import * as audit from "../../audit/services/auditService";

/** Audit events for vehicle types (shared across the apps that own a slice). */
export const VehicleTypeEvents = {
  Created: "vehicle_type_created",
  Updated: "vehicle_type_updated",
  StatusChanged: "vehicle_type_status_changed",
  Deleted: "vehicle_type_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/vehicle-type/:app/list — live types of one app. With no
 * `page`/`limit`/`search`/`status` query the full list is returned as before; once
 * any is present it switches to a filtered SQL page and adds `page`/`limit`/`pages`
 * for the pager.
 */
export async function list(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listTypesPaged(scope, q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listTypes(scope);
  res.json({ items, total: items.length });
}

/**
 * GET /api/vehicle-type/:app/defaults — the column specs, DDL defaults and scope
 * dropdown choices a new type of this app would start from, so the add form asks
 * the server what may be chosen.
 */
export async function defaults(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  res.json({ item: await service.blankRecord(scope) });
}

/** GET /api/vehicle-type/:app/:id — one type with every editable column. */
export async function getOne(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  res.json({ item: await service.getType(scope, Number(req.params.id)) });
}

/** POST /api/vehicle-type/:app — add a type to this app's scope. */
export async function create(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  const item = await service.createType(scope, req.body as VehicleTypeCreate);
  await writeAudit(req, VehicleTypeEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/vehicle-type/:app/:id — write the changed texts, artwork, settings, schedule and copy. */
export async function update(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  const item = await service.updateType(scope, Number(req.params.id), req.body as VehicleTypeUpdate);
  await writeAudit(req, VehicleTypeEvents.Updated);
  res.json({ item });
}

/** PATCH /api/vehicle-type/:app/:id/status — activate / deactivate a type. */
export async function setStatus(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  const { status } = req.body as { status: TypeStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, VehicleTypeEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/vehicle-type/:app/:id — name-confirmed, usage-guarded soft delete. */
export async function remove(req: Request, res: Response) {
  const scope = requireVehicleTypeApp(req.params.app);
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deleteType(scope, Number(req.params.id), confirm);
  await writeAudit(req, VehicleTypeEvents.Deleted);
  res.json({ ok: true, ...result });
}

