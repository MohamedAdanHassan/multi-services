import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Trips/Jobs Time Variance Report.
 *
 * DOCUMENTED PROXY: `trips` stores no dedicated variance column. The estimate
 * is the routing engine travel time kept as text in `fGDtime` (seconds; only
 * 8 of the 105 completed trips carry one in this dataset) and the actual is
 * the trip itself, TIMESTAMPDIFF(SECOND, tStartDate, tEndDate).
 * `fDuration` is not used — it holds obviously corrupt values (up to 1e8).
 * Variance is actual − estimated, so a positive number means the trip ran
 * longer than estimated; trips with no usable estimate report 0 for both the
 * estimate and the variance and are flagged by the UI as "no estimate".
 *
 * One row per completed trip (both stamps present). List only.
 */

export interface TimeVarianceFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface TimeVarianceRow {
  id: number;
  refNo: string;
  driverId: number;
  driver: string;
  customer: string;
  startedAt: string;
  endedAt: string;
  hasEstimate: boolean;
  estimatedSeconds: number;
  actualSeconds: number;
  varianceSeconds: number;
}

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = t.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = t.iDriverId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";

const FROM = `trips t ${USER_JOIN} ${DRIVER_JOIN}`;
// A variance is only computable for trips that both started and ended.
// tStartDate/tEndDate are TIMESTAMP (not DATETIME): a direct `col > '1970-01-01'`
// comparison silently matches the zero-date rows as well (119 instead of 105),
// so the guard compares the formatted value instead.
const REAL_STAMP = (col: string): string =>
  `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') > '1970-01-01'`;
const BASE_WHERE = `${REAL_STAMP("t.tStartDate")} AND ${REAL_STAMP("t.tEndDate")}`;
// fGDtime is mediumtext: accept it only when it is a bare non-zero integer.
const ESTIMATE_EXPR = "IF(t.fGDtime REGEXP '^[1-9][0-9]*$', CAST(t.fGDtime AS SIGNED), 0)";

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: TimeVarianceFilters): { where: string; params: unknown[] } {
  const clauses = [BASE_WHERE];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(IFNULL(t.vRideNo,'') LIKE ? OR ${DRIVER_EXPR} LIKE ? OR ${CUSTOMER_EXPR} LIKE ?)`);
    params.push(p, p, p);
  }
  if (f.from) {
    clauses.push("t.tStartDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("t.tStartDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// The TIMESTAMPDIFF args are gated by BASE_WHERE, so no zero-date literal is
// ever compared here.
// NOTE on legacy data quality: tStartDate/tEndDate are TIMESTAMP while the
// request/arrival stamps read by the Request Acceptance report are plain
// DATETIME, and the two families are not written consistently (the gap between
// "driver arrived" and "trip started" spreads over 2, 3 and 10 hours across
// rows). The two reports therefore measure different events and their stamps
// must not be cross-compared row by row.
const SELECT_COLUMNS = `
  t.iTripId AS id,
  IFNULL(t.vRideNo, '') AS refNo,
  IFNULL(t.iDriverId, 0) AS driverId,
  ${DRIVER_EXPR} AS driver,
  ${CUSTOMER_EXPR} AS customer,
  DATE_FORMAT(t.tStartDate, '%Y-%m-%d %H:%i:%s') AS startedAt,
  DATE_FORMAT(t.tEndDate, '%Y-%m-%d %H:%i:%s') AS endedAt,
  ${ESTIMATE_EXPR} AS estimatedSeconds,
  TIMESTAMPDIFF(SECOND, t.tStartDate, t.tEndDate) AS actualSeconds
`;

function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, unknown>): TimeVarianceRow {
  const estimatedSeconds = Number(r.estimatedSeconds ?? 0);
  // Clamped defensively: corrupt stamps would otherwise surface as negative
  // durations.
  const actualSeconds = Math.max(0, Number(r.actualSeconds ?? 0));
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    driverId: Number(r.driverId ?? 0),
    driver: String(r.driver ?? ""),
    customer: String(r.customer ?? ""),
    startedAt: cleanDate(r.startedAt),
    endedAt: cleanDate(r.endedAt),
    hasEstimate: estimatedSeconds > 0,
    estimatedSeconds,
    actualSeconds,
    // Without an estimate there is nothing to vary from — the raw SQL diff
    // would just echo the actual duration, so report no variance.
    varianceSeconds: estimatedSeconds > 0 ? actualSeconds - estimatedSeconds : 0,
  };
}

export async function listTimeVariances(f: TimeVarianceFilters): Promise<TimeVarianceRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY t.tStartDate DESC, t.iTripId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countTimeVariances(f: TimeVarianceFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
