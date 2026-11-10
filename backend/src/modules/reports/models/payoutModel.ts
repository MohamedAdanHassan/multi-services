import { query } from "../../../db/mysql";

/**
 * Payout Report for the Reports module (display sub-group 96). The legacy panel
 * exposes it as several payment "legs", each a per-row financial listing over
 * the trip / order money columns:
 *
 *  - Driver Payment  → one row per trip, what is settled to the provider
 *    (`iFare` minus the admin `fCommision`; settled flag `eDriverPaymentStatus`).
 *  - Store Payment   → one row per store delivery (`orders`), what is payable
 *    to the restaurant/store (`fRestaurantPayAmount`; settled flag
 *    `eRestaurantPaymentStatus`, whose values are spelled `Settled`/`Unsettled`).
 *  - Cancellation    → one row per cancelled trip (`trips`, `eCancelled='Yes'`),
 *    the cancellation charge collected (`fCancellationFare`), filterable by who
 *    cancelled it (`eCancelledBy`: `Passenger`/`Driver`).
 *  - Hotel Payment   → one row per hotel/kiosk-booked trip (`trips`,
 *    `iHotelId > 0`), the charge settled to the hotel (`fHotelCommision`; flag
 *    `eHotelPaymentStatus`). The legacy `hotel` table stores no display name, so
 *    the hotel is surfaced as `Hotel #<id>`.
 *  - Organization    → one row per organisation-billed trip (`trips`,
 *    `ePaymentBy='Organization'`): the fare billed, the admin commission, and the
 *    amount still outstanding (`fOutStandingAmount`; flag
 *    `eOrganizationPaymentStatus`).
 *
 *  - Store Driver Payment → one row per store delivery that actually reached a
 *    driver (`orders`, `iDriverId > 0`): what is payable to the *driver* for
 *    making the delivery (`fDriverPaidAmount`), as opposed to the store payout of
 *    the Store Payment leg above. `orders` carries no driver-side settlement
 *    flag, so the admin disbursement flag (`eAdminPaymentStatus`) is surfaced as
 *    the settlement column and labelled as such. NOTE on this dataset: every
 *    order records `fDriverPaidAmount` 0.00, so the payout column reads zero for
 *    all 14 driver-assigned orders.
 */
export type PayoutLeg =
  | "drivers"
  | "stores"
  | "storeDrivers"
  | "cancellations"
  | "hotels"
  | "organizations"
  | "orgcancellations";

export interface PayoutFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  /** Drivers leg: eDriverPaymentStatus ('Settelled'|'Unsettelled').
   *  Stores / storeDrivers legs: eRestaurantPaymentStatus / eAdminPaymentStatus
   *  ('Settled'|'Unsettled'). */
  status?: string;
}

export interface PayoutRow {
  id: number;
  refNo: string;
  /** Trip job type (eType); empty for order-based legs. */
  kind: string;
  driver: string;
  customer: string;
  /** Store / restaurant name (orders); hotel label / organisation name for the
   *  hotel & organisation legs; empty for the plain trips legs. */
  store: string;
  /** Gross trip fare (iFare) — the amount the customer paid for the service. */
  fare: number;
  /** Admin commission deducted from the fare. */
  commission: number;
  /** What is settled to the provider: fare minus commission. */
  payout: number;
  paymentMode: string;
  status: string;
  date: string;
}

type LegConfig = {
  from: string;
  /** Fixed row filter seed (e.g. "1=1" or "t.eCancelled = 'Yes'"). */
  baseWhere: string;
  idExpr: string;
  refExpr: string;
  kindExpr: string;
  driverExpr: string;
  customerExpr: string;
  storeExpr: string;
  fareExpr: string;
  commissionExpr: string;
  payoutExpr: string;
  modeExpr: string;
  /** Raw (un-IFNULLed) column used for the status WHERE clause. */
  statusCol: string;
  /** Raw expression carrying the settlement/actor flag. */
  statusExpr: string;
  dateExpr: string;
};

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = {A}.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = {A}.iDriverId";
const ORG_JOIN = "LEFT JOIN organization orgn ON orgn.iOrganizationId = {A}.iOrganizationId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";

