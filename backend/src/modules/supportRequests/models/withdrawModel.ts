import { query } from "../../../db/mysql";
import { buildWhere, countRows, dateCol, readDate, type ListFilters } from "./pageHelpers";

/**
 * Data access for the legacy `withdraw_requests` table (Support Requests →
 * Withdraw Requests, #sub-108). Read-only report: balance withdrawals drivers
 * request, carrying their own snapshot of name/email/phone plus optional bank
 * transfer details, the account balance at request time and a `Yes`/`No` done
 * flag. Structurally near-identical to `payment_requests`.
 */

export interface WithdrawRequestRow {
  id: number; // iWithdrawRequestsId
  driverId: number; // iDriverId
  name: string; // vName + vLastName snapshot
  driverName: string; // joined register_driver name ('' when unresolvable)
  email: string; // vEmail
  paymentEmail: string; // vPaymentEmail
  phone: string; // vPhone (country code in vCode)
  amount: number; // fAmount
  balance: number; // fAccountBalance
  currency: string; // vCurrency
  done: boolean; // eMarkAsDone === 'Yes'
  bank: {
    holder: string;
    name: string;
    account: string;
    swift: string;
    location: string;
  } | null; // null when no bank fields were filled in
  createdAt: string | null; // tRequestDate, formatted
}

const SEARCH_SQL =
  "(CONCAT_WS(' ', w.vName, w.vLastName) LIKE ? OR COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName)) LIKE ?" +
  " OR w.vEmail LIKE ? OR w.vPhone LIKE ?)";

const FROM_JOIN = `withdraw_requests w
  LEFT JOIN register_driver dr ON dr.iDriverId = w.iDriverId`;

const SELECT_COLUMNS = `w.iWithdrawRequestsId, w.iDriverId,
  CONCAT_WS(' ', w.vName, w.vLastName) AS snapshotName,
  COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName), '') AS driverName,
  w.vEmail, IFNULL(w.vPaymentEmail, '') AS paymentEmail,
  CONCAT(IFNULL(w.vCode, ''), IFNULL(w.vPhone, '')) AS phone,
  CAST(w.fAmount AS DECIMAL(14,2)) AS amount,
  CAST(w.fAccountBalance AS DECIMAL(14,2)) AS balance,
  w.vCurrency, w.eMarkAsDone,
  w.vBankAccountHolderName, w.vBankName, w.vAccountNumber, w.vBIC_SWIFT_Code, w.vBankLocation,
  ${dateCol("w.tRequestDate")} AS createdAt`;

function text(v: string | number | null): string {
  return String(v ?? "").trim();
}

function mapRow(r: Record<string, string | number | null>): WithdrawRequestRow {
  const bank = {
    holder: text(r.vBankAccountHolderName),
    name: text(r.vBankName),
    account: text(r.vAccountNumber),
    swift: text(r.vBIC_SWIFT_Code),
    location: text(r.vBankLocation),
  };
  const hasBank = Object.values(bank).some(Boolean);
  return {
    id: Number(r.iWithdrawRequestsId),
    driverId: Number(r.iDriverId ?? 0),
    name: text(r.snapshotName),
    driverName: text(r.driverName),
    email: text(r.vEmail),
    paymentEmail: text(r.paymentEmail),
    phone: text(r.phone),
    amount: Number(r.amount ?? 0),
    balance: Number(r.balance ?? 0),
    currency: text(r.vCurrency),
    done: r.eMarkAsDone === "Yes",
    bank: hasBank ? bank : null,
    createdAt: readDate(r.createdAt),
  };
}

/** Search / date range plus the Status (eMarkAsDone) dropdown filter. */
function withdrawWhere(f: ListFilters): { where: string; params: unknown[] } {
  const base = buildWhere(f, SEARCH_SQL, "w.tRequestDate");
  if (!f.status) return base;
  return {
    where: `${base.where} AND w.eMarkAsDone = ?`,
    params: [...base.params, f.status],
  };
}

/** One filtered page of withdraw requests, newest first. */
export async function listWithdrawRequests(f: ListFilters): Promise<WithdrawRequestRow[]> {
  const { where, params } = withdrawWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     ${where}
     ORDER BY w.tRequestDate DESC, w.iWithdrawRequestsId DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total withdraw requests matching the same filters (for page count). */
export async function countWithdrawRequests(f: ListFilters): Promise<number> {
  const { where, params } = withdrawWhere(f);
  return countRows(FROM_JOIN, where, params);
}
