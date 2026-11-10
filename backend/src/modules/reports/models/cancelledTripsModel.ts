import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Cancelled Trip Job Report.
 *
 * Lists cancelled trips (`eCancelled='Yes'`) with operational detail: who
 * cancelled, reason id & text, comment, fare, cancellation charge, whether the
 * charge failed, and the trip's final status.
 *
 * Pattern mirrors payoutModel: buildWhere → selectColumns → list/count/export.
 */

export interface CancelledTripFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  status?: string; // eCancelledBy: 'Passenger' | 'Driver'
}

export interface CancelledTripRow {
  id: number;
  refNo: string;
  kind: string;
  driver: string;
  customer: string;
  cancelledBy: string;
  cancelReasonId: number;
  cancelReason: string;
  cancelComment: string;
  fare: number;
  cancelCharge: number;
  chargeFailed: string;
  tripStatus: string;
  date: string;
}

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = t.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = t.iDriverId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";

const BASE_WHERE = "t.eCancelled = 'Yes'";

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: CancelledTripFilters): { where: string; params: unknown[] } {
  const clauses = [BASE_WHERE];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(
      `(IFNULL(t.vRideNo,'') LIKE ? OR ${DRIVER_EXPR} LIKE ? OR ${CUSTOMER_EXPR} LIKE ?)`
    );
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
  if (f.status) {
    clauses.push("t.eCancelledBy = ?");
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const SELECT_COLUMNS = `
  t.iTripId AS id,
  IFNULL(t.vRideNo, '') AS refNo,
  IFNULL(t.eType, '') AS kind,
  ${DRIVER_EXPR} AS driver,
  ${CUSTOMER_EXPR} AS customer,
  IFNULL(t.eCancelledBy, '') AS cancelledBy,
  IFNULL(t.iCancelReasonId, 0) AS cancelReasonId,
  IFNULL(t.vCancelReason, '') AS cancelReason,
  IFNULL(t.vCancelComment, '') AS cancelComment,
  CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2)) AS fare,
  CAST(IFNULL(t.fCancellationFare, 0) AS DECIMAL(14,2)) AS cancelCharge,
  IFNULL(t.eCancelChargeFailed, '') AS chargeFailed,
  IFNULL(t.iActive, '') AS tripStatus,
  DATE_FORMAT(t.tTripRequestDate, '%Y-%m-%d %H:%i') AS date
`;

function mapRow(r: Record<string, unknown>): CancelledTripRow {
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    kind: String(r.kind ?? ""),
    driver: String(r.driver ?? ""),
    customer: String(r.customer ?? ""),
    cancelledBy: String(r.cancelledBy ?? ""),
    cancelReasonId: Number(r.cancelReasonId ?? 0),
    cancelReason: String(r.cancelReason ?? ""),
    cancelComment: String(r.cancelComment ?? ""),
    fare: Number(r.fare ?? 0),
    cancelCharge: Number(r.cancelCharge ?? 0),
    chargeFailed: String(r.chargeFailed ?? ""),
    tripStatus: String(r.tripStatus ?? ""),
    date: String(r.date ?? ""),
  };
}

const FROM = `trips t ${USER_JOIN} ${DRIVER_JOIN}`;
const EXPORT_CAP = 20000;

export async function listCancelledTrips(f: CancelledTripFilters): Promise<CancelledTripRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY t.tTripRequestDate DESC, t.iTripId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countCancelledTrips(f: CancelledTripFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function exportCancelledTrips(f: CancelledTripFilters): Promise<CancelledTripRow[]> {
  const { where, params } = buildWhere(f);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY t.tTripRequestDate DESC, t.iTripId DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}