const LEGS: Record<PayoutLeg, LegConfig> = {
  drivers: {
    from: `trips t ${USER_JOIN.replace("{A}", "t")} ${DRIVER_JOIN.replace("{A}", "t")}`,
    baseWhere: "1=1",
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "''",
    fareExpr: "CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(t.iFare, 0) - IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusCol: "t.eDriverPaymentStatus",
    statusExpr: "IFNULL(t.eDriverPaymentStatus, '')",
    dateExpr: "t.tTripRequestDate",
  },
  stores: {
    from: `orders o ${USER_JOIN.replace("{A}", "o")} ${DRIVER_JOIN.replace("{A}", "o")}`,
    baseWhere: "1=1",
    idExpr: "o.iOrderId",
    refExpr: "IFNULL(o.vOrderNo, '')",
    kindExpr: "''",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "IFNULL(o.vCompany, '')",
    fareExpr: "CAST(IFNULL(o.fNetTotal, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(o.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(o.fRestaurantPayAmount, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(o.ePaymentOption, '')",
    statusCol: "o.eRestaurantPaymentStatus",
    statusExpr: "IFNULL(o.eRestaurantPaymentStatus, '')",
    dateExpr: "o.tOrderRequestDate",
  },
  storeDrivers: {
    // Only deliveries that reached a driver are candidates for a driver payout.
    from: `orders o ${USER_JOIN.replace("{A}", "o")} ${DRIVER_JOIN.replace("{A}", "o")}`,
    baseWhere: "o.iDriverId > 0",
    idExpr: "o.iOrderId",
    refExpr: "IFNULL(o.vOrderNo, '')",
    kindExpr: "''",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "IFNULL(o.vCompany, '')",
    fareExpr: "CAST(IFNULL(o.fNetTotal, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(o.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(o.fDriverPaidAmount, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(o.ePaymentOption, '')",
    statusCol: "o.eAdminPaymentStatus",
    statusExpr: "IFNULL(o.eAdminPaymentStatus, '')",
    dateExpr: "o.tOrderRequestDate",
  },
  cancellations: {
    from: `trips t ${USER_JOIN.replace("{A}", "t")} ${DRIVER_JOIN.replace("{A}", "t")}`,
    baseWhere: "t.eCancelled = 'Yes'",
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "''",
    fareExpr: "CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(t.fCancellationFare, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusCol: "t.eCancelledBy",
    statusExpr: "IFNULL(t.eCancelledBy, '')",
    dateExpr: "t.tTripRequestDate",
  },
  hotels: {
    from: `trips t ${USER_JOIN.replace("{A}", "t")} ${DRIVER_JOIN.replace("{A}", "t")}`,
    baseWhere: "t.iHotelId > 0",
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    // The legacy `hotel` table keeps no display name — identify by id.
    storeExpr: "CONCAT('Hotel #', t.iHotelId)",
    fareExpr: "CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(t.fHotelCommision, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusCol: "t.eHotelPaymentStatus",
    statusExpr: "IFNULL(t.eHotelPaymentStatus, '')",
    dateExpr: "t.tTripRequestDate",
  },
  organizations: {
    from: `trips t ${USER_JOIN.replace("{A}", "t")} ${DRIVER_JOIN.replace("{A}", "t")} ${ORG_JOIN.replace("{A}", "t")}`,
    baseWhere: "t.ePaymentBy = 'Organization'",
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "IFNULL(orgn.vCompany, '')",
    fareExpr: "CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(t.fOutStandingAmount, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusCol: "t.eOrganizationPaymentStatus",
    statusExpr: "IFNULL(t.eOrganizationPaymentStatus, '')",
    dateExpr: "t.tTripRequestDate",
  },
  orgcancellations: {
    from: `trips t ${USER_JOIN.replace("{A}", "t")} ${DRIVER_JOIN.replace("{A}", "t")} ${ORG_JOIN.replace("{A}", "t")}`,
    baseWhere: "t.eCancelled = 'Yes' AND t.ePaymentBy = 'Organization'",
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    driverExpr: DRIVER_EXPR,
    customerExpr: CUSTOMER_EXPR,
    storeExpr: "IFNULL(orgn.vCompany, '')",
    fareExpr: "CAST(IFNULL(t.iFare, 0) AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    payoutExpr: "CAST(IFNULL(t.fCancellationFare, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusCol: "t.eOrganizationPaymentStatus",
    statusExpr: "IFNULL(t.eOrganizationPaymentStatus, '')",
    dateExpr: "t.tTripRequestDate",
  },
};

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(leg: PayoutLeg, f: PayoutFilters): { where: string; params: unknown[] } {
  const cfg = LEGS[leg];
  const clauses = [cfg.baseWhere];
  const params: unknown[] = [];

  if (f.search) {
    clauses.push(
      `(${cfg.refExpr} LIKE ? OR ${cfg.driverExpr} LIKE ? OR ${cfg.customerExpr} LIKE ? OR ${cfg.storeExpr} LIKE ?)`,
    );
    const p = escapeLike(f.search);
    params.push(p, p, p, p);
  }
  if (f.from) {
    clauses.push(`${cfg.dateExpr} >= ?`);
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push(`${cfg.dateExpr} <= ?`);
    params.push(`${f.to} 23:59:59`);
  }
  if (f.status) {
    clauses.push(`${cfg.statusCol} = ?`);
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function selectColumns(cfg: LegConfig): string {
  return [
    `${cfg.idExpr} AS id`,
    `${cfg.refExpr} AS refNo`,
    `${cfg.kindExpr} AS kind`,
    `${cfg.driverExpr} AS driver`,
    `${cfg.customerExpr} AS customer`,
    `${cfg.storeExpr} AS store`,
    `${cfg.fareExpr} AS fare`,
    `${cfg.commissionExpr} AS commission`,
    `${cfg.payoutExpr} AS payout`,
    `${cfg.modeExpr} AS paymentMode`,
    `${cfg.statusExpr} AS status`,
    `DATE_FORMAT(${cfg.dateExpr}, '%Y-%m-%d %H:%i') AS date`,
  ].join(", ");
}

function mapRow(r: Record<string, unknown>): PayoutRow {
  const raw = r.date == null ? "" : String(r.date);
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    kind: String(r.kind ?? "").trim(),
    driver: String(r.driver ?? "").trim(),
    customer: String(r.customer ?? "").trim(),
    store: String(r.store ?? "").trim(),
    fare: Number(r.fare ?? 0),
    commission: Number(r.commission ?? 0),
    payout: Number(r.payout ?? 0),
    paymentMode: String(r.paymentMode ?? ""),
    status: String(r.status ?? ""),
    date: raw.startsWith("0000") ? "" : raw,
  };
}

export async function listPayouts(leg: PayoutLeg, f: PayoutFilters): Promise<PayoutRow[]> {
  const cfg = LEGS[leg];
  const { where, params } = buildWhere(leg, f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(cfg)} FROM ${cfg.from} ${where} ` +
      `ORDER BY ${cfg.dateExpr} DESC, ${cfg.idExpr} DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countPayouts(leg: PayoutLeg, f: PayoutFilters): Promise<number> {
  const cfg = LEGS[leg];
  const { where, params } = buildWhere(leg, f);
  const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${cfg.from} ${where}`, params);
  return Number(rows[0]?.n ?? 0);
}

/** Cap for a CSV export so a broad filter can't stream an unbounded result. */
const EXPORT_CAP = 20000;

/** All rows matching the filters (no paging) for CSV export. */
export async function exportPayouts(leg: PayoutLeg, f: PayoutFilters): Promise<PayoutRow[]> {
  const cfg = LEGS[leg];
  const { where, params } = buildWhere(leg, { ...f, page: 1, limit: EXPORT_CAP });
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(cfg)} FROM ${cfg.from} ${where} ` +
      `ORDER BY ${cfg.dateExpr} DESC, ${cfg.idExpr} DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}
