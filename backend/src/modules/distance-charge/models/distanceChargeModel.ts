import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";

/**
 * Data access for the legacy `custom_delivery_charges_order` table — what a delivery
 * pays out over a given distance, per vehicle type. One row is one band of one vehicle
 * type: from X to Y km, this much for a completed order, this much for a cancelled one.
 *
 * Delivery Genie → Distance wise Delivery Charges (#sub-155) is the first screen built on
 * it, and it is the child of Delivery Charges (#sub-154): the same
 * `ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER` switch that makes the parent price by distance
 * bands is the only thing that puts this menu in the legacy sidebar
 * (`isEnableDistanceWiseDeliveryChargeOrder()`), and `?eType=genie|runner` again changes
 * only which permission keys the screen demands. The table has no service-line column, so
 * Genie (33/155), Runner (34/158) and the un-suffixed menu (9/27) read and write the very
 * same rows — hence an `:app` segment that gates keys, never rows.
 *
 * Four things about this table shape everything below:
 *
 * - no primary key, no index, **no auto-increment**: `iDeliveyChargeId` is this table's own
 *   keyless id, spelled exactly like `delivery_charges`' id without referring to it. Both
 *   tables hold a #1 and a #2 because each counted from 1, which is why a new row is
 *   `MAX(iDeliveyChargeId)+1` — the legacy `INSERT` omitted the column and would now fail
 *   outright under this install's `STRICT_TRANS_TABLES`;
 * - the vehicle type is the row's owner and its location comes through it: `vehicle_type`
 *   carries `iLocationId`, where **-1 means every location** (the parent table's sentinel
 *   is 0 for that, so the two screens cannot share a constant);
 * - `iDistanceRangeTo = 100000000` is the "and above" marker, entered by a
 *   `set_to_infinity` checkbox and rendered ∞;
 * - **deletes are hard, and have to be.** Every reader of these rows matches on distance
 *   alone — `WHERE $distance >= iDistanceRangeFrom AND $distance <= iDistanceRangeTo`, no
 *   `eStatus`, no `iVehicleTypeId` — and takes the first row it gets. Hiding a band would
 *   leave it pricing live orders, so `action/custom_delivery_charges_order_action.php`'s
 *   real `DELETE` is the only correct behaviour here, and `eStatus` is never written.
 */

/** Menus that expose this shared table. Genie and Runner; the un-suffixed menu is not built. */
export type DistanceChargeAppKey = "genie" | "runner";

/** What one `:app` menu brings to the same set of rows. */
export interface DistanceChargeAppScope {
  /** `vehicle_type.eType` whose types the vehicle-type dropdown lists. */
  vehicleTypeEType: string;
  /** Human label used in messages and the editor header. */
  label: string;
}

export const DISTANCE_CHARGE_SCOPES: Record<DistanceChargeAppKey, DistanceChargeAppScope> = {
  // Group 33's `*-custom-delivery-charges-genie-delivery` keys.
  genie: { vehicleTypeEType: "DeliverAll", label: "Genie" },
  // Group 34's `*-custom-delivery-charges-runner-delivery` keys (sub-group 158, ids 842–845;
  // the seeded 846 update-status is Inactive and this screen owns no status route at all) over
  // the identical bands. `custom_delivery_charges_order.php:269` builds the vehicle-type
  // dropdown with a hard-coded `AND vt.eType = 'DeliverAll'` that never looks at `$eType`, and
  // the list query joins `$tblname` with no service-line filter — so `?eType=runner` only
  // renamed the page script and re-suffixed the four keys. Runner prices Genie's rows and
  // offers Genie's vehicle types, exactly as sub-group 158's seeded name warns.
  runner: { vehicleTypeEType: "DeliverAll", label: "Runner" },
};

/**
 * Resolve the `:app` segment to its scope. The rows are shared, so this decides which
 * vehicle types may be picked and which permission guards the call — never which rows are
 * visible.
 */
export function requireDistanceChargeApp(
  app: string,
): { key: DistanceChargeAppKey } & DistanceChargeAppScope {
  const key = (Object.keys(DISTANCE_CHARGE_SCOPES) as string[]).includes(app)
    ? (app as DistanceChargeAppKey)
    : undefined;
  if (!key) throw AppError.badRequest(`Unknown distance-wise delivery charge app “${app}”.`);
  return { key, ...DISTANCE_CHARGE_SCOPES[key] };
}

