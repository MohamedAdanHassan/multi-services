import { execute, getConnection, query } from "../../../db/mysql";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

/**
 * Data access for the legacy `coupon` table (Marketing Tools → Promocode,
 * #sub-110). Everything below was read off the live schema and the four rows
 * this dataset ships with.
 *
 * Legacy quirks that shape this module:
 *  - MyISAM with `iCouponId int NOT NULL` and **no index of any kind** — the
 *    table has no primary key and no unique key on `vCouponCode`. Ids are
 *    therefore allocated with MAX+1, and code uniqueness is a service-layer
 *    concern; every write filters by id with `LIMIT 1` so a legacy duplicate
 *    cannot turn one edit into many.
 *  - `eStatus` DOES have a 'Deleted' member (one of the four rows is Deleted),
 *    so deletes here are soft — the opposite of `advertise_banners`. Because a
 *    soft delete leaves the row in place, MAX+1 can never hand out a reused id
 *    and no union with a child table is needed.
 *  - `dActiveDate`/`dExpiryDate` are `DATE NOT NULL DEFAULT '0000-00-00'`, and
 *    every Permanent coupon in the dataset stores that zero date in both
 *    columns — "no start / no end". The server runs with STRICT_TRANS_TABLES +
 *    NO_ZERO_DATE, so writing the literal needs the session sql_mode relaxed
 *    (see `withZeroDates`). Storing a far-future sentinel instead would break
 *    any legacy "already started" check, so the zero dates are kept faithful.
 *  - `tDescription` is a longtext holding the per-language JSON map
 *    (`{"tDescription_EN":"…","tDescription_AR":"…", …}`), written
 *    read-modify-write like the donation blobs.
 *  - Scope columns are plain `int NOT NULL` without defaults: `iServiceId`
 *    (→ `service_categories`), `iLocationId` (→ `location_master`, 0 = every
 *    location) and `iCompanyId` (→ `company`, only set when `eStoreType` is
 *    'StoreSpecific'). Names are resolved with correlated subqueries rather
 *    than joins because none of those tables is guaranteed unique on the id
 *    this table points at.
 */

export type PromoStatusCode = "Active" | "Inactive";
export type DiscountType = "percentage" | "cash";
export type PromoValidity = "Permanent" | "Defined";
export type SystemType = "Ride" | "Delivery" | "UberX" | "DeliverAll" | "General";
export type PromoType = "Public" | "Private";
/** `eStoreType`: '' = not store-scoped, 'All' = any store, 'StoreSpecific' = one store. */
export type StoreScope = "" | "All" | "StoreSpecific";

/** The zero date the DDL declares — what "no start" / "no end" looks like here. */
export const NO_DATE = "0000-00-00";

export interface PromoRow {
  id: number; // iCouponId
  code: string; // vCouponCode
  rawDescription: string; // tDescription (multilingual JSON)
  discount: number; // fDiscount
  discountType: DiscountType; // eType
  validity: PromoValidity; // eValidityType
  activeDate: string; // dActiveDate (YYYY-MM-DD, '' for the zero date)
  expiryDate: string; // dExpiryDate (same)
  usageLimit: number; // iUsageLimit (0 = unlimited)
  used: number; // iUsed — the legacy redemption counter
  status: string; // eStatus ('Active' | 'Inactive' | 'Deleted')
  systemType: SystemType; // eSystemType
  fly: boolean; // eFly ('1' | '0')
  promoType: PromoType; // vPromocodeType
  storeScope: StoreScope; // eStoreType
  companyId: number; // iCompanyId
  serviceId: number; // iServiceId
  freeDelivery: boolean; // eFreeDelivery ('Yes' | 'No')
  locationId: number; // iLocationId (0 = every location)
  serviceName: string; // resolved from service_categories
  locationName: string; // resolved from location_master ('' when 0)
  storeName: string; // resolved from company ('' when not store-scoped)
}

/** Columns projected for a coupon, with dates formatted in SQL. */
const SELECT_COLUMNS = `coupon.iCouponId, coupon.vCouponCode, coupon.tDescription,
  coupon.fDiscount, coupon.eType, coupon.eValidityType, coupon.iUsageLimit, coupon.iUsed,
  coupon.eStatus, coupon.eSystemType, coupon.eFly, coupon.vPromocodeType, coupon.eStoreType,
  coupon.iCompanyId, coupon.iServiceId, coupon.eFreeDelivery, coupon.iLocationId,
  DATE_FORMAT(coupon.dActiveDate, '%Y-%m-%d') AS activeDate,
  DATE_FORMAT(coupon.dExpiryDate, '%Y-%m-%d') AS expiryDate,
  (SELECT vService FROM service_categories sc
     WHERE sc.iServiceId = coupon.iServiceId LIMIT 1) AS serviceName,
  (SELECT vLocationName FROM location_master lm
     WHERE lm.iLocationId = coupon.iLocationId LIMIT 1) AS locationName,
  (SELECT vCompany FROM company c
     WHERE c.iCompanyId = coupon.iCompanyId LIMIT 1) AS storeName`;

