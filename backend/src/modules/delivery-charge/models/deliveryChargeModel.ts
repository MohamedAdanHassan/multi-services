import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";

/**
 * Data access for the legacy `delivery_charges` table — what a delivery costs the
 * customer, per location (and, when the distance-wise switch is on, per distance
 * band inside that location). One row is one answer to "how much do I charge for
 * this order?", and the apps read it while pricing a cart.
 *
 * Delivery Genie → Delivery Charges (#sub-154) was the first screen built on it, and
 * Delivery Runner → Delivery Charges (#sub-157) is the second over the very same rows.
 * The legacy `delivery_charges.php` served those rows to three menus by changing only
 * the permission keys it demanded (`?eType=` selects the suffix, never the rows — the
 * table has no service-line column), so this module is keyed by an `:app` segment the
 * same way Vehicle Type is, and the registry below says which of those menus exist.
 * Genie's rows are the Runner rows: they are literally the same table, which is why the
 * legacy header warned that charges set here "will be applied into Delivery Genie,
 * Delivery Runner & Store Deliveries".
 *
 * Three quirks of the legacy DDL shape everything below:
 *
 * - no primary key, no index and **no auto-increment** on `iDeliveyChargeId`, so a new
 *   id comes from `MAX(iDeliveyChargeId)+1` — the legacy screen let MySQL hand out 0
 *   instead, which is why the table holds exactly one row;
 * - `iLocationId = 0` means "every location", a sentinel the legacy list rendered as
 *   "All Location";
 * - `iDistanceRangeTo = 100000000` is the legacy "and above" marker, displayed as ∞.
 *
 * Deletes are soft here too, although the legacy `action/delivery_charges.php` ran a
 * real `DELETE`: every app-side query already filters `eStatus = 'Active'`, so hiding a
 * row costs nothing the delete did while leaving the pricing on file to be restored.
 * And nothing has to be shielded from such a hide: `custom_delivery_charges_order` looks
 * as though its `iDeliveyChargeId` referenced these rows, but that is simply how both
 * tables spell their own keyless id, and the two have counted from 1 independently.
 */

export type ChargeStatus = "Active" | "Inactive";

/** Menus that expose this shared table. Genie and Runner; the un-suffixed menu is not built. */
export type DeliveryChargeAppKey = "genie" | "runner";

/** What one `:app` menu brings to the same set of rows. */
export interface DeliveryChargeAppScope {
  /** `eFor` marker of the `location_master` zones the location dropdown lists. */
  locationEFor: string;
  /** Human label used in messages and the editor header. */
  label: string;
  /**
   * Whether the module whose feature flag the legacy page tests is on — the PHP side
   * of the Buy Any Service gate. Note that `delivery_charges.php:174` reads
   * `isEnableGenieFeature('Yes')` unconditionally, even on the `?eType=runner` menu
   * (its two `||` operands are the same Genie call, a legacy typo), so this flag names
   * that Genie feature for every entry and is not a per-app switch.
   */
  moduleEnabled: boolean;
}

export const DELIVERY_CHARGE_SCOPES: Record<DeliveryChargeAppKey, DeliveryChargeAppScope> = {
  // Group 33's `*-delivery-charges-genie-delivery` keys.
  genie: { locationEFor: "UserDeliveryCharge", label: "Genie", moduleEnabled: true },
  // Group 34's `*-delivery-charges-runner-delivery` keys (sub-group 157, ids 838–841
  // plus 847 for edit) over the identical rows: `delivery_charges.php` filters nothing
  // by service line — `$eType` renames the page script and re-suffixes the five keys,
  // and the list query is `WHERE 1 = 1` — so the two menus price one table, exactly as
  // the seeded sub-group name warns. Same zones, same feature gate, different keys.
  runner: { locationEFor: "UserDeliveryCharge", label: "Runner", moduleEnabled: true },
};

/**
 * Resolve the `:app` segment to its scope. The rows are shared, so this decides
 * which zones may be picked and which permission guards the call — never which
 * rows are visible.
 */
