import { query } from "../../../db/mysql";
import { buildWhere, countRows, dateCol, readDate, type ListFilters } from "./pageHelpers";

/**
 * Data access for the legacy `payment_requests` table (Support Requests →
 * Payment Requests, #sub-107). Read-only report: payouts drivers request for
 * trips/jobs, carrying their own snapshot of name/email/phone plus optional
 * bank transfer details and a `Yes`/`No` done flag.
 */

export interface PaymentRequestRow {
  id: number; // iPaymentRequestsId
  rideNo: string; // vRideNo
  bookingNo: string; // vBookingNo
  driverId: number; // iDriverId
  name: string; // vName + vLastName snapshot
  driverName: string; // joined register_driver name ('' when unresolvable)
  email: string; // vEmail
  phone: string; // vPhone (country code in vCode)
  amount: number; // fAmount
  currency: string; // vCurrency
  done: boolean; // eMarkAsDone === 'Yes'
  bank: {
    holder: string; // vBankAccountHolderName
    name: string; // vBankName
    account: string; // vAccountNumber
    swift: string; // vBIC_SWIFT_Code
    location: string; // vBankLocation
  } | null; // null when no bank fields were filled in
  createdAt: string | null; // tRequestDate, formatted
}

const SEARCH_SQL =
  "(CONCAT_WS(' ', p.vName, p.vLastName) LIKE ? OR COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName)) LIKE ?" +
  " OR p.vEmail LIKE ? OR p.vPhone LIKE ? OR p.vRideNo LIKE ?)";

const FROM_JOIN = `payment_requests p
  LEFT JOIN register_driver dr ON dr.iDriverId = p.iDriverId`;

const SELECT_COLUMNS = `p.iPaymentRequestsId, IFNULL(p.vRideNo, '') AS rideNo,
  IFNULL(p.vBookingNo, '') AS bookingNo, p.iDriverId,
  CONCAT_WS(' ', p.vName, p.vLastName) AS snapshotName,
  COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName), '') AS driverName,
  p.vEmail, CONCAT(IFNULL(p.vCode, ''), IFNULL(p.vPhone, '')) AS phone,
  CAST(p.fAmount AS DECIMAL(14,2)) AS amount, p.vCurrency, p.eMarkAsDone,
  p.vBankAccountHolderName, p.vBankName, p.vAccountNumber, p.vBIC_SWIFT_Code, p.vBankLocation,
  ${dateCol("p.tRequestDate")} AS createdAt`;

function text(v: string | number | null): string {
  return String(v ?? "").trim();
}

function mapRow(r: Record<string, string | number | null>): PaymentRequestRow {
  const bank = {
    holder: text(r.vBankAccountHolderName),
    name: text(r.vBankName),
    account: text(r.vAccountNumber),
    swift: text(r.vBIC_SWIFT_Code),
    location: text(r.vBankLocation),
  };
  const hasBank = Object.values(bank).some(Boolean);
  return {
    id: Number(r.iPaymentRequestsId),
    rideNo: text(r.rideNo),
    bookingNo: text(r.bookingNo),
    driverId: Number(r.iDriverId ?? 0),
    name: text(r.snapshotName),
    driverName: text(r.driverName),
    email: text(r.vEmail),
    phone: text(r.phone),
    amount: Number(r.amount ?? 0),
    currency: text(r.vCurrency),
    done: r.eMarkAsDone === "Yes",
    bank: hasBank ? bank : null,
    createdAt: readDate(r.createdAt),
  };
}

/** Search / date range plus the Status (eMarkAsDone) dropdown filter. */
function paymentWhere(f: ListFilters): { where: string; params: unknown[] } {
  const base = buildWhere(f, SEARCH_SQL, "p.tRequestDate");
  if (!f.status) return base;
  return {
    where: `${base.where} AND p.eMarkAsDone = ?`,
    params: [...base.params, f.status],
  };
}

/** One filtered page of payment requests, newest first. */
export async function listPaymentRequests(f: ListFilters): Promise<PaymentRequestRow[]> {
  const { where, params } = paymentWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     ${where}
     ORDER BY p.tRequestDate DESC, p.iPaymentRequestsId DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total payment requests matching the same filters (for page count). */
export async function countPaymentRequests(f: ListFilters): Promise<number> {
  const { where, params } = paymentWhere(f);
  return countRows(FROM_JOIN, where, params);
}