/**
 * Legacy zero-dates survive DATE_FORMAT as the string "0000-00-00" (NULLIF in
 * SQL makes the mysql2 text parser throw), so they are blanked here and the UI
 * shows "—" / "No end".
 */
function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return v.startsWith("0000") ? "" : v;
}

function yesNo(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "yes" || String(value) === "1";
}

function mapRow(r: Record<string, string | number | null>): PromoRow {
  return {
    id: Number(r.iCouponId),
    code: String(r.vCouponCode ?? "").trim(),
    rawDescription: String(r.tDescription ?? ""),
    discount: Number(r.fDiscount ?? 0),
    discountType: r.eType === "cash" ? "cash" : "percentage",
    validity: r.eValidityType === "Defined" ? "Defined" : "Permanent",
    activeDate: cleanDate(r.activeDate),
    expiryDate: cleanDate(r.expiryDate),
    usageLimit: Number(r.iUsageLimit ?? 0),
    used: Number(r.iUsed ?? 0),
    status: String(r.eStatus ?? "Active"),
    systemType: (String(r.eSystemType ?? "General") as SystemType),
    fly: String(r.eFly ?? "0") === "1",
    promoType: r.vPromocodeType === "Private" ? "Private" : "Public",
    storeScope: (String(r.eStoreType ?? "") as StoreScope),
    companyId: Number(r.iCompanyId ?? 0),
    serviceId: Number(r.iServiceId ?? 0),
    freeDelivery: yesNo(r.eFreeDelivery),
    locationId: Number(r.iLocationId ?? 0),
    serviceName: String(r.serviceName ?? "").trim(),
    locationName: String(r.locationName ?? "").trim(),
    storeName: String(r.storeName ?? "").trim(),
  };
}

/**
 * Run a write on a dedicated connection with the session sql_mode relaxed, so
 * the legacy zero dates can be stored. The connection's own previous value is
 * captured and restored before it goes back to the pool — the pool is shared
 * with every other module, and `SET … = DEFAULT` would silently drop whatever
 * mode the connection had been handed at connect time.
 */
async function withZeroDates<T>(run: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getConnection();
  let previous: string | null = null;
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT @@SESSION.sql_mode AS m");
    // An empty mode is a legitimate value here, so only a missing/unreadable
    // column counts as "nothing to restore".
    const raw = (rows[0] as { m: string | null } | undefined)?.m;
    previous = typeof raw === "string" ? raw : null;
    await conn.query("SET SESSION sql_mode = ''");
    return await run(conn);
  } finally {
    if (previous !== null) {
      try {
        await conn.query("SET SESSION sql_mode = ?", [previous]);
      } catch {
        /* a connection that cannot be restored is released anyway; the next
           statement on it re-reads the mode it needs */
      }
    }
    conn.release();
  }
}

/** Every coupon the admin can still act on (soft-deleted rows are hidden). */
export async function listPromos(): Promise<PromoRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM coupon
      WHERE coupon.eStatus <> 'Deleted'
      ORDER BY coupon.iCouponId DESC`,
  );
  return rows.map(mapRow);
}

/** One usable coupon, or null when the id is unknown or deleted. */
export async function findPromo(id: number): Promise<PromoRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM coupon
      WHERE coupon.iCouponId = ? AND coupon.eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Case-insensitive lookup of a code. `vCouponCode` compares case-insensitively
 * under the table's utf8mb3_general_ci collation, so this catches 'free10' as
 * well as 'FREE10'. Deleted rows are INCLUDED on purpose: redemptions in
 * `trips`, `orders` and `payment_mode_user_log` reference the code string, so
 * reviving a retired code would re-attach that history to the new coupon.
 */
export async function findPromoByCode(code: string): Promise<PromoRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM coupon
      WHERE coupon.vCouponCode = ? LIMIT 1`,
    [code],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id. Soft deletes leave rows in place, so MAX+1 is never reused. */
export async function nextPromoId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iCouponId), 0) + 1 AS nid FROM coupon",
  );
  return Number(rows[0]?.nid ?? 1);
}

export interface PromoWrite {
  code: string;
  description: string; // serialised multilingual JSON
  discount: number;
  discountType: DiscountType;
  validity: PromoValidity;
  activeDate: string; // NO_DATE when Permanent
  expiryDate: string; // NO_DATE when Permanent
  usageLimit: number;
  systemType: SystemType;
  fly: boolean;
  promoType: PromoType;
  storeScope: StoreScope;
  companyId: number;
  serviceId: number;
  freeDelivery: boolean;
  locationId: number;
}

/** Statuses a coupon can be moved to from the listing (Deleted is the delete path). */
export type PromoEdit = PromoWrite;

/**
 * Explicit INSERT listing every column (the legacy table has no defaults for
 * the scope columns). `iUsed` starts at 0 and `eStatus` comes from the create
 * payload, so both are written here rather than relying on column defaults.
 */