export function requireDeliveryChargeApp(
  app: string,
): { key: DeliveryChargeAppKey } & DeliveryChargeAppScope {
  const key = (Object.keys(DELIVERY_CHARGE_SCOPES) as string[]).includes(app)
    ? (app as DeliveryChargeAppKey)
    : undefined;
  if (!key) throw AppError.badRequest(`Unknown delivery charge app “${app}”.`);
  return { key, ...DELIVERY_CHARGE_SCOPES[key] };
}

/** Live rows: editable when Inactive, hidden once Deleted. Qualified for the joined list. */
const LIVE = `eStatus <> 'Deleted'`;
const LIVE_DC = `dc.${LIVE}`;

/** The row applies to every location, not to one geo-fence zone. */
export const ALL_LOCATIONS = 0;
/** "No upper bound" — the legacy screen renders it as ∞ and stores it as this number. */
export const OPEN_ENDED_RANGE = 100_000_000;

/**
 * What the screens call a row's location: the zone name, the All-locations words, or
 * the id when the zone is gone. The last case is not cosmetic — a delete has to be
 * confirmed with this exact phrase, so a label that came out empty (a zone deleted or
 * deactivated in the location screens, which drops it out of the join) would leave the
 * row impossible to confirm and impossible to remove. The legacy list showed such a row
 * with a blank location and deleted rows without asking, so it never hit that dead end.
 */
export function scopeLabelOf(locationId: number, locationName: string): string {
  if (locationId === ALL_LOCATIONS) return "All locations";
  return locationName.trim() || `Zone #${locationId}`;
}

/** Which module switch a field is hidden behind, if any. */
export type ChargeFeature = "distanceWise" | "buyAnyService";

export interface ChargeFieldSpec {
  column: string;
  label: string;
  kind: "money" | "distance";
  required: boolean;
  min: number;
  max: number;
  /** The switch that must be on for this field to be asked about at all. */
  feature?: ChargeFeature;
  /** One-line explanation the legacy form carried as a tooltip. */
  help: string;
}

/**
 * The ten values a row carries, in the order the legacy form asks for them. Bound
 * from the DDL (`float NOT NULL` / `int NOT NULL`) rather than guessed: the money
 * ceiling matches the widest range the other fare screens accept.
 */
export const CHARGE_FIELDS: readonly ChargeFieldSpec[] = [
  {
    column: "fOrderPriceValue",
    label: "Order total",
    kind: "money",
    required: true,
    min: 0,
    max: 99_999,
    help: "The base order amount the two charges below are compared against.",
  },
  {
    column: "fDeliveryChargeAbove",
    label: "Delivery charge on orders above the order total",
    kind: "money",
    required: true,
    min: 0,
    max: 99_999,
    help: "Charged when the order total is greater than the value above.",
  },
  {
    column: "fDeliveryChargeBelow",
    label: "Delivery charge on orders below the order total",
    kind: "money",
    required: true,
    min: 0,
    max: 99_999,
    help: "Charged when the order total is lesser than the value above.",
  },
  {
    column: "fFreeOrderPriceSubtotal",
    label: "Free delivery for order amounts above",
    kind: "money",
    required: false,
    min: 0,
    max: 99_999,
    help: "Leave empty for no free-delivery threshold.",
  },
  {
    column: "iFreeDeliveryRadius",
    label: "Free delivery radius",
    kind: "distance",
    required: false,
    min: 0,
    max: 9_999,
    help: "Orders delivered within this distance are free of charge.",
  },
  {
    column: "fDeliveryChargeBuyAnyService",
    label: "Buy Any Service charge — completed orders",
    kind: "money",
    required: false,
    min: 0,
    max: 99_999,
    feature: "buyAnyService",
    help: "Only used by the Buy Any Service / order-anything-nearby flow.",
  },
  {
    column: "fDeliveryChargeBuyAnyServiceCancelledOrder",
    label: "Buy Any Service charge — cancelled orders",
    kind: "money",
    required: false,
    min: 0,
    max: 99_999,
    feature: "buyAnyService",
    help: "Kept when a Buy Any Service order is cancelled.",
  },
];