/** Rows this screen hides from nobody: the enum's only other value, written by no reader. */
const LIVE = `dc.eStatus = 'Active'`;

/** `vehicle_type.iLocationId` for a type that is priced everywhere, not in one zone. */
export const ALL_LOCATIONS_MARKER = -1;
/** "No upper bound" — the legacy screen renders it as ∞ and stores it as this number. */
export const OPEN_ENDED_RANGE = 100_000_000;

/**
 * What the list shows in its Localization column: the vehicle type's own zone, or the
 * words the legacy list used when the type covers every zone. A type whose zone row was
 * retired says nothing at all, so the id is shown instead of a blank cell.
 */
export function localizationLabelOf(locationId: number, locationName: string): string {
  if (locationId === ALL_LOCATIONS_MARKER) return "All Locations";
  if (!locationName.trim()) return locationId ? `Location #${locationId}` : "No location";
  return locationName.trim();
}

/**
 * The phrase a delete has to be typed back. Two rows of one vehicle type are told apart
 * by their band, and a band alone is not unique across vehicle types (a 0 – 100 km charge
 * of the motorbike and of the car are different rows), so the label carries both — and
 * keeps the band readable rather than as `200 – ∞`, which nobody types.
 *
 * The name is never allowed to come out empty: a vehicle type deleted behind these rows
 * falls back to its id, exactly as the parent screen falls back to a zone id, because an
 * empty confirmation phrase would make such a row impossible to delete at all.
 */
export function rowLabelOf(
  vehicleTypeName: string,
  vehicleTypeId: number,
  from: number,
  to: number,
): string {
  const name = vehicleTypeName.trim() || `Vehicle type #${vehicleTypeId}`;
  const high = to >= OPEN_ENDED_RANGE ? "infinity" : `${to}`;
  return `${name} ${from}-${high}`;
}

export interface DistanceChargeFieldSpec {
  column: string;
  label: string;
  kind: "money" | "distance";
  required: boolean;
  min: number;
  max: number;
  /** Stored and displayed, but never written — the legacy form hid it on purpose. */
  readOnly?: boolean;
  /** One-line explanation the form carries beside the input. */
  help: string;
}

/**
 * The three amounts a row carries. The DDL calls all three `decimal(9,2) NOT NULL`; the
 * ceiling is the one the other fare screens accept, well inside what the column stores.
 */
export const DISTANCE_CHARGE_FIELDS: readonly DistanceChargeFieldSpec[] = [
  {
    column: "fDeliveryCharge",
    label: "Delivery pay per order to driver — completed orders",
    kind: "money",
    required: true,
    min: 0,
    max: 99_999,
    help: "What the driver is paid for a delivery that finishes inside this band.",
  },
  {
    column: "fDeliveryChargeCancelled",
    label: "Delivery pay per order to driver — cancelled orders",
    kind: "money",
    required: true,
    min: 0,
    max: 99_999,
    help: "What the driver keeps when the order is cancelled.",
  },
  {
    column: "fDeliveryChargeUser",
    label: "Amount added to the customer's delivery charge",
    kind: "money",
    required: false,
    min: 0,
    max: 99_999,
    readOnly: true,
    help: "Commented out of the legacy form and always stored as 0. The apps still add it " +
      "to what the customer pays, so a row carrying a value there is shown rather than hidden.",
  },
];

/** The band, which the legacy editor freezes the moment the row exists. */
export const DISTANCE_BAND_FIELDS: readonly DistanceChargeFieldSpec[] = [
  {
    column: "iDistanceRangeFrom",
    label: "Distance range from",
    kind: "distance",
    required: true,
    min: 0,
    max: 99_999,
    help: "The band starts here; a vehicle type's first band starts at 0.",
  },
  {
    column: "iDistanceRangeTo",
    label: "Distance range to",
    kind: "distance",
    required: true,
    min: 1,
    max: 99_999,
    help: "The band ends here, or is open-ended.",
  },
];

export const FIELD_BY_COLUMN: Record<string, DistanceChargeFieldSpec> = Object.assign(
  Object.create(null) as Record<string, DistanceChargeFieldSpec>,
  ...[...DISTANCE_CHARGE_FIELDS, ...DISTANCE_BAND_FIELDS].map((f) => ({ [f.column]: f })),
);

