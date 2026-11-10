import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Payment Member Report.
 *
 * Lists per-member payment records from `payments`: which passenger/driver
 * paid, how much, through which gateway and for which event (Trip,
 * OrderPayment, Wallet, …). SECURITY NOTE: `payments.tPaymentDetails` embeds
 * full Stripe key material and is never selected here (nor anywhere else).
 * The table has no date column, so this report supports no date-range filter.
 * List only — the legacy panel defines no export permission for it.
 */

export interface PaymentMemberFilters {
  search: string;
  page: number;
  limit: number;
  /** eEvent classification (Trip / OrderPayment / Wallet / …). */
  status?: string;
}

export interface PaymentMemberRow {
  id: number;
  paymentIntent: string;
  memberId: number;
  member: string;
  memberType: string;
  amount: number;
  method: string;
  mode: string;
  event: string;
  userStatus: string;
  driverStatus: string;
  tripId: number;
  orderId: number;
}

// The paying member is a passenger or a driver depending on eUserType; each
// join is gated so a numeric id never resolves against the wrong table, and
// every CONCAT_WS branch is NULLIF-wrapped (a non-matching join yields '',
// which COALESCE would otherwise stop at).
const FROM = `payments p
  LEFT JOIN register_user ru ON ru.iUserId = p.iUserId AND p.eUserType = 'Passenger'
  LEFT JOIN register_driver rd ON rd.iDriverId = p.iUserId AND p.eUserType = 'Driver'`;
const MEMBER_EXPR = `COALESCE(NULLIF(CONCAT_WS(' ', ru.vName, ru.vLastName), ''), NULLIF(CONCAT_WS(' ', rd.vName, rd.vLastName), ''), '')`;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: PaymentMemberFilters): { where: string; params: unknown[] } {
  const clauses = ["1=1"];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(${MEMBER_EXPR} LIKE ? OR IFNULL(p.tPaymentUserID,'') LIKE ?)`);
    params.push(p, p);
  }
  if (f.status) {
    clauses.push("p.eEvent = ?");
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// tPaymentDetails deliberately excluded — it contains Stripe secret keys.
const SELECT_COLUMNS = `
  p.iPaymentId AS id,
  IFNULL(p.tPaymentUserID, '') AS paymentIntent,
  p.iUserId AS memberId,
  ${MEMBER_EXPR} AS member,
  p.eUserType AS memberType,
  p.iAmountUser AS amount,
  IFNULL(p.vPaymentMethod, '') AS method,
  IFNULL(p.vPaymentMode, '') AS mode,
  p.eEvent AS event,
  IFNULL(p.vPaymentUserStatus, '') AS userStatus,
  p.ePaymentDriverStatus AS driverStatus,
  p.iTripId AS tripId,
  p.iOrderId AS orderId
`;

function mapRow(r: Record<string, unknown>): PaymentMemberRow {
  return {
    id: Number(r.id),
    paymentIntent: String(r.paymentIntent ?? ""),
    memberId: Number(r.memberId ?? 0),
    member: String(r.member ?? ""),
    memberType: String(r.memberType ?? ""),
    amount: Number(r.amount ?? 0),
    method: String(r.method ?? ""),
    mode: String(r.mode ?? ""),
    event: String(r.event ?? ""),
    userStatus: String(r.userStatus ?? ""),
    driverStatus: String(r.driverStatus ?? ""),
    tripId: Number(r.tripId ?? 0),
    orderId: Number(r.orderId ?? 0),
  };
}

export async function listPaymentMemberRows(f: PaymentMemberFilters): Promise<PaymentMemberRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY p.iPaymentId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countPaymentMemberRows(f: PaymentMemberFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