/** The two distance bounds, which the legacy form keeps beside the location rather than among the charges. */
export const DISTANCE_RANGE_FIELDS: readonly ChargeFieldSpec[] = [
  {
    column: "iDistanceRangeFrom",
    label: "Distance range from",
    kind: "distance",
    required: true,
    min: 0,
    max: 99_999,
    feature: "distanceWise",
    help: "The band starts here; the first band of a location starts at 0.",
  },
  {
    column: "iDistanceRangeTo",
    label: "Distance range to",
    kind: "distance",
    required: true,
    min: 1,
    max: 99_999,
    feature: "distanceWise",
    help: "The band ends here, or is open-ended.",
  },
];

export const FIELD_BY_COLUMN: Record<string, ChargeFieldSpec> = Object.assign(
  Object.create(null) as Record<string, ChargeFieldSpec>,
  ...[...CHARGE_FIELDS, ...DISTANCE_RANGE_FIELDS].map((f) => ({ [f.column]: f })),
);

/** Every column a save may write, so a client can never name one at random. */
const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  ...[...CHARGE_FIELDS, ...DISTANCE_RANGE_FIELDS, "iLocationId"].map((f) => ({
    [typeof f === "string" ? f : f.column]: true,
  })),
);

export interface ChargeSummaryRow {
  id: number;
  /** Zone id; `ALL_LOCATIONS` when the row covers every location. */
  locationId: number;
  /** Zone name, or "" for All locations / a zone that no longer exists. */
  locationName: string;
  /** True when the stored zone id is not in the live zone list. */
  locationMissing: boolean;
  /** What the list shows for the scope, and the phrase a delete confirmation must match. */
  scopeLabel: string;
  distanceFrom: number;
  distanceTo: number;
  /** Whether `distanceTo` is the open-ended sentinel. */
  distanceOpen: boolean;
  orderPrice: number;
  chargeAbove: number;
  chargeBelow: number;
  freeOrderSubtotal: number;
  freeRadius: number;
  buyAnyCompleted: number;
  buyAnyCancelled: number;
  status: ChargeStatus;
}

/** Raw row, values as text so the form diffs without type surprises. */
export interface ChargeRow {
  id: number;
  status: ChargeStatus;
  locationId: number;
  /** Zone name; "" for All locations or a zone that is no longer active. */
  locationName: string;
  distanceFrom: number;
  /** Open-ended bands come back as {@link OPEN_ENDED_RANGE}. */
  distanceTo: number;
  /** Values of the money / distance columns, keyed by legacy column name. */
  values: Record<string, string>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): ChargeStatus {
  return String(value) === "Inactive" ? "Inactive" : "Active";
}

/**
 * `iDeliveyChargeId` is misspelled in the legacy DDL and stays that way; the join
 * to `location_master` is a LEFT JOIN because a zone can be retired while its
 * charges are still on file.
 */
/** Qualified: `location_master` also has `iLocationId` and `eStatus`, so an unqualified
 * name in this joined select is an "ambiguous column" error rather than a guess. */
const SELECT_COLUMNS = `dc.iDeliveyChargeId AS id, dc.iLocationId AS location_id,
       COALESCE(NULLIF(lm.vLocationName, ''), '') AS location_name,
       dc.iDistanceRangeFrom AS distance_from, dc.iDistanceRangeTo AS distance_to,
       dc.fOrderPriceValue AS order_price, dc.fDeliveryChargeAbove AS charge_above,
       dc.fDeliveryChargeBelow AS charge_below, dc.fFreeOrderPriceSubtotal AS free_order_subtotal,
       dc.iFreeDeliveryRadius AS free_radius, dc.fDeliveryChargeBuyAnyService AS buy_any_completed,
       dc.fDeliveryChargeBuyAnyServiceCancelledOrder AS buy_any_cancelled,
       dc.eStatus AS status`;

const FROM_CLAUSE = `delivery_charges dc
       LEFT JOIN location_master lm ON lm.iLocationId = dc.iLocationId AND lm.eStatus = 'Active'`;

/** Newest first, as the legacy list ordered it.
 *
 * The legacy list also collapsed to one row per location (`GROUP BY iLocationId`) while
 * the distance-wise switch was off, which only looks deterministic because one scheme per
 * location was assumed — and it was assumed only by JavaScript. The amounts MySQL would
 * have picked out of such a group are arbitrary, so rows are listed individually here and
 * the one-scheme-per-location rule is enforced on write instead (see the service).
 */
const DEFAULT_ORDER = "ORDER BY dc.iDeliveyChargeId DESC";

