import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Cancelled Order Report.
 *
 * Lists cancelled orders (`orders` WHERE `iStatusCode = 8`) with operational
 * detail: store, driver, who cancelled, reason, net total, cancellation charge,
 * and refund amount.
 */

export interface CancelledOrderFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  status?: string; // eCancelledBy: 'Driver' | 'Passenger' | 'Company' | 'Admin'
}

export interface CancelledOrderRow {
  id: number;
  orderNo: string;
  store: string;
  driver: string;
  customer: string;
  cancelledBy: string;
  cancelReason: string;
  netTotal: number;
  cancelCharge: number;
  refundAmount: number;
  paymentOption: string;
  date: string;
}

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = o.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = o.iDriverId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";
const STORE_EXPR = "IFNULL(o.vCompany, '')";

const BASE_WHERE = "o.iStatusCode = 8";

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: CancelledOrderFilters): { where: string; params: unknown[] } {
  const clauses = [BASE_WHERE];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(
      `(IFNULL(o.vOrderNo,'') LIKE ? OR ${STORE_EXPR} LIKE ? OR ${DRIVER_EXPR} LIKE ? OR ${CUSTOMER_EXPR} LIKE ?)`
    );
    params.push(p, p, p, p);
  }
  if (f.from) {
    clauses.push("o.tOrderRequestDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("o.tOrderRequestDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }
  if (f.status) {
    clauses.push("o.eCancelledBy = ?");
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const SELECT_COLUMNS = `
  o.iOrderId AS id,
  IFNULL(o.vOrderNo, '') AS orderNo,
  ${STORE_EXPR} AS store,
  ${DRIVER_EXPR} AS driver,
  ${CUSTOMER_EXPR} AS customer,
  IFNULL(o.eCancelledBy, '') AS cancelledBy,
  IFNULL(o.vCancelReason, '') AS cancelReason,
  CAST(IFNULL(o.fNetTotal, 0) AS DECIMAL(14,2)) AS netTotal,
  CAST(IFNULL(o.fCancellationCharge, 0) AS DECIMAL(14,2)) AS cancelCharge,
  CAST(IFNULL(o.fRefundAmount, 0) AS DECIMAL(14,2)) AS refundAmount,
  IFNULL(o.ePaymentOption, '') AS paymentOption,
  DATE_FORMAT(o.tOrderRequestDate, '%Y-%m-%d %H:%i') AS date
`;

function mapRow(r: Record<string, unknown>): CancelledOrderRow {
  return {
    id: Number(r.id),
    orderNo: String(r.orderNo ?? ""),
    store: String(r.store ?? ""),
    driver: String(r.driver ?? ""),
    customer: String(r.customer ?? ""),
    cancelledBy: String(r.cancelledBy ?? ""),
    cancelReason: String(r.cancelReason ?? ""),
    netTotal: Number(r.netTotal ?? 0),
    cancelCharge: Number(r.cancelCharge ?? 0),
    refundAmount: Number(r.refundAmount ?? 0),
    paymentOption: String(r.paymentOption ?? ""),
    date: String(r.date ?? ""),
  };
}

const FROM = `orders o ${USER_JOIN} ${DRIVER_JOIN}`;
const EXPORT_CAP = 20000;

export async function listCancelledOrders(f: CancelledOrderFilters): Promise<CancelledOrderRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY o.tOrderRequestDate DESC, o.iOrderId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countCancelledOrders(f: CancelledOrderFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function exportCancelledOrders(f: CancelledOrderFilters): Promise<CancelledOrderRow[]> {
  const { where, params } = buildWhere(f);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY o.tOrderRequestDate DESC, o.iOrderId DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}
