import type { Request, Response } from "express";
import * as model from "../models/driverVehiclesModel";
import type { DriverVehicleRow, DriverVehicleType } from "../models/driverVehiclesModel";
import * as catalog from "../../vehicle/models/vehicleModelModel";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for the driver-vehicle lifecycle. */
export const DriverVehicleEvents = {
  Created: "driver_vehicle_created",
  Updated: "driver_vehicle_updated",
  StatusChanged: "driver_vehicle_status_changed",
  Deleted: "driver_vehicle_deleted",
} as const;

function toDto(r: DriverVehicleRow) {
  return {
    id: r.id,
    driverId: r.driverId,
    driverName: r.driverName,
    makeId: r.makeId,
    makeName: r.makeName,
    modelId: r.modelId,
    modelName: r.modelName,
    year: r.year,
    licencePlate: r.licencePlate,
    colour: r.colour,
    vehicleType: r.vehicleType,
    status: r.status,
  };
}

/**
 * The vehicle catalog stores `iModelId` alongside `iMakeId`; a mismatch would
 * produce a vehicle whose brand and model disagree, so both writes check the
 * chosen model actually belongs to the chosen make.
 */
async function assertMakeModel(makeId: number, modelId: number): Promise<void> {
  const chosen = await catalog.findModel(modelId);
  if (!chosen) throw AppError.badRequest("Selected vehicle model no longer exists");
  if (chosen.makeId !== makeId) {
    throw AppError.badRequest("Model does not belong to the selected make");
  }
}

/** GET /api/driver-vehicles/list — every live vehicle (optional filters). */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const search = String(q.search ?? "").trim();
  const driverId = Number(q.driverId ?? 0);
  const status = q.status === "Active" || q.status === "Inactive" ? q.status : undefined;
  const rows = await model.listVehicles({
    search,
    driverId: driverId > 0 ? driverId : undefined,
    status,
  });
  res.json({ vehicles: rows.map(toDto), total: rows.length });
}

/**
 * GET /api/driver-vehicles/drivers — driver picklist for the vehicle form and
 * the list's driver filter. Lives here so `view-provider-vehicles` is enough;
 * the drivers API would additionally demand `view-providers`.
 */
export async function drivers(_req: Request, res: Response) {
  const rows = await model.listDriverOptions();
  res.json({ drivers: rows });
}

export async function getOne(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await model.findVehicle(id);
  if (!row) throw AppError.notFound("Vehicle not found");
  res.json({ vehicle: toDto(row) });
}

interface WriteBody {
  driverId: number;
  makeId: number;
  modelId: number;
  year: number;
  licencePlate: string;
  colour: string;
  vehicleType: DriverVehicleType;
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody;
  const driver = await model.driverCompany(b.driverId);
  if (!driver) throw AppError.badRequest("Driver not found");
  await assertMakeModel(b.makeId, b.modelId);

  const id = await model.createVehicle({
    driverId: b.driverId,
    companyId: driver.companyId,
    makeId: b.makeId,
    modelId: b.modelId,
    year: b.year,
    licencePlate: b.licencePlate,
    colour: b.colour,
    vehicleType: b.vehicleType,
  });
  audit.logQuiet(req, DriverVehicleEvents.Created, { adminId: null, email: null });

  const row = await model.findVehicle(id);
  res.status(201).json({ vehicle: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findVehicle(id);
  if (!existing) throw AppError.notFound("Vehicle not found");
  await assertMakeModel(req.body.makeId, req.body.modelId);

  const b = req.body as WriteBody;
  await model.updateVehicle(id, {
    makeId: b.makeId,
    modelId: b.modelId,
    year: b.year,
    licencePlate: b.licencePlate,
    colour: b.colour,
    vehicleType: b.vehicleType,
  });
  audit.logQuiet(req, DriverVehicleEvents.Updated, { adminId: null, email: null });

  const row = await model.findVehicle(id);
  res.json({ vehicle: row ? toDto(row) : null });
}

export async function setStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findVehicle(id);
  if (!existing) throw AppError.notFound("Vehicle not found");
  const { status } = req.body as { status: "Active" | "Inactive" };

  await model.setStatus(id, status);
  audit.logQuiet(req, DriverVehicleEvents.StatusChanged, { adminId: null, email: null });

  const row = await model.findVehicle(id);
  res.json({ vehicle: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findVehicle(id);
  if (!existing) throw AppError.notFound("Vehicle not found");

  await model.softDelete(id);
  audit.logQuiet(req, DriverVehicleEvents.Deleted, { adminId: null, email: null });
  res.json({ id, deleted: true });
}