/** Sortable headers the legacy list offered, mapped to safe SQL. */
const SORT_SQL: Record<string, string> = {
  location: "lm.vLocationName",
  orderPrice: "dc.fOrderPriceValue",
  chargeAbove: "dc.fDeliveryChargeAbove",
  chargeBelow: "dc.fDeliveryChargeBelow",
  freeOrderSubtotal: "dc.fFreeOrderPriceSubtotal",
  freeRadius: "dc.iFreeDeliveryRadius",
  status: "dc.eStatus",
  id: "dc.iDeliveyChargeId",
};

/** Whitelisted order-by clause; anything unknown falls back to the legacy default. */
function orderClause(sort: string, order: string): string {
  const column = SORT_SQL[sort];
  if (!column) return DEFAULT_ORDER;
  return `ORDER BY ${column} ${order === "asc" ? "ASC" : "DESC"}, dc.iDeliveyChargeId DESC`;
}

export interface ChargeListFilters {
  search: string;
  status?: ChargeStatus;
  sort: string;
  order: string;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Search matches the zone name or any of the numbers, as the legacy box did. */
function buildFilters(
  filters: ChargeListFilters,
): { clause: string; params: (string | number)[] } {
  const where: string[] = [LIVE_DC];
  const params: (string | number)[] = [];
  if (filters.status) {
    where.push("dc.eStatus = ?");
    params.push(filters.status);
  }
  const term = filters.search.trim();
  if (term) {
    const like = likePattern(term);
    where.push(`(NULLIF(lm.vLocationName, '') LIKE ? OR dc.fOrderPriceValue LIKE ?
        OR dc.fDeliveryChargeAbove LIKE ? OR dc.fDeliveryChargeBelow LIKE ?
        OR dc.fFreeOrderPriceSubtotal LIKE ? OR dc.iFreeDeliveryRadius LIKE ?)`);
    params.push(like, like, like, like, like, like);
  }
  return { clause: where.join(" AND "), params };
}

function mapSummaryRow(r: Record<string, string | number | null>): ChargeSummaryRow {
  const distanceTo = num(r.distance_to);
  return {
    id: num(r.id),
    locationId: num(r.location_id),
    locationName: str(r.location_name),
    locationMissing: num(r.location_id) !== ALL_LOCATIONS && !str(r.location_name),
    scopeLabel: scopeLabelOf(num(r.location_id), str(r.location_name)),
    distanceFrom: num(r.distance_from),
    distanceTo,
    distanceOpen: distanceTo >= OPEN_ENDED_RANGE,
    orderPrice: num(r.order_price),
    chargeAbove: num(r.charge_above),
    chargeBelow: num(r.charge_below),
    freeOrderSubtotal: num(r.free_order_subtotal),
    freeRadius: num(r.free_radius),
    buyAnyCompleted: num(r.buy_any_completed),
    buyAnyCancelled: num(r.buy_any_cancelled),
    status: mapStatus(r.status),
  };
}

export async function listChargePage(
  filters: ChargeListFilters,
  page: number,
  limit: number,
): Promise<ChargeSummaryRow[]> {
  const { clause, params } = buildFilters(filters);
  const offset = (page - 1) * limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS}
      FROM ${FROM_CLAUSE}
      WHERE ${clause}
      ${orderClause(filters.sort, filters.order)}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows.map(mapSummaryRow);
}

export async function countCharges(filters: ChargeListFilters): Promise<number> {
  const { clause, params } = buildFilters(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM ${FROM_CLAUSE} WHERE ${clause}`,
    params,
  );
  return num(rows[0]?.n);
}

/** Every live row, newest first — the un-paginated list. */
export async function listChargeRows(): Promise<ChargeSummaryRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_CLAUSE} WHERE ${LIVE_DC} ${DEFAULT_ORDER}`,
  );
  return rows.map(mapSummaryRow);
}

