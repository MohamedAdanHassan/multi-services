import { query } from "../../../db/mysql";

/**
 * Outstanding-amount report for the Reports → "Outstanding Report" page
 * (display sub-group 99). Backed by the legacy `trip_outstanding_amount`
 * ledger, which records the unpaid/pending amount per trip or order. The two
 * report legs split on `ePaymentBy`: a passenger ("user") owes it, or an
 * organization ("org") does. There is no date column on the ledger itself, so
 * the request date is taken from the joined trip / order.
 */
export type OutstandingLeg = "user" | "org";

export interface OutstandingFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface OutstandingRow {
  id: number;
  refNo: string;
  tripId: number;
  orderId: number;
  payerName: string;
  driverName: string;
  amount: number;
  paymentMode: string;
  paidBy: string;
  billGenerated: string;
  date: string;
}

const FROM_JOIN =
  "trip_outstanding_amount ot " +
  "LEFT JOIN trips t ON t.iTripId = ot.iTripId " +
  "LEFT JOIN orders od ON od.iOrderId = ot.iOrderId " +
  "LEFT JOIN register_user us ON us.iUserId = ot.iUserId " +
  "LEFT JOIN register_driver dr ON dr.iDriverId = ot.iDriverId " +
  "LEFT JOIN organization org ON org.iOrganizationId = ot.iOrganizationId";

/** 'Passenger' for the user leg, 'Organization' for the org leg. */
function legPaymentBy(leg: OutstandingLeg): string {
  return leg === "org" ? "Organization" : "Passenger";
}

/** Expression that yields the debtor's display name for this leg. */
function payerExpr(leg: OutstandingLeg): string {
  return leg === "org"
    ? "IFNULL(org.vCompany, '')"
    : "CONCAT_WS(' ', us.vName, us.vLastName)";
}

const REF_EXPR = "IF(ot.iTripId > 0, t.vRideNo, od.vOrderNo)";
const DATE_EXPR = "COALESCE(t.tTripRequestDate, od.tOrderRequestDate)";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(leg: OutstandingLeg, f: OutstandingFilters): { where: string; params: unknown[] } {
  const clauses = ["ot.ePaymentBy = ?"];
  const params: unknown[] = [legPaymentBy(leg)];

  if (f.search) {
    clauses.push(`(${REF_EXPR} LIKE ? OR ${payerExpr(leg)} LIKE ? OR ${DRIVER_EXPR} LIKE ?)`);
    const p = escapeLike(f.search);
    params.push(p, p, p);
  }
  if (f.from) {
    clauses.push(`${DATE_EXPR} >= ?`);
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push(`${DATE_EXPR} <= ?`);
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function selectColumns(leg: OutstandingLeg): string {
  return [
    "ot.iTripOutstandId AS id",
    `IFNULL(${REF_EXPR}, '') AS refNo`,
    "ot.iTripId AS tripId",
    "ot.iOrderId AS orderId",
    `IFNULL(${payerExpr(leg)}, '') AS payerName`,
    `${DRIVER_EXPR} AS driverName`,
    "CAST(ot.fPendingAmount AS DECIMAL(14,2)) AS amount",
    "IFNULL(ot.vTripPaymentMode, '') AS paymentMode",
    "IFNULL(ot.ePaymentBy, '') AS paidBy",
    "IFNULL(ot.eBillGenerated, '') AS billGenerated",
    `DATE_FORMAT(${DATE_EXPR}, '%Y-%m-%d %H:%i') AS date`,
  ].join(", ");
}

function mapRow(r: Record<string, unknown>): OutstandingRow {
  const raw = r.date == null ? "" : String(r.date);
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    tripId: Number(r.tripId ?? 0),
    orderId: Number(r.orderId ?? 0),
    payerName: String(r.payerName ?? "").trim(),
    driverName: String(r.driverName ?? "").trim(),
    amount: Number(r.amount ?? 0),
    paymentMode: String(r.paymentMode ?? ""),
    paidBy: String(r.paidBy ?? ""),
    billGenerated: String(r.billGenerated ?? ""),
    date: raw.startsWith("0000") ? "" : raw,
  };
}

export async function listOutstanding(
  leg: OutstandingLeg,
  f: OutstandingFilters,
): Promise<OutstandingRow[]> {
  const { where, params } = buildWhere(leg, f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(leg)} FROM ${FROM_JOIN} ${where} ` +
      `ORDER BY ${DATE_EXPR} DESC, ot.iTripOutstandId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countOutstanding(
  leg: OutstandingLeg,
  f: OutstandingFilters,
): Promise<number> {
  const { where, params } = buildWhere(leg, f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM_JOIN} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Cap for a CSV export so a broad filter can't stream an unbounded result. */
const EXPORT_CAP = 20000;

/** All rows matching the filters (no paging) for CSV export. */
export async function exportOutstanding(
  leg: OutstandingLeg,
  f: OutstandingFilters,
): Promise<OutstandingRow[]> {
  const { where, params } = buildWhere(leg, f);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(leg)} FROM ${FROM_JOIN} ${where} ` +
      `ORDER BY ${DATE_EXPR} DESC, ot.iTripOutstandId DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}
