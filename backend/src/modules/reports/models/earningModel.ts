import { query } from "../../../db/mysql";

/**
 * Earning Report for the Reports module (display sub-group 95). The legacy
 * panel exposes it as two independent financial listings:
 *
 *  - "Payment Report (Trips/Jobs)"  → one row per trip (`trips`), covering the
 *    Ride / Delivery / UberX job types. The admin's earning for a trip is the
 *    `fCommision` column; the passenger paid `iFare`.
 *  - "Admin Earning (Store Deliveries)" → one row per order (`orders`), the
 *    DeliverAll store/food-delivery flow. Earning again `fCommision`; the
 *    customer net was `fNetTotal`.
 *
 * Neither table carries the other's semantics, so each leg has its own FROM /
 * SELECT / status column, but they share one row shape (unused cells are left
 * empty for the leg that doesn't have them) so the frontend renders both from a
 * single table component. Date filtering uses each table's own request date.
 */
export type EarningLeg = "trips" | "orders";

export interface EarningFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  /** Trips leg: eDriverPaymentStatus ('Settelled'|'Unsettelled'). Orders leg: ePaid ('Yes'|'No'). */
  status?: string;
}

export interface EarningRow {
  id: number;
  refNo: string;
  /** Trips leg job type (eType); empty for orders. */
  kind: string;
  customer: string;
  provider: string;
  /** Orders leg store/company name; empty for trips. */
  store: string;
  /** Trips: trip fare (iFare). Orders: order net total (fNetTotal). */
  amount: number;
  /** Admin commission/earning for the row. */
  commission: number;
  /** Trips: vTripPaymentMode; empty for orders. */
  paymentMode: string;
  /** Trips: eDriverPaymentStatus; Orders: ePaid. */
  status: string;
  date: string;
}

type LegConfig = {
  from: string;
  idExpr: string;
  refExpr: string;
  kindExpr: string;
  storeExpr: string;
  amountExpr: string;
  commissionExpr: string;
  modeExpr: string;
  statusExpr: string;
  dateExpr: string;
};

const USER_JOIN = "LEFT JOIN register_user us ON us.iUserId = {ALIAS}.iUserId";
const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = {ALIAS}.iDriverId";
const CUSTOMER_EXPR = "CONCAT_WS(' ', us.vName, us.vLastName)";
const PROVIDER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";

const LEGS: Record<EarningLeg, LegConfig> = {
  trips: {
    from: `trips t ${USER_JOIN.replace("{ALIAS}", "t")} ${DRIVER_JOIN.replace("{ALIAS}", "t")}`,
    idExpr: "t.iTripId",
    refExpr: "IFNULL(t.vRideNo, '')",
    kindExpr: "IFNULL(t.eType, '')",
    storeExpr: "''",
    amountExpr: "CAST(t.iFare AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(t.fCommision, 0) AS DECIMAL(14,2))",
    modeExpr: "IFNULL(t.vTripPaymentMode, '')",
    statusExpr: "IFNULL(t.eDriverPaymentStatus, '')",
    dateExpr: "t.tTripRequestDate",
  },
  orders: {
    from:
      `orders o ${USER_JOIN.replace("{ALIAS}", "o")} ${DRIVER_JOIN.replace("{ALIAS}", "o")} ` +
      "LEFT JOIN company cmp ON cmp.iCompanyId = o.iCompanyId",
    idExpr: "o.iOrderId",
    refExpr: "IFNULL(o.vOrderNo, '')",
    kindExpr: "''",
    storeExpr: "IFNULL(cmp.vCompany, '')",
    amountExpr: "CAST(o.fNetTotal AS DECIMAL(14,2))",
    commissionExpr: "CAST(IFNULL(o.fCommision, 0) AS DECIMAL(14,2))",
    modeExpr: "''",
    statusExpr: "IFNULL(o.ePaid, '')",
    dateExpr: "o.tOrderRequestDate",
  },
};

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(leg: EarningLeg, f: EarningFilters): { where: string; params: unknown[] } {
  const cfg = LEGS[leg];
  const clauses = ["1=1"];
  const params: unknown[] = [];

  if (f.search) {
    clauses.push(`(${cfg.refExpr} LIKE ? OR ${CUSTOMER_EXPR} LIKE ? OR ${PROVIDER_EXPR} LIKE ? OR ${cfg.storeExpr} LIKE ?)`);
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
    // Compare the raw column, not the IFNULL-wrapped select alias.
    const rawStatus = leg === "trips" ? "t.eDriverPaymentStatus" : "o.ePaid";
    clauses.push(`${rawStatus} = ?`);
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function selectColumns(cfg: LegConfig): string {
  return [
    `${cfg.idExpr} AS id`,
    `${cfg.refExpr} AS refNo`,
    `${cfg.kindExpr} AS kind`,
    `${CUSTOMER_EXPR} AS customer`,
    `${PROVIDER_EXPR} AS provider`,
    `${cfg.storeExpr} AS store`,
    `${cfg.amountExpr} AS amount`,
    `${cfg.commissionExpr} AS commission`,
    `${cfg.modeExpr} AS paymentMode`,
    `${cfg.statusExpr} AS status`,
    `DATE_FORMAT(${cfg.dateExpr}, '%Y-%m-%d %H:%i') AS date`,
  ].join(", ");
}

function mapRow(r: Record<string, unknown>): EarningRow {
  const raw = r.date == null ? "" : String(r.date);
  return {
    id: Number(r.id),
    refNo: String(r.refNo ?? ""),
    kind: String(r.kind ?? "").trim(),
    customer: String(r.customer ?? "").trim(),
    provider: String(r.provider ?? "").trim(),
    store: String(r.store ?? "").trim(),
    amount: Number(r.amount ?? 0),
    commission: Number(r.commission ?? 0),
    paymentMode: String(r.paymentMode ?? ""),
    status: String(r.status ?? ""),
    date: raw.startsWith("0000") ? "" : raw,
  };
}

export async function listEarnings(leg: EarningLeg, f: EarningFilters): Promise<EarningRow[]> {
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

export async function countEarnings(leg: EarningLeg, f: EarningFilters): Promise<number> {
  const cfg = LEGS[leg];
  const { where, params } = buildWhere(leg, f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${cfg.from} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Cap for a CSV export so a broad filter can't stream an unbounded result. */
const EXPORT_CAP = 20000;

/** All rows matching the filters (no paging) for CSV export. */
export async function exportEarnings(leg: EarningLeg, f: EarningFilters): Promise<EarningRow[]> {
  const cfg = LEGS[leg];
  const { where, params } = buildWhere(leg, { ...f, page: 1, limit: EXPORT_CAP });
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(cfg)} FROM ${cfg.from} ${where} ` +
      `ORDER BY ${cfg.dateExpr} DESC, ${cfg.idExpr} DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}