export async function findChargeRow(id: number): Promise<ChargeRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT dc.iDeliveyChargeId, dc.iLocationId, COALESCE(NULLIF(lm.vLocationName, ''), '') AS location_name,
            dc.iDistanceRangeFrom, dc.iDistanceRangeTo,
            dc.fOrderPriceValue, dc.fDeliveryChargeAbove, dc.fDeliveryChargeBelow,
            dc.fFreeOrderPriceSubtotal, dc.iFreeDeliveryRadius, dc.fDeliveryChargeBuyAnyService,
            dc.fDeliveryChargeBuyAnyServiceCancelledOrder, dc.eStatus
       FROM delivery_charges dc
       LEFT JOIN location_master lm ON lm.iLocationId = dc.iLocationId AND lm.eStatus = 'Active'
      WHERE dc.iDeliveyChargeId = ? AND dc.${LIVE} LIMIT 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: num(r.iDeliveyChargeId),
    status: mapStatus(r.eStatus),
    locationId: num(r.iLocationId),
    locationName: str(r.location_name),
    distanceFrom: num(r.iDistanceRangeFrom),
    distanceTo: num(r.iDistanceRangeTo),
    values: {
      fOrderPriceValue: str(r.fOrderPriceValue),
      fDeliveryChargeAbove: str(r.fDeliveryChargeAbove),
      fDeliveryChargeBelow: str(r.fDeliveryChargeBelow),
      fFreeOrderPriceSubtotal: str(r.fFreeOrderPriceSubtotal),
      iFreeDeliveryRadius: str(r.iFreeDeliveryRadius),
      fDeliveryChargeBuyAnyService: str(r.fDeliveryChargeBuyAnyService),
      fDeliveryChargeBuyAnyServiceCancelledOrder: str(
        r.fDeliveryChargeBuyAnyServiceCancelledOrder,
      ),
    },
  };
}

/** There is no auto-increment on this table, so the id is the highest in use plus one. */
export async function nextChargeId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iDeliveyChargeId), 0) + 1 AS nid FROM delivery_charges",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * Add a row. `values` carries every money / distance column (the service fills what
 * the form did not ask for), `iLocationId` is the caller's choice or the All-locations
 * sentinel, and the column names are re-checked against the whitelist because they
 * are interpolated into the statement.
 */
