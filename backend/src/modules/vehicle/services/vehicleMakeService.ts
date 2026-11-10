import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";
import * as makes from "../models/vehicleMakeModel";
import type { MakeStatus, VehicleMakeRow } from "../models/vehicleMakeModel";

/**
 * Business rules for vehicle makes (`make` table). Names are trimmed,
 * required and capped at the column width (255). Deletes are guarded so a make
 * that still has live models — or is referenced by registered vehicles —
 * cannot disappear out from under them.
 */

const MAX_NAME_LEN = 255;

function cleanName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw AppError.badRequest("Make name is required.");
  if (name.length > MAX_NAME_LEN) {
    throw AppError.badRequest(`Make name must be at most ${MAX_NAME_LEN} characters.`);
  }
  return name;
}

async function mustFind(id: number): Promise<VehicleMakeRow> {
  const row = await makes.findMake(id);
  if (!row) throw AppError.notFound(`Make #${id} not found.`);
  return row;
}

/** Makes change rarely but feed every vehicle-model screen's filter bar. */
const listCache = createTtlCache<VehicleMakeRow[]>(60_000, 4);

export async function listMakes(): Promise<VehicleMakeRow[]> {
  return listCache.load("list", () => makes.listMakes());
}

export async function getMake(id: number): Promise<VehicleMakeRow> {
  return mustFind(id);
}

export async function createMake(input: {
  name: unknown;
  status?: MakeStatus;
}): Promise<VehicleMakeRow> {
  const name = cleanName(input.name);
  const status: MakeStatus = input.status === "Inactive" ? "Inactive" : "Active";
  const id = await makes.nextMakeId();
  await makes.createMake(id, name, status);
  const row = await makes.findMake(id);
  if (!row) throw AppError.notFound("Make was created but could not be re-read.");
  listCache.clear();
  return row;
}

export async function updateMake(
  id: number,
  input: { name: unknown },
): Promise<VehicleMakeRow> {
  await mustFind(id);
  const name = cleanName(input.name);
  await makes.updateMakeName(id, name);
  listCache.clear();
  return mustFind(id);
}

export async function changeStatus(
  id: number,
  status: MakeStatus,
): Promise<VehicleMakeRow> {
  const row = await mustFind(id);
  if (row.status !== status) await makes.setMakeStatus(id, status);
  listCache.clear();
  return mustFind(id);
}

/** Soft delete, guarded: still-referenced makes stay visible until reassigned. */
export async function deleteMake(id: number): Promise<void> {
  const row = await mustFind(id);
  if (row.modelCount > 0) {
    throw AppError.badRequest(
      `Make “${row.name}” still has ${row.modelCount} model(s). Delete or move them first.`,
    );
  }
  const vehicles = await makes.countVehiclesUsingMake(id);
  if (vehicles > 0) {
    throw AppError.badRequest(
      `Make “${row.name}” is used by ${vehicles} registered vehicle(s) and cannot be deleted.`,
    );
  }
  await makes.softDeleteMake(id);
  listCache.clear();
}