export async function createPromo(id: number, d: PromoWrite, status: PromoStatusCode): Promise<void> {
  await withZeroDates(async (conn) => {
    await conn.execute(
      `INSERT INTO coupon
         (iCouponId, vCouponCode, tDescription, fDiscount, eType, eValidityType, dActiveDate,
          dExpiryDate, iUsageLimit, iUsed, eStatus, eSystemType, eFly, vPromocodeType, eStoreType,
          iCompanyId, iServiceId, eFreeDelivery, iLocationId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        d.code,
        d.description,
        d.discount,
        d.discountType,
        d.validity,
        d.activeDate,
        d.expiryDate,
        d.usageLimit,
        status,
        d.systemType,
        d.fly ? "1" : "0",
        d.promoType,
        d.storeScope,
        d.companyId,
        d.serviceId,
        d.freeDelivery ? "Yes" : "No",
        d.locationId,
      ],
    );
  });
}

/**
 * Edit path — the status is owned by the PATCH /status route and `iUsed` is the
 * legacy redemption counter, so neither is written here.
 */
export async function updatePromo(id: number, d: PromoEdit): Promise<void> {
  await withZeroDates(async (conn) => {
    await conn.execute(
      `UPDATE coupon
          SET vCouponCode = ?, tDescription = ?, fDiscount = ?, eType = ?, eValidityType = ?,
              dActiveDate = ?, dExpiryDate = ?, iUsageLimit = ?, eSystemType = ?, eFly = ?,
              vPromocodeType = ?, eStoreType = ?, iCompanyId = ?, iServiceId = ?,
              eFreeDelivery = ?, iLocationId = ?
        WHERE iCouponId = ?
        LIMIT 1`,
      [
        d.code,
        d.description,
        d.discount,
        d.discountType,
        d.validity,
        d.activeDate,
        d.expiryDate,
        d.usageLimit,
        d.systemType,
        d.fly ? "1" : "0",
        d.promoType,
        d.storeScope,
        d.companyId,
        d.serviceId,
        d.freeDelivery ? "Yes" : "No",
        d.locationId,
        id,
      ],
    );
  });
}

export async function setPromoStatus(id: number, status: PromoStatusCode): Promise<void> {
  await execute("UPDATE coupon SET eStatus = ? WHERE iCouponId = ? LIMIT 1", [status, id]);
}

/** Soft delete — `eStatus` has a 'Deleted' member, so the row stays for history. */
export async function deletePromo(id: number): Promise<void> {
  await execute("UPDATE coupon SET eStatus = 'Deleted' WHERE iCouponId = ? LIMIT 1", [id]);
}

// ---------------------------------------------------------------------------
// Reference data for the form's scope selects.
// ---------------------------------------------------------------------------

export interface OptionRow {
  id: number;
  name: string;
  /** Only set for locations: what the legacy panel tagged the zone with. */
  tag?: string;
}

/** Provider services (`service_categories`), the ones a coupon can be limited to. */
export async function listServiceOptions(): Promise<OptionRow[]> {
  const rows = await query<{ iServiceId: number; name: string | null }>(
    `SELECT iServiceId, vService AS name
       FROM service_categories
      WHERE eStatus = 'Active'
      ORDER BY iDisplayOrder, iServiceId`,
  );
  return rows.map((r) => ({ id: Number(r.iServiceId), name: String(r.name ?? "").trim() }));
}

/**
 * Location zones. Not filtered by `eFor`: the id only has to exist, and hiding
 * the zones tagged for other features would make existing rows unshowable.
 * PromoCode-tagged zones come first so the usual choice is at the top.
 */
export async function listLocationOptions(): Promise<OptionRow[]> {
  const rows = await query<{
    iLocationId: number;
    name: string | null;
    eFor: string | null;
  }>(
    `SELECT iLocationId, vLocationName AS name, eFor
       FROM location_master
      WHERE eStatus = 'Active'
      ORDER BY eFor = 'PromoCode' DESC, vLocationName`,
  );
  return rows.map((r) => ({
    id: Number(r.iLocationId),
    name: String(r.name ?? "").trim(),
    tag: String(r.eFor ?? ""),
  }));
}

/**
 * Stores, only meaningful when `eStoreType` is 'StoreSpecific'. The display
 * name is `vCompany` — `vName` is empty for every store in this dataset, and
 * the rest of the backend already reads `vCompany` for store labels.
 */
export async function listStoreOptions(): Promise<OptionRow[]> {
  const rows = await query<{ iCompanyId: number; name: string | null }>(
    `SELECT iCompanyId, vCompany AS name
       FROM company
      WHERE eStatus = 'Active' AND vCompany <> ''
      ORDER BY vCompany`,
  );
  return rows.map((r) => ({ id: Number(r.iCompanyId), name: String(r.name ?? "").trim() }));
}

/** Existence checks for the ids the form sends (the FK-less legacy columns). */
export async function serviceExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM service_categories WHERE iServiceId = ? AND eStatus = 'Active'",
    [id],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function locationExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM location_master WHERE iLocationId = ? AND eStatus <> 'Deleted'",
    [id],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function storeExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM company WHERE iCompanyId = ? AND eStatus = 'Active'",
    [id],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
