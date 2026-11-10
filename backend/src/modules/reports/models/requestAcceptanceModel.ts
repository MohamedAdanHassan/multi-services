import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Trips/Jobs Request Acceptance Report.
 *
 * DOCUMENTED PROXY: the legacy schema records no explicit "driver accepted the
 * request" event — `trips` only carries five datetime columns
 * (tTripRequestDate, tDriverArrivedDate, tStartDate, tEndDate, dPauseTime).
 * Acceptance is therefore measured as the dispatch-to-arrival interval:
 * tTripRequestDate → tDriverArrivedDate. Rows without an arrival stamp (8 in
 * this dataset; 0 backdated) report 0 seconds and are shown as "not arrived".
 *
 * One row per requested trip. List only — no export permission exists.
 */

export interface RequestAcceptanceFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface RequestAcceptanceRow {
  id: number;
  refNo: string;
  driverId: number;
  driver: string;
  customer: string;
  requestedAt: string;
  arrivedAt: string;
  acceptanceSeconds: number;
}

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = t.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = t.iDriverId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";

const FROM = `trips t ${USER_JOIN} ${DRIVER_JOIN}`;
// Only trips that were actually requested are listed. '1970-01-01' is a safe
// literal (zero-date literals make mysql2 throw Incorrect DATETIME value).
const BASE_WHERE = "t.tTripRequestDate > '1970-01-01'";

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: RequestAcceptanceFilters): { where: string; params: unknown[] } {
  const clauses = [BASE_WHERE];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(IFNULL(t.vRideNo,'') LIKE ? OR ${DRIVER_EXPR} LIKE ? OR ${CUSTOMER_EXPR} LIKE ?)`);
    params.push(p, p, p);
  }
  if (f.from) {
    clauses.push("t.tTripRequestDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("t.tTripRequestDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// DATE_FORMAT yields NULL for zero-dates; mapRow flattens them to "".
// The arrival guard zeroes out trips whose driver never checked in.
const SELECT_COLUMNS = `
  t.iTripId AS id,
  IFNULL(t.vRideNo, '') AS refNo,
  IFNULL(t.iDriverId, 0) AS driverId,
  ${DRIVER_EXPR} AS driver,
  ${CUSTOMER_EXPR} AS customer,
  DATE_FORMAT(t.tTripRequestDate, '%Y-%m-%d %H:%i:%s') AS requestedAt,
  DATE_FORMAT(t.tDriverArrivedDate, '%Y-%m-%d %H:%i:%s') AS arrivedAt,
  IF(t.tDriverArrivedDate < '1970-01-01' OR t.tDriverArrivedDate < t.tTripRequestDate,
     0, TIMESTAMPDIFF(SECOND, t.tTripRequestDate, t.tDriverArrivedDate)) AS acceptanceSeconds
`;

function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, unknown>): RequestAcceptanceRow {
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    driverId: Number(r.driverId ?? 0),
    driver: String(r.driver ?? ""),
    customer: String(r.customer ?? ""),
    requestedAt: cleanDate(r.requestedAt),
    arrivedAt: cleanDate(r.arrivedAt),
    // SQL already zeroes out missing/backdated arrivals; clamped again so a
    // negative interval can never reach the UI.
    acceptanceSeconds: Math.max(0, Number(r.acceptanceSeconds ?? 0)),
  };
}

export async function listRequestAcceptances(
  f: RequestAcceptanceFilters,
): Promise<RequestAcceptanceRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY t.tTripRequestDate DESC, t.iTripId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countRequestAcceptances(f: RequestAcceptanceFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