export async function insertChargeRow(
  id: number,
  input: { locationId: number; values: Record<string, string | number> },
): Promise<void> {
  const row: Record<string, string | number> = {
    iDeliveyChargeId: id,
    iLocationId: input.locationId,
    ...input.values,
  };
  for (const column of Object.keys(row)) {
    if (column !== "iDeliveyChargeId" && !Object.prototype.hasOwnProperty.call(EDITABLE_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” cannot be set on a new delivery charge.`);
    }
  }
  const columns = Object.keys(row);
  await execute(
    `INSERT INTO delivery_charges (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
}

/** Write several columns of one row in a single statement, whitelisted names only. */
export async function updateChargeColumns(
  id: number,
  sets: { column: string; value: string | number }[],
): Promise<void> {
  if (!sets.length) return;
  for (const { column } of sets) {
    if (!Object.prototype.hasOwnProperty.call(EDITABLE_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” is not editable here.`);
    }
  }
  await execute(
    `UPDATE delivery_charges SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iDeliveyChargeId = ? AND ${LIVE} LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

export async function setChargeStatus(id: number, status: ChargeStatus): Promise<void> {
  await execute(
    `UPDATE delivery_charges SET eStatus = ? WHERE iDeliveyChargeId = ? AND ${LIVE} LIMIT 1`,
    [status, id],
  );
}

/** Soft delete: the apps stop pricing with the row, and the row stays in the table. */
export async function softDeleteCharge(id: number): Promise<void> {
  await execute(
    `UPDATE delivery_charges SET eStatus = 'Deleted' WHERE iDeliveyChargeId = ? AND ${LIVE} LIMIT 1`,
    [id],
  );
}

/** Live ranges of one location, so a new band can be checked for overlap. */
export async function listDistanceRanges(
  locationId: number,
  exceptId: number | null,
): Promise<{ id: number; from: number; to: number }[]> {
  const rows = await query<{ iDeliveyChargeId: number | null; f: number | null; t: number | null }>(
    `SELECT iDeliveyChargeId, iDistanceRangeFrom AS f, iDistanceRangeTo AS t
       FROM delivery_charges
      WHERE iLocationId = ? AND ${LIVE} AND iDeliveyChargeId <> ?
      ORDER BY iDistanceRangeFrom`,
    [locationId, exceptId ?? 0],
  );
  return rows.map((r) => ({ id: num(r.iDeliveyChargeId), from: num(r.f), to: num(r.t) }));
}

/** One entry of a scope dropdown. */
export interface ScopeOption {
  id: number;
  name: string;
}

/**
 * Geo-fence zones this screen may charge by. Filtered by `eFor`, as the legacy form
 * did: a zone tagged for vehicle types is not a delivery-charge area, and the
 * All-locations sentinel is added by the caller.
 */
export async function listLocationOptions(eFor: string): Promise<ScopeOption[]> {
  const rows = await query<{ iLocationId: number | null; name: string | null }>(
    `SELECT iLocationId, vLocationName AS name
       FROM location_master WHERE eFor = ? AND eStatus = 'Active' ORDER BY vLocationName`,
    [eFor],
  );
  return rows.map((r) => ({ id: num(r.iLocationId), name: str(r.name) }));
}

/** True when the id is the sentinel or a live zone of this screen's own marker. */
export async function isKnownLocation(eFor: string, id: number): Promise<boolean> {
  if (id === ALL_LOCATIONS) return true;
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM location_master WHERE iLocationId = ? AND eFor = ? AND eStatus = 'Active'`,
    [id, eFor],
  );
  return num(rows[0]?.n) > 0;
}

/** The two switches the legacy screen branched its form and its list on. */
export interface DeliveryChargeFeatures {
  /** `ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER` — bands per distance, frozen location on edit. */
  distanceWise: boolean;
  /** `ENABLE_BUY_ANY_SERVICE_MODULE` with the app's own module on — the two extra charges. */
  buyAnyService: boolean;
}

/**
 * Read the switches from `configurations`, the same rows General Settings edits. The
 * legacy `isEnableAnywhereDeliveryFeature()` also demanded the `GENIE_ENABLED` PHP
 * constant; that half is carried by the app registry's `moduleEnabled`, because a
 * menu only exists in the sidebar when its own module is on.
 */
export async function readFeatures(
  scope: DeliveryChargeAppScope,
): Promise<DeliveryChargeFeatures> {
  const rows = await query<{ vName: string | null; vValue: string | null }>(
    `SELECT vName, vValue FROM configurations
      WHERE vName IN ('ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER', 'ENABLE_BUY_ANY_SERVICE_MODULE')
        AND eStatus = 'Active'`,
  );
  const value: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const r of rows) value[str(r.vName)] = str(r.vValue);
  const yes = (key: string) => value[key]?.trim().toLowerCase() === "yes";
  return {
    distanceWise: yes("ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER"),
    buyAnyService: yes("ENABLE_BUY_ANY_SERVICE_MODULE") && scope.moduleEnabled,
  };
}

/** The default currency, so the form can label its amounts the way the legacy one did. */
export interface CurrencyInfo {
  name: string;
  symbol: string;
}

export async function readDefaultCurrency(): Promise<CurrencyInfo> {
  const rows = await query<{ vName: string | null; vSymbol: string | null }>(
    "SELECT vName, vSymbol FROM currency WHERE eDefault = 'Yes' LIMIT 1",
  );
  return { name: str(rows[0]?.vName), symbol: str(rows[0]?.vSymbol) };
}

/** Flags, currency and zones are reference reads that change far less often than the rows. */
const metaCache = createTtlCache<ScreenMeta>(60_000, 4);

export interface ScreenMeta {
  features: DeliveryChargeFeatures;
  currency: CurrencyInfo;
  locations: ScopeOption[];
}

/** Everything the form needs to know that is not about one row. */
export async function readScreenMeta(scope: DeliveryChargeAppScope): Promise<ScreenMeta> {
  // Keyed by both halves of what the lookup depends on, so a second app's module
  // flag can never be served from Genie's entry. A switch flipped on General
  // Settings shows up here within the TTL.
  const key = `${scope.locationEFor}|${scope.moduleEnabled}`;
  return metaCache.load(key, async () => {
    const [features, currency, locations] = await Promise.all([
      readFeatures(scope),
      readDefaultCurrency(),
      listLocationOptions(scope.locationEFor),
    ]);
    return { features, currency, locations };
  });
}
