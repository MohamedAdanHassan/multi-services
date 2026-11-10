import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — User Wallet / Refund / Withdraw / Referrer Report.
 *
 * Lists wallet ledger entries from `user_wallet`: one row per credit/debit,
 * with the owning user (driver or rider), the amount, what the entry was for
 * (eFor: Deposit / Booking / Refund / Withdrawl / Charges / Referrer / …) and
 * its settlement status. The permission only grants listing, so there is no
 * export function here (see the #sub-100 list-only convention).
 */

export interface UserWalletFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  /** eFor classification filter (Deposit / Refund / Withdrawl / Referrer / …). */
  status?: string;
}

export interface UserWalletRow {
  id: number;
  userId: number;
  user: string;
  userType: string;
  amount: number;
  type: string;
  for: string;
  paymentStatus: string;
  description: string;
  date: string;
}

// A wallet row belongs to a driver or a rider depending on eUserType, so both
// name tables are joined (each gated on eUserType) and the matching one picked.
// CONCAT_WS over a non-matching join yields '' (not NULL), so each branch is
// NULLIF-wrapped or COALESCE would stop at the first, empty branch.
const FROM = `user_wallet w
  LEFT JOIN register_user ru ON ru.iUserId = w.iUserId AND w.eUserType = 'Rider'
  LEFT JOIN register_driver rd ON rd.iDriverId = w.iUserId AND w.eUserType = 'Driver'`;
const USER_EXPR = `COALESCE(NULLIF(CONCAT_WS(' ', ru.vName, ru.vLastName), ''), NULLIF(CONCAT_WS(' ', rd.vName, rd.vLastName), ''), '')`;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: UserWalletFilters): { where: string; params: unknown[] } {
  const clauses = ["1=1"];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(${USER_EXPR} LIKE ? OR IFNULL(w.tDescription,'') LIKE ?)`);
    params.push(p, p);
  }
  if (f.status) {
    clauses.push("w.eFor = ?");
    params.push(f.status);
  }
  if (f.from) {
    clauses.push("w.dDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("w.dDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// `for` is a MySQL reserved word, so the alias is backtick-quoted.
const SELECT_COLUMNS = `
  w.iUserWalletId AS id,
  w.iUserId AS userId,
  ${USER_EXPR} AS user,
  w.eUserType AS userType,
  IFNULL(w.iBalance, '0') AS amount,
  w.eType AS type,
  w.eFor AS \`for\`,
  w.ePaymentStatus AS paymentStatus,
  IFNULL(w.tDescription, '') AS description,
  DATE_FORMAT(w.dDate, '%Y-%m-%d %H:%i:%s') AS date
`;

function mapRow(r: Record<string, unknown>): UserWalletRow {
  return {
    id: Number(r.id),
    userId: Number(r.userId ?? 0),
    user: String(r.user ?? ""),
    userType: String(r.userType ?? ""),
    amount: Number(r.amount ?? 0),
    type: String(r.type ?? ""),
    for: String(r.for ?? ""),
    paymentStatus: String(r.paymentStatus ?? ""),
    description: String(r.description ?? ""),
    date: String(r.date ?? ""),
  };
}

export async function listUserWalletEntries(f: UserWalletFilters): Promise<UserWalletRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY w.dDate DESC, w.iUserWalletId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countUserWalletEntries(f: UserWalletFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
