import { query, execute } from "../../../db/mysql";

/**
 * Legacy `driver_vehicle` — a vehicle attached to a service provider.
 *
 * Quirks (mirrored from the drivers module):
 *  - `iDriverVehicleId` has NO AUTO_INCREMENT, so new ids go MAX(+1).
 *  - Every column is NOT NULL; under STRICT_TRANS_TABLES an INSERT must supply
 *    all of them, so unused legacy columns get their zero/empty value.
 *  - `eStatus` is Active/Inactive/Deleted; deletes are soft so the row leaves
 *    both the admin list and the driver's vehicle count.
 */

export type DriverVehicleStatus = "Active" | "Inactive" | "Deleted";
export type DriverVehicleType = "Ride" | "Delivery" | "UberX" | "TrackService";

export interface DriverVehicleRow {
  id: number;
  driverId: number;
  driverName: string;
  companyId: number;
  makeId: number;
  makeName: string;
  modelId: number;
  modelName: string;
  year: number;
  licencePlate: string;
  colour: string;
  vehicleType: string;
  status: DriverVehicleStatus;
}

export interface DriverVehicleFilters {
  /** Partial plate / colour / driver name / make / model ("" = no filter). */
  search: string;
  /** Restrict to one driver (0/undefined = all drivers). */
  driverId?: number;
  /** Restrict to one status (undefined = every non-deleted row). */
  status?: "Active" | "Inactive";
}

/** One entry of the vehicle form's driver picklist. */
export interface DriverOption {
  id: number;
  name: string;
  vehicleCount: number;
}

export interface DriverVehicleInput {
  driverId: number;
  /** Inherited from `register_driver.iCompanyId`; the column is NOT NULL. */
  companyId: number;
  makeId: number;
  modelId: number;
  year: number;
  licencePlate: string;
  colour: string;
  vehicleType: DriverVehicleType;
}

/** Columns + joins shared by list and single fetch so the two never drift. */
const SELECT_COLUMNS = `
  dv.iDriverVehicleId, dv.iDriverId, dv.iCompanyId, dv.iMakeId, dv.iModelId,
  dv.iYear, dv.vLicencePlate, dv.vColour, dv.eType, dv.eStatus,
  COALESCE(TRIM(CONCAT(TRIM(rd.vName), ' ', TRIM(rd.vLastName))), '') AS driverName,
  COALESCE(mk.vMake, '') AS makeName,
  COALESCE(mo.vTitle, '') AS modelName`;

const FROM_JOIN = `
  driver_vehicle dv
  LEFT JOIN register_driver rd ON rd.iDriverId = dv.iDriverId
  LEFT JOIN make mk ON mk.iMakeId = dv.iMakeId
  LEFT JOIN model mo ON mo.iModelId = dv.iModelId`;

