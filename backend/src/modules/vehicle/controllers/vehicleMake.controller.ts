import type { Request, Response } from "express";
import type { MakeStatus, VehicleMakeRow } from "../models/vehicleMakeModel";
import * as service from "../services/vehicleMakeService";
import * as audit from "../../audit/services/auditService";

/** Audit events for vehicle make management. */
export const MakeEvents = {
  Created: "vehicle_make_created",
  Updated: "vehicle_make_updated",
  StatusChanged: "vehicle_make_status_changed",
  Deleted: "vehicle_make_deleted",
} as const;

/** Public API shape for a `make` row. */
function toDto(r: VehicleMakeRow) {
  return { id: r.id, name: r.name, status: r.status, modelCount: r.modelCount };
}

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/vehicle-makes/list — every live make with model counts. */
export async function list(_req: Request, res: Response) {
  const rows = await service.listMakes();
  res.json({ makes: rows.map(toDto), total: rows.length });
}

/** GET /api/vehicle-makes/:id — single make (used by the edit page). */
export async function getOne(req: Request, res: Response) {
  const row = await service.getMake(Number(req.params.id));
  res.json({ make: toDto(row) });
}

/** POST /api/vehicle-makes — add a make to the catalog. */
export async function create(req: Request, res: Response) {
  const { name, status } = req.body as { name: string; status?: MakeStatus };
  const row = await service.createMake({ name, status });
  await writeAudit(req, MakeEvents.Created);
  res.status(201).json({ make: toDto(row) });
}

/** PUT /api/vehicle-makes/:id — rename a make. */
export async function update(req: Request, res: Response) {
  const { name } = req.body as { name: string };
  const row = await service.updateMake(Number(req.params.id), { name });
  await writeAudit(req, MakeEvents.Updated);
  res.json({ make: toDto(row) });
}

/** PATCH /api/vehicle-makes/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: MakeStatus };
  const row = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, MakeEvents.StatusChanged);
  res.json({ make: toDto(row) });
}

/** DELETE /api/vehicle-makes/:id — guarded soft delete. */
export async function remove(req: Request, res: Response) {
  await service.deleteMake(Number(req.params.id));
  await writeAudit(req, MakeEvents.Deleted);
  res.json({ ok: true });
}

