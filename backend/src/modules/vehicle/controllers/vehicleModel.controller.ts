import type { Request, Response } from "express";
import type { ModelStatus, VehicleModelRow } from "../models/vehicleModelModel";
import * as service from "../services/vehicleModelService";
import * as audit from "../../audit/services/auditService";

/** Audit events for vehicle model management. */
export const ModelEvents = {
  Created: "vehicle_model_created",
  Updated: "vehicle_model_updated",
  StatusChanged: "vehicle_model_status_changed",
  Deleted: "vehicle_model_deleted",
} as const;

/** Public API shape for a `model` row. */
function toDto(r: VehicleModelRow) {
  return {
    id: r.id,
    makeId: r.makeId,
    makeName: r.makeName,
    title: r.title,
    status: r.status,
  };
}

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/vehicle-models/list — one filtered page + totals. */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const page = await service.listModels({
    search: q.search,
    makeId: q.makeId,
    page: q.page,
    limit: q.limit,
  });
  res.json({
    models: page.rows.map(toDto),
    total: page.total,
    page: page.page,
    limit: page.limit,
    pages: page.pages,
  });
}

/** GET /api/vehicle-models/:id — single model (used by the edit page). */
export async function getOne(req: Request, res: Response) {
  const row = await service.getModel(Number(req.params.id));
  res.json({ model: toDto(row) });
}

/** POST /api/vehicle-models — add a model under a make. */
export async function create(req: Request, res: Response) {
  const { makeId, title, status } = req.body as {
    makeId: number;
    title: string;
    status?: ModelStatus;
  };
  const row = await service.createModel({ makeId, title, status });
  await writeAudit(req, ModelEvents.Created);
  res.status(201).json({ model: toDto(row) });
}

/** PUT /api/vehicle-models/:id — retitle and/or re-parent. */
export async function update(req: Request, res: Response) {
  const { makeId, title } = req.body as { makeId: number; title: string };
  const row = await service.updateModel(Number(req.params.id), { makeId, title });
  await writeAudit(req, ModelEvents.Updated);
  res.json({ model: toDto(row) });
}

/** PATCH /api/vehicle-models/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: ModelStatus };
  const row = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, ModelEvents.StatusChanged);
  res.json({ model: toDto(row) });
}

/** DELETE /api/vehicle-models/:id — guarded soft delete. */
export async function remove(req: Request, res: Response) {
  await service.deleteModel(Number(req.params.id));
  await writeAudit(req, ModelEvents.Deleted);
  res.json({ ok: true });
}

