import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `make` table (vehicle makes/brands, InnoDB).
 * The table has no primary key or auto-increment, so new ids are assigned as
 * MAX(iMakeId)+1 over ALL rows (including soft-deleted ones) to avoid id
 * reuse. `eStatus` also carries a 'Deleted' value — deletes are soft so the
 * unchanged PHP app's historic rows (and `driver_vehicle.iMakeId` references)
 * keep resolving. `eModelFound` is a legacy import artifact and left untouched.
 */

export type MakeStatus = "Active" | "Inactive";

export interface VehicleMakeRow {
  id: number; // iMakeId
  name: string; // vMake
  status: MakeStatus; // eStatus (never 'Deleted' — those rows are hidden)
  modelCount: number; // live models under this make
}

const SELECT_WITH_COUNT = `m.iMakeId, m.vMake, m.eStatus,
  (SELECT COUNT(*) FROM model mo
    WHERE mo.iMakeId = m.iMakeId AND mo.eStatus <> 'Deleted') AS iModelCount`;

function mapRow(r: Record<string, string | number | null>): VehicleMakeRow {
  return {
    id: Number(r.iMakeId),
    name: String(r.vMake ?? ""),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    modelCount: Number(r.iModelCount ?? 0),
  };
}

/** All non-deleted makes, alphabetically, with their live model counts. */
export async function listMakes(): Promise<VehicleMakeRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_WITH_COUNT} FROM make m
     WHERE m.eStatus <> 'Deleted'
     ORDER BY m.vMake, m.iMakeId`,
  );
  return rows.map(mapRow);
}

/** One live make by id, or null if missing / soft-deleted. */
export async function findMake(id: number): Promise<VehicleMakeRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_WITH_COUNT} FROM make m
     WHERE m.iMakeId = ? AND m.eStatus <> 'Deleted'`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id: max over all rows so soft-deleted ids are never reused. */
export async function nextMakeId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iMakeId), 0) + 1 AS nid FROM make",
  );
  return Number(rows[0]?.nid ?? 1);
}

export async function createMake(
  id: number,
  name: string,
  status: MakeStatus,
): Promise<void> {
  await execute(
    "INSERT INTO make (iMakeId, vMake, eStatus) VALUES (?, ?, ?)",
    [id, name, status],
  );
}

export async function updateMakeName(id: number, name: string): Promise<void> {
  await execute("UPDATE make SET vMake = ? WHERE iMakeId = ?", [name, id]);
}

export async function setMakeStatus(id: number, status: MakeStatus): Promise<void> {
  await execute("UPDATE make SET eStatus = ? WHERE iMakeId = ?", [status, id]);
}

/** Soft delete — hides the make without breaking historic vehicle references. */
export async function softDeleteMake(id: number): Promise<void> {
  await execute("UPDATE make SET eStatus = 'Deleted' WHERE iMakeId = ?", [id]);
}

/** How many vehicles (any status) still point at this make. */
export async function countVehiclesUsingMake(makeId: number): Promise<number> {
  const rows = await query<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM driver_vehicle WHERE iMakeId = ?",
    [makeId],
  );
  return Number(rows[0]?.c ?? 0);
}
