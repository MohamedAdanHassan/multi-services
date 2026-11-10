import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Driver Insurance Reports.
 *
 * The legacy panel exposes three insurance "legs" that all read the same
 * `driver_insurance_report` ledger — a per-segment log of each driver's time,
 * classified by `eAddedFor`:
 *
 *  - Idle  → `Available` segments (driver online but not on a job).
 *  - Accept→ `Accept`   segments (driver accepted, awaiting start).
 *  - Trip  → `Trip`     segments (driver actively on the trip).
 *
 * Each row is one time segment: driver, optional linked trip (`iTripId`),
 * start/end datetime, the recorded route endpoints, and travelled distance.
 * `dEndDate` may be a zero-date for an in-progress segment, so both the end
 * time and the duration guard against it.
 */
export type InsuranceLeg = "idle" | "accept" | "trip";

export interface InsuranceFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface InsuranceRow {
  id: number;
  driverId: number;
  driver: string;
  tripId: number;
  tripRefNo: string;
  addedFor: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  distance: number;
  startLocation: string;
  endLocation: string;
}

type LegConfig = {
  /** Fixed eAddedFor value that defines the leg. */
  addedFor: "Available" | "Accept" | "Trip";
};

const LEGS: Record<InsuranceLeg, LegConfig> = {
  idle: { addedFor: "Available" },
  accept: { addedFor: "Accept" },
  trip: { addedFor: "Trip" },
};

const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = ir.iDriverId";
const TRIP_JOIN = "LEFT JOIN trips tr ON tr.iTripId = ir.iTripId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";

const FROM = `driver_insurance_report ir ${DRIVER_JOIN} ${TRIP_JOIN}`;
const EXPORT_CAP = 20000;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(leg: InsuranceLeg, f: InsuranceFilters): { where: string; params: unknown[] } {
  const clauses = [`ir.eAddedFor = '${LEGS[leg].addedFor}'`];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(${DRIVER_EXPR} LIKE ? OR IFNULL(tr.vRideNo,'') LIKE ?)`);
    params.push(p, p);
  }
  if (f.from) {
    clauses.push("ir.dStartDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("ir.dStartDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const SELECT_COLUMNS = `
  ir.iInsuranceReportId AS id,
  ir.iDriverId AS driverId,
  ${DRIVER_EXPR} AS driver,
  ir.iTripId AS tripId,
  IFNULL(tr.vRideNo, '') AS tripRefNo,
  IFNULL(ir.eAddedFor, '') AS addedFor,
  DATE_FORMAT(ir.dStartDate, '%Y-%m-%d %H:%i:%s') AS startTime,
  DATE_FORMAT(ir.dEndDate, '%Y-%m-%d %H:%i:%s') AS endTime,
  IFNULL(TIMESTAMPDIFF(SECOND, ir.dStartDate, ir.dEndDate), 0) AS durationSeconds,
  IFNULL(ir.vDistance, '') AS distance,
  IFNULL(ir.tStartLocation, '') AS startLocation,
  IFNULL(ir.tEndLocation, '') AS endLocation
`;

/** Zero-dates come back from DATE_FORMAT as NULL (or a '0000…' string); flatten to "". */
function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, unknown>): InsuranceRow {
  return {
    id: Number(r.id),
    driverId: Number(r.driverId ?? 0),
    driver: String(r.driver ?? ""),
    tripId: Number(r.tripId ?? 0),
    tripRefNo: String(r.tripRefNo ?? ""),
    addedFor: String(r.addedFor ?? ""),
    startTime: cleanDate(r.startTime),
    endTime: cleanDate(r.endTime),
    durationSeconds: Number(r.durationSeconds ?? 0),
    distance: Number(r.distance) || 0,
    startLocation: String(r.startLocation ?? ""),
    endLocation: String(r.endLocation ?? ""),
  };
}

export async function listInsuranceSegments(leg: InsuranceLeg, f: InsuranceFilters): Promise<InsuranceRow[]> {
  const { where, params } = buildWhere(leg, f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY ir.dStartDate DESC, ir.iInsuranceReportId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countInsuranceSegments(leg: InsuranceLeg, f: InsuranceFilters): Promise<number> {
  const { where, params } = buildWhere(leg, f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function exportInsuranceSegments(leg: InsuranceLeg, f: InsuranceFilters): Promise<InsuranceRow[]> {
  const { where, params } = buildWhere(leg, f);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY ir.dStartDate DESC, ir.iInsuranceReportId DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}