/** Every column a save may write, so a client can never name one at random. */
const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  ...[...DISTANCE_CHARGE_FIELDS, ...DISTANCE_BAND_FIELDS, "iVehicleTypeId"].map((f) => ({
    [typeof f === "string" ? f : f.column]: true,
  })),
);

/** Filtered out of the writable set: readable, but the legacy form never let go of it. */
export const READ_ONLY_COLUMNS: Record<string, true> = Object.fromEntries(
  [...DISTANCE_CHARGE_FIELDS, ...DISTANCE_BAND_FIELDS]
    .filter((f) => f.readOnly)
    .map((f) => [f.column, true as const]),
) as Record<string, true>;

export interface DistanceChargeSummaryRow {
  id: number;
  vehicleTypeId: number;
  /** English name of the vehicle type, or "" when the row outlived it. */
  vehicleTypeName: string;
  /** True when the stored vehicle type is gone from `vehicle_type` entirely. */
  vehicleMissing: boolean;
  /** `vehicle_type.eStatus`; "" when the type no longer exists. */
  vehicleStatus: string;
  locationId: number;
  locationName: string;
  /** What the Localization column shows — the type's zone, or "All Locations". */
  localizationLabel: string;
  distanceFrom: number;
  distanceTo: number;
  /** Whether `distanceTo` is the open-ended sentinel. */
  distanceOpen: boolean;
  /** Text of the band, without a unit: the panel knows `DEFAULT_DISTANCE_UNIT` itself. */
  distanceLabel: string;
  driverCompleted: number;
  driverCancelled: number;
  userCharge: number;
  /** What a delete must be confirmed with. */
  rowLabel: string;
}

