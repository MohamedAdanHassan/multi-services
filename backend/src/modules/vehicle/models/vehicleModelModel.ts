import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `model` table (vehicle models per make, MyISAM,
 * ~10k rows). Same conventions as `make`: no primary key/auto-increment so ids
 * come from MAX(iModelId)+1 over all rows, and deletes are soft
 * (`eStatus = 'Deleted'`) to keep `driver_vehicle.iModelId` references intact.
 * The list is paginated server-side because the catalog is too large to ship
 * whole to the admin UI.
 */

export type ModelStatus = "Active" | "Inactive";

export interface VehicleModelRow {
  id: number; // iModelId
  makeId: number; // iMakeId
  makeName: string; // joined make name ('' if the make was soft-deleted)
  title: string; // vTitle
  status: ModelStatus;
}

export interface ModelListFilters {
  /** Partial model title or make name, already trimmed ("" = no filter). */
  search: string;
  /** Restrict to one make (0/undefined = all makes). */
  makeId?: number;
  page: number; // 1-based
  limit: number; // rows per page
}

const SELECT_COLUMNS = `mo.iModelId, mo.iMakeId,
  COALESCE(mk.vMake, '') AS makeName, mo.vTitle, mo.eStatus`;

const FROM_JOIN = `model mo LEFT JOIN make mk ON mk.iMakeId = mo.iMakeId`;

function mapRow(r: Record<string, string | number | null>): VehicleModelRow {
  return {
    id: Number(r.iModelId),
    makeId: Number(r.iMakeId),
    makeName: String(r.makeName ?? ""),
    title: String(r.vTitle ?? ""),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
  };
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params for list/count so they never drift apart. */
function buildFilters(f: ModelListFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["mo.eStatus <> 'Deleted'"];
  const params: unknown[] = [];
  if (f.makeId) {
    clauses.push("mo.iMakeId = ?");
    params.push(f.makeId);
  }
  if (f.search) {
    clauses.push("(mo.vTitle LIKE ? OR mk.vMake LIKE ?)");
    const p = likePattern(f.search);
    params.push(p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One page of live models, make name then title order. */
export async function listModels(f: ModelListFilters): Promise<VehicleModelRow[]> {
  const { where, params } = buildFilters(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     ${where}
     ORDER BY makeName, mo.vTitle, mo.iModelId
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total live models matching the same filters (for page count). */
export async function countModels(f: ModelListFilters): Promise<number> {
  const { where, params } = buildFilters(f);
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM ${FROM_JOIN} ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

/** One live model by id, or null if missing / soft-deleted. */
export async function findModel(id: number): Promise<VehicleModelRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     WHERE mo.iModelId = ? AND mo.eStatus <> 'Deleted'`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id: max over all rows so soft-deleted ids are never reused. */
export async function nextModelId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iModelId), 0) + 1 AS nid FROM model",
  );
  return Number(rows[0]?.nid ?? 1);
}

export async function createModel(
  id: number,
  makeId: number,
  title: string,
  status: ModelStatus,
): Promise<void> {
  await execute(
    "INSERT INTO model (iModelId, iMakeId, vTitle, eStatus) VALUES (?, ?, ?, ?)",
    [id, makeId, title, status],
  );
}

export async function updateModel(id: number, makeId: number, title: string): Promise<void> {
  await execute(
    "UPDATE model SET iMakeId = ?, vTitle = ? WHERE iModelId = ?",
    [makeId, title, id],
  );
}

export async function setModelStatus(id: number, status: ModelStatus): Promise<void> {
  await execute("UPDATE model SET eStatus = ? WHERE iModelId = ?", [status, id]);
}

/** Soft delete — hides the model without breaking historic vehicle references. */
export async function softDeleteModel(id: number): Promise<void> {
  await execute("UPDATE model SET eStatus = 'Deleted' WHERE iModelId = ?", [id]);
}

/** How many vehicles (any status) still point at this model. */
export async function countVehiclesUsingModel(modelId: number): Promise<number> {
  const rows = await query<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM driver_vehicle WHERE iModelId = ?",
    [modelId],
  );
  return Number(rows[0]?.c ?? 0);
}