function mapRow(r: Record<string, string | number | null>): DriverVehicleRow {
  return {
    id: Number(r.iDriverVehicleId),
    driverId: Number(r.iDriverId),
    driverName: String(r.driverName ?? ""),
    companyId: Number(r.iCompanyId) || 0,
    makeId: Number(r.iMakeId),
    makeName: String(r.makeName ?? ""),
    modelId: Number(r.iModelId),
    modelName: String(r.modelName ?? ""),
    year: Number(r.iYear),
    licencePlate: String(r.vLicencePlate ?? ""),
    colour: String(r.vColour ?? ""),
    vehicleType: String(r.eType ?? ""),
    status:
      r.eStatus === "Active" || r.eStatus === "Deleted" ? r.eStatus : "Inactive",
  };
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params (Deleted rows are always hidden). */
function buildFilters(f: DriverVehicleFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["dv.eStatus <> 'Deleted'"];
  const params: unknown[] = [];
  if (f.driverId) {
    clauses.push("dv.iDriverId = ?");
    params.push(f.driverId);
  }
  if (f.status) {
    clauses.push("dv.eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push(
      "(dv.vLicencePlate LIKE ? OR dv.vColour LIKE ? OR rd.vName LIKE ? OR rd.vLastName LIKE ? OR mk.vMake LIKE ? OR mo.vTitle LIKE ?)",
    );
    const p = likePattern(f.search);
    params.push(p, p, p, p, p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** Every live driver vehicle (optional filters), newest id first. */
export async function listVehicles(f: DriverVehicleFilters): Promise<DriverVehicleRow[]> {
  const { where, params } = buildFilters(f);
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN} ${where} ORDER BY dv.iDriverVehicleId DESC`,
    params,
  );
  return rows.map(mapRow);
}

/** One live (non-deleted) vehicle by id, or null. */
export async function findVehicle(id: number): Promise<DriverVehicleRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN} WHERE dv.iDriverVehicleId = ? AND dv.eStatus <> 'Deleted'`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** `driver_vehicle.iDriverVehicleId` has no AUTO_INCREMENT, so ids go MAX+1. */
export async function nextVehicleId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iDriverVehicleId) AS max FROM driver_vehicle",
  );
  return (rows[0]?.max ?? 0) + 1;
}

/**
 * Owning company of a driver (`register_driver.iCompanyId`), or null when the
 * driver is missing / soft-deleted. Kept local so this module doesn't reach
 * into the drivers model for a single column.
 */
export async function driverCompany(
  driverId: number,
): Promise<{ companyId: number } | null> {
  const rows = await query<{ iCompanyId: number | null }>(
    "SELECT iCompanyId FROM register_driver WHERE iDriverId = ? AND eStatus <> 'Deleted'",
    [driverId],
  );
  if (!rows.length) return null;
  return { companyId: Number(rows[0].iCompanyId) || 0 };
}

/**
 * Picklist of live drivers for the vehicle form/filter, with each driver's
 * live vehicle count. Served by this module (not the drivers API) because an
 * admin may hold `view-provider-vehicles` without `view-providers`.
 */
export async function listDriverOptions(): Promise<DriverOption[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT rd.iDriverId AS id,
            COALESCE(TRIM(CONCAT(TRIM(rd.vName), ' ', TRIM(rd.vLastName))), '') AS name,
            (SELECT COUNT(*) FROM driver_vehicle dv
              WHERE dv.iDriverId = rd.iDriverId AND dv.eStatus <> 'Deleted') AS vehicleCount
       FROM register_driver rd
      WHERE rd.eStatus <> 'Deleted'
      ORDER BY rd.iDriverId DESC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    vehicleCount: Number(r.vehicleCount) || 0,
  }));
}

/** Attach a vehicle; all 22 NOT NULL columns are supplied for strict mode. */
export async function createVehicle(input: DriverVehicleInput): Promise<number> {
  const id = await nextVehicleId();
  await execute(
    `INSERT INTO driver_vehicle
       (iDriverVehicleId, iDriverId, iCompanyId, iMakeId, iModelId, iYear,
        vLicencePlate, vColour, eStatus, vInsurance, vPermit, vRegisteration,
        eCarX, eCarGo, vCarType, vRentalCarType, eHandiCapAccessibility, eType,
        eAddedDeliverVehicle, eChildSeatAvailable, eWheelChairAvailable,
        iTrackServiceCompanyId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', '', '', '',
             'No', 'No', '', '', 'No', ?,
             'No', 'No', 'No', 0)`,
    [
      id,
      input.driverId,
      input.companyId,
      input.makeId,
      input.modelId,
      input.year,
      input.licencePlate,
      input.colour,
      input.vehicleType,
    ],
  );
  return id;
}

/** Edit the catalog/identity fields; driver, company and status stay put. */
export async function updateVehicle(
  id: number,
  input: Omit<DriverVehicleInput, "driverId" | "companyId">,
): Promise<void> {
  await execute(
    `UPDATE driver_vehicle
       SET iMakeId = ?, iModelId = ?, iYear = ?, vLicencePlate = ?, vColour = ?, eType = ?
     WHERE iDriverVehicleId = ? AND eStatus <> 'Deleted'`,
    [
      input.makeId,
      input.modelId,
      input.year,
      input.licencePlate,
      input.colour,
      input.vehicleType,
      id,
    ],
  );
}

/** Active / Inactive only; reaching 'Deleted' goes through the delete action. */
export async function setStatus(id: number, status: "Active" | "Inactive"): Promise<void> {
  await execute(
    "UPDATE driver_vehicle SET eStatus = ? WHERE iDriverVehicleId = ? AND eStatus <> 'Deleted'",
    [status, id],
  );
}

/** Soft delete: flip to 'Deleted' so the row (and the driver's count) drop out. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE driver_vehicle SET eStatus = 'Deleted' WHERE iDriverVehicleId = ?", [id]);
}