/** Raw row, money and distance values as text so the form diffs without type surprises. */
export interface DistanceChargeRow {
  id: number;
  vehicleTypeId: number;
  vehicleTypeName: string;
  /** `vehicle_type.eStatus`; "" when the type no longer exists. */
  vehicleTypeStatus: string;
  locationId: number;
  locationName: string;
  distanceFrom: number;
  /** Open-ended bands come back as {@link OPEN_ENDED_RANGE}. */
  distanceTo: number;
  /** Values of the money columns, keyed by legacy column name. */
  values: Record<string, string>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `iDeliveyChargeId` is misspelled in the legacy DDL and stays that way. Both joins are
 * LEFT JOINs without a status filter, because a vehicle type can be retired or deactivated
 * while its bands are still on file — the legacy list showed those rows with their name
 * either way, which is the honest thing to do with a row that still prices orders.
 */
const SELECT_COLUMNS = `dc.iDeliveyChargeId AS id, dc.iVehicleTypeId AS vehicle_type_id,
       COALESCE(NULLIF(vt.vVehicleType_EN, ''), NULLIF(vt.vVehicleType, ''), '') AS vehicle_type_name,
       COALESCE(vt.eStatus, '') AS vehicle_type_status,
       COALESCE(vt.iLocationId, 0) AS location_id,
       COALESCE(NULLIF(lm.vLocationName, ''), '') AS location_name,
       dc.iDistanceRangeFrom AS distance_from, dc.iDistanceRangeTo AS distance_to,
       dc.fDeliveryCharge AS driver_completed, dc.fDeliveryChargeCancelled AS driver_cancelled,
       dc.fDeliveryChargeUser AS user_charge`;

const FROM_CLAUSE = `custom_delivery_charges_order dc
       LEFT JOIN vehicle_type vt ON vt.iVehicleTypeId = dc.iVehicleTypeId
       LEFT JOIN location_master lm ON lm.iLocationId = vt.iLocationId`;

/** Newest first: the legacy list had no ORDER BY at all, so this is storage order reversed. */
const DEFAULT_ORDER = "ORDER BY dc.iDeliveyChargeId DESC";

/** Sortable headers, mapped to safe SQL. */
const SORT_SQL: Record<string, string> = {
  vehicleType: "vehicle_type_name",
  localization: "location_name",
  distanceFrom: "dc.iDistanceRangeFrom",
  distanceTo: "dc.iDistanceRangeTo",
  driverCompleted: "dc.fDeliveryCharge",
  driverCancelled: "dc.fDeliveryChargeCancelled",
  id: "dc.iDeliveyChargeId",
};

/** Whitelisted order-by clause; anything unknown falls back to the legacy default. */
function orderClause(sort: string, order: string): string {
  const column = SORT_SQL[sort];
  if (!column) return DEFAULT_ORDER;
  return `ORDER BY ${column} ${order === "asc" ? "ASC" : "DESC"}, dc.iDeliveyChargeId DESC`;
}

export interface DistanceChargeListFilters {
  search: string;
  sort: string;
  order: string;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Search matches the vehicle type, its zone, or any of the numbers, as the parent screen does. */
function buildFilters(filters: DistanceChargeListFilters): { clause: string; params: (string | number)[] } {
  const where: string[] = [LIVE];
  const params: (string | number)[] = [];
  const term = filters.search.trim();
  if (term) {
    const like = likePattern(term);
    where.push(`(vt.vVehicleType_EN LIKE ? OR lm.vLocationName LIKE ?
        OR dc.iDistanceRangeFrom LIKE ? OR dc.iDistanceRangeTo LIKE ?
        OR dc.fDeliveryCharge LIKE ? OR dc.fDeliveryChargeCancelled LIKE ?)`);
    params.push(like, like, like, like, like, like);
  }
  return { clause: where.join(" AND "), params };
}

function mapSummaryRow(r: Record<string, string | number | null>): DistanceChargeSummaryRow {
  const distanceTo = num(r.distance_to);
  const vehicleName = str(r.vehicle_type_name).trim();
  return {
    id: num(r.id),
    vehicleTypeId: num(r.vehicle_type_id),
    vehicleTypeName: vehicleName,
    vehicleMissing: str(r.vehicle_type_status) === "",
    vehicleStatus: str(r.vehicle_type_status),
    locationId: num(r.location_id),
    locationName: str(r.location_name),
    localizationLabel: localizationLabelOf(num(r.location_id), str(r.location_name)),
    distanceFrom: num(r.distance_from),
    distanceTo,
    distanceOpen: distanceTo >= OPEN_ENDED_RANGE,
    distanceLabel: `${num(r.distance_from)} – ${distanceTo >= OPEN_ENDED_RANGE ? "∞" : distanceTo}`,
    driverCompleted: num(r.driver_completed),
    driverCancelled: num(r.driver_cancelled),
    userCharge: num(r.user_charge),
    rowLabel: rowLabelOf(vehicleName, num(r.vehicle_type_id), num(r.distance_from), distanceTo),
  };
}

export async function listBandPage(
  filters: DistanceChargeListFilters,
  page: number,
  limit: number,
): Promise<DistanceChargeSummaryRow[]> {
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

export async function countBands(filters: DistanceChargeListFilters): Promise<number> {
  const { clause, params } = buildFilters(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM ${FROM_CLAUSE} WHERE ${clause}`,
    params,
  );
  return num(rows[0]?.n);
}

/** Every live row, newest first — the un-paginated list. */
export async function listBandRows(): Promise<DistanceChargeSummaryRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_CLAUSE} WHERE ${LIVE} ${DEFAULT_ORDER}`,
  );
  return rows.map(mapSummaryRow);
}

export async function findBandRow(id: number): Promise<DistanceChargeRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT dc.iDeliveyChargeId, dc.iVehicleTypeId,
            COALESCE(NULLIF(vt.vVehicleType_EN, ''), NULLIF(vt.vVehicleType, ''), '') AS vehicle_type_name,
            COALESCE(vt.eStatus, '') AS vehicle_type_status,
            COALESCE(vt.iLocationId, 0) AS location_id,
            COALESCE(NULLIF(lm.vLocationName, ''), '') AS location_name,
            dc.iDistanceRangeFrom, dc.iDistanceRangeTo, dc.fDeliveryCharge,
            dc.fDeliveryChargeCancelled, dc.fDeliveryChargeUser
       FROM custom_delivery_charges_order dc
       LEFT JOIN vehicle_type vt ON vt.iVehicleTypeId = dc.iVehicleTypeId
       LEFT JOIN location_master lm ON lm.iLocationId = vt.iLocationId
      WHERE dc.iDeliveyChargeId = ? AND ${LIVE} LIMIT 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: num(r.iDeliveyChargeId),
    vehicleTypeId: num(r.iVehicleTypeId),
    vehicleTypeName: str(r.vehicle_type_name),
    vehicleTypeStatus: str(r.vehicle_type_status),
    locationId: num(r.location_id),
    locationName: str(r.location_name),
    distanceFrom: num(r.iDistanceRangeFrom),
    distanceTo: num(r.iDistanceRangeTo),
    values: {
      fDeliveryCharge: str(r.fDeliveryCharge),
      fDeliveryChargeCancelled: str(r.fDeliveryChargeCancelled),
      fDeliveryChargeUser: str(r.fDeliveryChargeUser),
    },
  };
}

/** There is no auto-increment on this table, so the id is the highest in use plus one. */
export async function nextBandId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iDeliveyChargeId), 0) + 1 AS nid FROM custom_delivery_charges_order",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * Add a row. `values` carries every money and band column (the service fills what the
 * form did not ask for and 0 for the customer surcharge the legacy always wrote), and the
 * column names are re-checked against the whitelist because they are interpolated into the
 * statement.
 */
export async function insertBandRow(
  id: number,
  input: { vehicleTypeId: number; values: Record<string, string | number> },
): Promise<void> {
  const row: Record<string, string | number> = {
    iDeliveyChargeId: id,
    iVehicleTypeId: input.vehicleTypeId,
    ...input.values,
  };
  for (const column of Object.keys(row)) {
    if (column !== "iDeliveyChargeId" && !Object.prototype.hasOwnProperty.call(EDITABLE_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” cannot be set on a new distance-wise charge.`);
    }
  }
  const columns = Object.keys(row);
  await execute(
    `INSERT INTO custom_delivery_charges_order (${columns.map((c) => `\`${c}\``).join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((c) => row[c]),
  );
}

/** Write the changed columns of one row. The band and the vehicle type are not among them. */
export async function updateBandColumns(
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
    `UPDATE custom_delivery_charges_order SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iDeliveyChargeId = ? AND eStatus = 'Active' LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

/**
 * A real DELETE, matching the legacy action. Nothing softer is possible: every reader
 * selects these rows by distance without looking at `eStatus`, so a hidden band would go
 * on pricing orders nobody can see or cancel from this screen.
 */
export async function deleteBandRow(id: number): Promise<void> {
  await execute("DELETE FROM custom_delivery_charges_order WHERE iDeliveyChargeId = ? LIMIT 1", [id]);
}

/**
 * The bands one vehicle type already holds, lowest first — the chain a new band has to
 * join. An edit never consults them, because a stored band cannot be moved.
 */
export async function listBandsOfVehicleType(
  vehicleTypeId: number,
): Promise<{ id: number; from: number; to: number }[]> {
  const rows = await query<{ iDeliveyChargeId: number | null; f: number | null; t: number | null }>(
    `SELECT iDeliveyChargeId, iDistanceRangeFrom AS f, iDistanceRangeTo AS t
       FROM custom_delivery_charges_order
      WHERE iVehicleTypeId = ? AND eStatus = 'Active'
      ORDER BY iDistanceRangeFrom`,
    [vehicleTypeId],
  );
  return rows.map((r) => ({ id: num(r.iDeliveyChargeId), from: num(r.f), to: num(r.t) }));
}

/** Every band on file, grouped by vehicle type — what a chain map is built from. */
export async function listAllBands(): Promise<{ vehicleTypeId: number; from: number; to: number }[]> {
  const rows = await query<{ iVehicleTypeId: number | null; f: number | null; t: number | null }>(
    `SELECT iVehicleTypeId, iDistanceRangeFrom AS f, iDistanceRangeTo AS t
       FROM custom_delivery_charges_order
      WHERE eStatus = 'Active'
      ORDER BY iVehicleTypeId, iDistanceRangeFrom`,
  );
  return rows.map((r) => ({ vehicleTypeId: num(r.iVehicleTypeId), from: num(r.f), to: num(r.t) }));
}

/** One entry of the vehicle-type dropdown, with the zone label the legacy option carried. */
export interface VehicleTypeOption {
  id: number;
  name: string;
  locationId: number;
  /** The type's zone label, "All Locations" included. */
  localizationLabel: string;
}

/**
 * Vehicle types this screen may price. The legacy form listed
 * `eStatus='Active' AND eType='DeliverAll'` — the delivery line of `vehicle_type`, which is
 * what #sub-153 edits — and labelled each option `Name (zone)`.
 */
export async function listVehicleTypeOptions(eType: string): Promise<VehicleTypeOption[]> {
  const rows = await query<{
    iVehicleTypeId: number | null;
    name: string | null;
    iLocationId: number | null;
    location_name: string | null;
  }>(
    `SELECT vt.iVehicleTypeId,
            COALESCE(NULLIF(vt.vVehicleType_EN, ''), NULLIF(vt.vVehicleType, ''), '') AS name,
            COALESCE(vt.iLocationId, 0) AS iLocationId,
            COALESCE(NULLIF(lm.vLocationName, ''), '') AS location_name
       FROM vehicle_type vt
       LEFT JOIN location_master lm ON lm.iLocationId = vt.iLocationId
      WHERE vt.eStatus = 'Active' AND vt.eType = ?
      ORDER BY vt.iDisplayOrder, vt.iVehicleTypeId`,
    [eType],
  );
  return rows.map((r) => {
    const locationId = num(r.iLocationId);
    return {
      id: num(r.iVehicleTypeId),
      name: str(r.name).trim(),
      locationId,
      localizationLabel: localizationLabelOf(locationId, str(r.location_name)),
    };
  });
}

/** True when the id is a vehicle type this screen may offer (active, and of its own line). */
export async function isKnownVehicleType(eType: string, id: number): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM vehicle_type WHERE iVehicleTypeId = ? AND eType = ? AND eStatus = 'Active'`,
    [id, eType],
  );
  return num(rows[0]?.n) > 0;
}

/** The switch that owns this screen, and the unit the band inputs are labelled with. */
export interface DistanceChargeFeatures {
  /** `ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER`. Off, no app reads a single band. */
  distanceWise: boolean;
}

/**
 * Read the switch from `configurations`, the row General Settings edits. The legacy menu
 * hid the screen when it was off but left the page reachable by URL, and the pricing code
 * simply stopped consulting these rows — so an admin can still edit bands that nothing
 * reads, which is worth saying out loud rather than refusing.
 */
export async function readFeatures(): Promise<DistanceChargeFeatures> {
  const rows = await query<{ vName: string | null; vValue: string | null }>(
    `SELECT vName, vValue FROM configurations
      WHERE vName = 'ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER' AND eStatus = 'Active'`,
  );
  return { distanceWise: str(rows[0]?.vValue).trim().toLowerCase() === "yes" };
}

/** `DEFAULT_DISTANCE_UNIT`, which the legacy list put in its column header. */
export async function readDistanceUnit(): Promise<string> {
  const rows = await query<{ vValue: string | null }>(
    `SELECT vValue FROM configurations
      WHERE vName = 'DEFAULT_DISTANCE_UNIT' AND eStatus = 'Active' LIMIT 1`,
  );
  return str(rows[0]?.vValue).trim() || "KMs";
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

/** Flags, currency, unit and vehicle types are reference reads that change less often than the rows. */
const metaCache = createTtlCache<ScreenMeta>(60_000, 4);

export interface ScreenMeta {
  features: DistanceChargeFeatures;
  currency: CurrencyInfo;
  distanceUnit: string;
  vehicleTypes: VehicleTypeOption[];
}

/** Everything the form needs to know that is not about one row. */
export async function readScreenMeta(scope: DistanceChargeAppScope): Promise<ScreenMeta> {
  // Keyed by the service line the dropdown is filtered by, so a second app's list can
  // never be served from Genie's entry. A switch flipped on General Settings, or a
  // vehicle type added on #sub-153, shows up here within the TTL.
  const key = scope.vehicleTypeEType;
  return metaCache.load(key, async () => {
    const [features, currency, distanceUnit, vehicleTypes] = await Promise.all([
      readFeatures(),
      readDefaultCurrency(),
      readDistanceUnit(),
      listVehicleTypeOptions(scope.vehicleTypeEType),
    ]);
    return { features, currency, distanceUnit, vehicleTypes };
  });
}
