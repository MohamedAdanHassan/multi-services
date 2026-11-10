import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import type { ContentFieldKind } from "../../../utils/contentSanitizer";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `vehicle_type` table. One row per bookable type
 * ("Normal", "Luxurious", a Cargo Car, an ambulance…) carries its name in 26
 * languages, its artwork, the fare engine the apps quote with, and the pick-up /
 * night surcharge schedule.
 *
 * The table is shared across service lines, scoped by the `eType` column, so the
 * same editor drives several screens: Taxi Service → Vehicle Type (#sub-15) over
 * `eType='Ride'`, Parcel Delivery → Vehicle Type (#sub-138) over `eType='Deliver'`
 * and Delivery Genie → Vehicle Type (#sub-153) over `eType='DeliverAll'` — the
 * slice the legacy `store_vehicle_type.php?eType=genie` screen served, which its
 * own header spelled out as applying to "Delivery Genie, Delivery Runner & Store
 * Deliveries". Delivery Runner → Vehicle Type (#sub-156) owns those very same
 * `DeliverAll` rows: the legacy screen took `?eType=runner` only to rename its page
 * script and swap the suffix of the five permission keys it checked, while the row
 * filter stayed the hard-coded `AND eType = 'DeliverAll'`, and the seeded sub-group
 * is even named `Vehicle Type (Please note that … will be applied into Delivery
 * Genie, Delivery Runner & Store Deliveries.)`. It is a separate `:app` because the
 * keys differ, not because the data does. Which slice a request may touch is
 * decided by the `:app` URL segment: {@link requireVehicleTypeApp} maps it to a
 * {@link VehicleTypeAppScope}
 * (the `eType` rows to expose, the `eFor` marker the service-category dropdown
 * lists, and a label), and every query below binds to that scope so no app can
 * reach another's rows. Display group 7 seeds the `*-vehicle-type-taxi-service`
 * keys for Ride, group 32 the `*-vehicle-type-parcel-delivery` keys for Deliver,
 * group 33 the `*-vehicle-type-genie-delivery` keys for DeliverAll and group 34 the
 * `*-vehicle-type-runner-delivery` keys guarding those same DeliverAll rows.
 *
 * Two quirks of the legacy DDL shape everything below:
 *
 * - the table has no primary key, no index and no auto-increment, so a new id
 *   comes from `MAX(iVehicleTypeId)+1` and each statement is a single one;
 * - ten other tables reference `iVehicleTypeId` (trips, bookings, fare tables,
 *   rental packages), so deletes are soft: `eStatus='Deleted'` hides a type from
 *   the apps and from this screen without breaking the history pointing at it.
 */

export type TypeStatus = "Active" | "Inactive";

/** Apps this shared table is exposed through, keyed by the `:app` URL segment. */
export type VehicleTypeAppKey = "ride" | "delivery" | "genie" | "runner";

/** The slice of `vehicle_type` one app owns: its `eType` rows and category marker. */
export interface VehicleTypeAppScope {
  /** Value of the `eType` service-line scope column this app owns. */
  eType: string;
  /** `eFor` marker of the `vehicle_category` rows the Service-category dropdown lists. */
  categoryEFor: string;
  /** Human label used in messages and the editor header. */
  label: string;
}

export const VEHICLE_TYPE_SCOPES: Record<VehicleTypeAppKey, VehicleTypeAppScope> = {
  ride: { eType: "Ride", categoryEFor: "RideCategory", label: "Ride" },
  delivery: { eType: "Deliver", categoryEFor: "DeliveryCategory", label: "Delivery" },
  // Genie shares the `DeliverAll` rows with the legacy Store / DeliverAll screen and
  // with Runner: the apps differ only in whose permission keys guard them, which is
  // why they are separate `:app` entries rather than one alias. Changing a type here
  // changes it for all of them, exactly as the legacy screen warned on its own page.
  genie: { eType: "DeliverAll", categoryEFor: "DeliverAllCategory", label: "Genie" },
  // The same two clauses as `genie` above, deliberately: the legacy
  // `store_vehicle_type.php?eType=runner` never widened or narrowed the row filter, it
  // only swapped the key suffix. A runner create therefore appears in the Genie list
  // and vice versa — the sharing is the legacy behaviour, not a leak.
  runner: { eType: "DeliverAll", categoryEFor: "DeliverAllCategory", label: "Runner" },
};

/**
 * Resolve the `:app` segment to its scope, rejecting anything not whitelisted.
 * The returned object also carries the canonical `key`, so callers can look up
 * app-specific values (permissions, labels) without re-trusting the raw string.
 */
export function requireVehicleTypeApp(
  app: string,
): { key: VehicleTypeAppKey } & VehicleTypeAppScope {
  const key = (Object.keys(VEHICLE_TYPE_SCOPES) as string[]).includes(app)
    ? (app as VehicleTypeAppKey)
    : undefined;
  if (!key) throw AppError.badRequest(`Unknown vehicle type app “${app}”.`);
  return { key, ...VEHICLE_TYPE_SCOPES[key] };
}

/** Row scope of a request: live types of one app (Inactive editable, Deleted hidden). */
function scopeClause(eType: string): string {
  return `eType = '${eType}' AND eStatus <> 'Deleted'`;
}

/** Languages the legacy table pre-allocates a column for. */
export const TYPE_LANGUAGES = TRANSLATION_LANGUAGES;
/** Language a row must be readable in even when nothing else is translated. */
export const PRIMARY_LANGUAGE = "EN";
/** Days the surcharge schedule is kept for, in the order the legacy columns name them. */
export const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABELS: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

/** `MySQL time` columns of this table always read back as `HH:MM:SS`. */
export const BLANK_TIME = "00:00:00";

/**
 * Per-language scalar columns. `vVehicleType_<LANG>` also has an unsuffixed
 * sibling `vVehicleType`, which every Ride row keeps equal to the English name —
 * the legacy apps still read it, so `mirror` says to write both.
 */
export interface TextFamilySpec {
  key: string;
  base: string;
  label: string;
  kind: ContentFieldKind;
  max: number;
  multiline: boolean;
  /** Unsuffixed legacy column that must follow the primary-language value. */
  mirror?: string;
}

export const TEXT_FAMILIES: readonly TextFamilySpec[] = [
  {
    key: "name",
    base: "vVehicleType",
    label: "Vehicle type name",
    kind: "text",
    max: 100,
    multiline: false,
    mirror: "vVehicleType",
  },
  {
    key: "rentalAlias",
    base: "vRentalAlias",
    label: "Rental name",
    kind: "text",
    max: 100,
    multiline: false,
  },
];

/** Artwork columns: a bare file name the apps concatenate into an image URL. */
export interface MediaColumnSpec {
  column: string;
  label: string;
}

export const MEDIA_COLUMNS: readonly MediaColumnSpec[] = [
  { column: "vLogo", label: "Logo" },
  { column: "vLogo1", label: "Alternate logo" },
];

/**
 * Enum and number columns. `dflt` is the legacy DDL default (or the only legal
 * value where the DDL declares none, as with `eOTPCodeEnable`), so a created row
 * looks exactly like one the legacy installer would have written. `group` lets
 * the editor lay the columns out as the four blocks the screen shows.
 */
export type SettingGroup = "general" | "fare" | "policy" | "surcharge";

export type SettingSpec =
  | { column: string; label: string; group: SettingGroup; kind: "enum"; values: readonly string[]; dflt: string; note?: string }
  | { column: string; label: string; group: SettingGroup; kind: "int"; min: number; max: number; dflt: number; note?: string }
  | { column: string; label: string; group: SettingGroup; kind: "float"; min: number; max: number; dflt: number; note?: string };

export const SETTINGS: readonly SettingSpec[] = [
  // ── what the type is ────────────────────────────────────────────────────────
  { column: "eIconType", label: "Icon", group: "general", kind: "enum", values: ["Car", "Bike", "Cycle", "Truck", "Fly", "Ambulance"], dflt: "Car" },
  { column: "eFareType", label: "Fare basis", group: "general", kind: "enum", values: ["Regular", "Fixed", "Hourly"], dflt: "Fixed", note: "Regular quotes per KM, Fixed charges the fixed fare, Hourly the per-hour rate." },
  { column: "eFareCalcModel", label: "Fare model", group: "general", kind: "enum", values: ["Fixed", "Incremental"], dflt: "Incremental" },
  { column: "iPersonSize", label: "Seats", group: "general", kind: "int", min: 1, max: 50, dflt: 4, note: "passengers" },
  { column: "eAllowQty", label: "Allow ride quantity", group: "general", kind: "enum", values: ["Yes", "No"], dflt: "No" },
  { column: "iMaxQty", label: "Maximum rides", group: "general", kind: "int", min: 0, max: 999, dflt: 1 },
  { column: "ePoolStatus", label: "Pool rides", group: "general", kind: "enum", values: ["Yes", "No"], dflt: "No" },
  { column: "fPoolPercentage", label: "Pool fare share", group: "general", kind: "float", min: 0, max: 100, dflt: 0, note: "percent" },
  { column: "eOTPCodeEnable", label: "OTP code", group: "general", kind: "enum", values: ["No", "Yes"], dflt: "No" },
  { column: "eFly", label: "Fly (airport) trips", group: "general", kind: "enum", values: ["0", "1"], dflt: "0", note: "On makes the type use the airport fare tables." },
  { column: "eDeliveryType", label: "Stops", group: "general", kind: "enum", values: ["", "Single", "Multi"], dflt: "", note: "Empty is not a delivery type." },
  { column: "eDeliveryHelper", label: "Delivery helper", group: "general", kind: "enum", values: ["No", "Yes"], dflt: "No" },
  { column: "iDisplayOrder", label: "Display order", group: "general", kind: "int", min: 0, max: 9_999, dflt: 1 },
  { column: "fCommision", label: "Commission", group: "general", kind: "float", min: 0, max: 100, dflt: 0, note: "percent" },

  // ── the fare engine ───────────────────────────────────────────────────────
  { column: "fFixedFare", label: "Fixed fare", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fPricePerKM", label: "Price per KM", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fPricePerMin", label: "Price per minute", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fPricePerHour", label: "Price per hour", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fMinHour", label: "Minimum hours", group: "fare", kind: "float", min: 0, max: 999, dflt: 0 },
  { column: "fTimeSlot", label: "Time slot length", group: "fare", kind: "float", min: 0, max: 999, dflt: 0, note: "hours" },
  { column: "fTimeSlotPrice", label: "Time slot price", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "iBaseFare", label: "Base fare", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "iMinFare", label: "Minimum fare", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fVisitFee", label: "Visit fee", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fRadius", label: "Service radius", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fBufferAmount", label: "Buffer amount", group: "fare", kind: "float", min: 0, max: 99_999, dflt: 0 },

  // ── waiting, cancellation and extra charges ─────────────────────────────────
  { column: "fWaitingFees", label: "Waiting fees", group: "policy", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "iWaitingFeeTimeLimit", label: "Waiting fee starts after", group: "policy", kind: "int", min: 0, max: 9_999, dflt: 0, note: "minutes" },
  { column: "fCancellationFare", label: "Cancellation fare", group: "policy", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "iCancellationTimeLimit", label: "Cancellation charge window", group: "policy", kind: "int", min: 0, max: 9_999, dflt: 0, note: "minutes" },
  { column: "fTripHoldFees", label: "Trip hold fee", group: "policy", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fDeliveryCharge", label: "Delivery charge", group: "policy", kind: "float", min: 0, max: 99_999, dflt: 0 },
  { column: "fDeliveryChargeCancelOrder", label: "Delivery cancel charge", group: "policy", kind: "float", min: 0, max: 99_999, dflt: 0 },

  // ── surcharge switches (the schedules live in the time columns below) ───────
  { column: "ePickStatus", label: "Pick-up surcharge", group: "surcharge", kind: "enum", values: ["Active", "Inactive"], dflt: "Inactive" },
  { column: "fPickUpPrice", label: "Pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "eNightStatus", label: "Night surcharge", group: "surcharge", kind: "enum", values: ["Active", "Inactive"], dflt: "Inactive" },
  { column: "fNightPrice", label: "Night surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  // Per-day overrides of the pick-up surcharge amount. `pickups` below pairs them
  // with their window columns so the editor can render one row per weekday.
  { column: "fMonPickUpPrice", label: "Monday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fTuePickUpPrice", label: "Tuesday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fWedPickUpPrice", label: "Wednesday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fThuPickUpPrice", label: "Thursday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fFriPickUpPrice", label: "Friday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fSatPickUpPrice", label: "Saturday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
  { column: "fSunPickUpPrice", label: "Sunday pick-up surcharge amount", group: "surcharge", kind: "float", min: 0, max: 99_999, dflt: 1 },
];

/** `column` → spec, prototype-less so `__proto__` cannot resolve to anything. */
export const SETTINGS_BY_COLUMN: Record<string, SettingSpec> = Object.assign(
  Object.create(null) as Record<string, SettingSpec>,
  Object.fromEntries(SETTINGS.map((s) => [s.column, s])),
);

/**
 * The four `MySQL time` columns holding the row-wide surcharge windows. The
 * per-day schedules override them: `t<Day>PickStartTime` / `EndTime` as columns,
 * the night counterparts inside the `tNightSurgeData` JSON blob.
 */
export interface TimeColumnSpec {
  column: string;
  label: string;
}

export const GLOBAL_TIMES: readonly TimeColumnSpec[] = [
  { column: "tPickStartTime", label: "Pick-up surcharge from" },
  { column: "tPickEndTime", label: "Pick-up surcharge to" },
  { column: "tNightStartTime", label: "Night surcharge from" },
  { column: "tNightEndTime", label: "Night surcharge to" },
];

/** One weekday's pick-up surcharge window; the amount is a `f<Day>PickUpPrice` setting. */
export interface PickupDaySpec {
  day: string;
  label: string;
  start: string;
  end: string;
  price: string;
}

export const PICKUP_DAYS: readonly PickupDaySpec[] = WEEK_DAYS.map((day) => ({
  day,
  label: DAY_LABELS[day] ?? day,
  start: `t${day}PickStartTime`,
  end: `t${day}PickEndTime`,
  price: `f${day}PickUpPrice`,
}));

/**
 * One of the 21 keys the night surcharge blob stores. Values are strings — the
 * legacy app writes `"18:00"` as often as `"18:00:00"` and prices as `"2"`, so
 * the shape is validated but the text is stored exactly as sent.
 */
export interface SurgeKeySpec {
  key: string;
  day: string;
  label: string;
  kind: "time" | "float";
}

export const SURGE_KEYS: readonly SurgeKeySpec[] = WEEK_DAYS.flatMap((day) => [
  { key: `t${day}NightStartTime`, day, label: `${DAY_LABELS[day]} from`, kind: "time" },
  { key: `t${day}NightEndTime`, day, label: `${DAY_LABELS[day]} to`, kind: "time" },
  { key: `f${day}NightPrice`, day, label: `${DAY_LABELS[day]} amount`, kind: "float" },
]);

/** Columns stored as a flat JSON object of `<column>_<LANG>` keys. */
export interface BlobColumnSpec {
  column: string;
  label: string;
  kind: ContentFieldKind;
}

export const BLOB_COLUMNS: readonly BlobColumnSpec[] = [
  { column: "tTypeDesc", label: "Type description", kind: "html" },
  { column: "tInfoText", label: "Info text", kind: "html" },
  { column: "tDeliveryHelperNoteUser", label: "Helper note for the rider", kind: "html" },
  { column: "tDeliveryHelperNoteDriver", label: "Helper note for the driver", kind: "html" },
];

/**
 * Columns this screen shows but never writes: the geo cascade is owned by the
 * location screens. The zone (`iLocationid`) and category (`iVehicleCategoryId`)
 * bindings ARE editable — see `SCOPE_COLUMNS` — but only against ids that exist.
 */
export const READONLY_COLUMNS = [
  "eType",
  "iCountryId",
  "iStateId",
  "iCityId",
  "vAddress",
] as const;

/** Sentinels the legacy app itself stores: no zone, no category. */
export const ALL_LOCATIONS = -1;
export const NO_CATEGORY = 0;

/**
 * Writable scope columns with their sentinels. A value outside the sentinel is
 * only legal when the referenced legacy row still exists, which the service
 * checks before the write — these columns have no foreign keys to lean on.
 */
export const SCOPE_COLUMNS = {
  location: { column: "iLocationid", sentinel: ALL_LOCATIONS, label: "Availability location" },
  category: { column: "iVehicleCategoryId", sentinel: NO_CATEGORY, label: "Service category" },
} as const;

/** Per-language name / rental-alias columns, in `<base>_<LANG>` form, plus mirrors. */
export const TEXT_COLUMN_NAMES: readonly string[] = TEXT_FAMILIES.flatMap((f) => [
  ...TYPE_LANGUAGES.map((l) => `${f.base}_${l.code}`),
  ...(f.mirror ? [f.mirror] : []),
]);

/** Every column this screen may write. */
export const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  Object.fromEntries(
    [
      SCOPE_COLUMNS.location.column,
      SCOPE_COLUMNS.category.column,
      ...TEXT_COLUMN_NAMES,
      ...MEDIA_COLUMNS.map((m) => m.column),
      ...SETTINGS.map((s) => s.column),
      ...GLOBAL_TIMES.map((t) => t.column),
      ...PICKUP_DAYS.flatMap((d) => [d.start, d.end, d.price]),
      ...BLOB_COLUMNS.map((b) => b.column),
      // The night-surcharge blob is written as a whole, never key by key.
      "tNightSurgeData",
    ].map((column) => [column, true as const]),
  ),
);

/** Columns a legal clock value may look like: `HH:MM` or `HH:MM:SS`. */
export const CLOCK = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * Values every NOT NULL column without a DDL default needs filled in with, plus
 * the scope columns. `vehicle_type` declares 95 of those, so a create cannot rely
 * on MySQL to fill anything in; the editable ones are then overwritten with what
 * the admin actually asked for.
 */
export const CREATE_DEFAULTS: Record<string, string | number> = Object.assign(
  Object.create(null) as Record<string, string | number>,
  {
    eType: "Ride",
    eStatus: "Active",
    iVehicleCategoryId: 0,
    iLocationid: -1,
    iCountryId: 0,
    iStateId: 0,
    iCityId: 0,
    vAddress: "",
    tNightSurgeData: "",
  },
  Object.fromEntries(TEXT_COLUMN_NAMES.map((c) => [c, ""])),
  Object.fromEntries(MEDIA_COLUMNS.map((m) => [m.column, ""])),
  Object.fromEntries(BLOB_COLUMNS.map((b) => [b.column, ""])),
  Object.fromEntries(SETTINGS.map((s) => [s.column, s.dflt])),
  Object.fromEntries(GLOBAL_TIMES.map((t) => [t.column, BLANK_TIME])),
  Object.fromEntries(
    PICKUP_DAYS.flatMap((d) => [
      [d.start, BLANK_TIME],
      [d.end, BLANK_TIME],
    ]),
  ),
);

/** Columns an INSERT may name: the defaults above, and nothing else. */
export const INSERT_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  { iVehicleTypeId: true as const },
  Object.fromEntries(Object.keys(CREATE_DEFAULTS).map((column) => [column, true as const])),
);

/** Listing shape: no blobs, just what the table shows. */
export interface TypeSummaryRow {
  id: number;
  name: string;
  status: TypeStatus;
  iconType: string;
  fareType: string;
  logo: string;
  persons: number;
  displayOrder: number;
  pool: string;
  otp: string;
  commission: number;
  baseFare: number;
  perKm: number;
  /** Per-order charge a completed delivery earns the app — the fare line of the delivery slices. */
  deliveryCharge: number;
  /** Per-order charge kept when a delivery is cancelled. */
  cancelCharge: number;
  /** How far a driver is dispatched for this type, in the app's length unit. */
  radius: number;
  /** How many of the 26 `vVehicleType_*` columns carry a name. */
  namesFilled: number;
}

/** Detail shape: every editable column plus the read-only scope columns. */
export interface TypeRow {
  id: number;
  status: TypeStatus;
  /** Raw column values keyed by column name (prototype-less). */
  values: Record<string, string | number | null>;
  /** Scope / geo columns, shown but never written. */
  readonly: Record<string, string | number | null>;
}

/** Rows that still point at a type; decides whether a delete would strand them. */
export interface TypeUsage {
  ongoingTrips: number;
  openBookings: number;
  openRequests: number;
  rentalPackages: number;
  tripRecords: number;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): TypeStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

const LIST_COLUMNS = `SELECT iVehicleTypeId AS id, vVehicleType_EN AS name, eStatus, eIconType, eFareType,
         vLogo AS logo, iPersonSize, iDisplayOrder, ePoolStatus, eOTPCodeEnable, fCommision,
         iBaseFare, fPricePerKM, fDeliveryCharge, fDeliveryChargeCancelOrder, fRadius,
         ${TYPE_LANGUAGES.map((l) => `CHAR_LENGTH(vVehicleType_${l.code}) AS name_${l.code}`).join(",\n         ")}
       FROM vehicle_type`;

const LIST_ORDER = "ORDER BY iDisplayOrder, iVehicleTypeId";

function mapTypeSummaryRow(r: Record<string, string | number | null>): TypeSummaryRow {
  return {
    id: num(r.id),
    name: str(r.name).trim(),
    status: mapStatus(r.eStatus),
    iconType: str(r.eIconType),
    fareType: str(r.eFareType),
    logo: str(r.logo).trim(),
    persons: num(r.iPersonSize),
    displayOrder: num(r.iDisplayOrder),
    pool: str(r.ePoolStatus),
    otp: str(r.eOTPCodeEnable),
    commission: num(r.fCommision),
    baseFare: num(r.iBaseFare),
    perKm: num(r.fPricePerKM),
    deliveryCharge: num(r.fDeliveryCharge),
    cancelCharge: num(r.fDeliveryChargeCancelOrder),
    radius: num(r.fRadius),
    namesFilled: TYPE_LANGUAGES.filter((l) => num(r[`name_${l.code}`]) > 0).length,
  };
}

/** All live types of one app, in the order the apps list them. */
export async function listTypeRows(scope: VehicleTypeAppScope): Promise<TypeSummaryRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `${LIST_COLUMNS} WHERE ${scopeClause(scope.eType)} ${LIST_ORDER}`,
  );
  return rows.map(mapTypeSummaryRow);
}

export interface TypeListFilters {
  /** Partial English name, already trimmed. */
  search: string;
  /** Restrict to one status (undefined keeps Active + Inactive). */
  status?: TypeStatus;
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params for page/count so they never drift. */
function buildFilters(
  scope: VehicleTypeAppScope,
  f: TypeListFilters,
): { where: string; params: unknown[] } {
  const clauses: string[] = [scopeClause(scope.eType)];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push("vVehicleType_EN LIKE ?");
    params.push(likePattern(f.search));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One filtered page of an app's types, in the display order. */
export async function listTypePage(
  scope: VehicleTypeAppScope,
  filters: TypeListFilters & { page: number; limit: number },
): Promise<TypeSummaryRow[]> {
  const { where, params } = buildFilters(scope, filters);
  const offset = (filters.page - 1) * filters.limit;
  const rows = await query<Record<string, string | number | null>>(
    `${LIST_COLUMNS} ${where} ${LIST_ORDER} LIMIT ? OFFSET ?`,
    [...params, filters.limit, offset],
  );
  return rows.map(mapTypeSummaryRow);
}

/** Total live types of one app matching the same filters (for the page count). */
export async function countTypes(
  scope: VehicleTypeAppScope,
  filters: TypeListFilters,
): Promise<number> {
  const { where, params } = buildFilters(scope, filters);
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM vehicle_type ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * One live type of the app's scope. The table has 131 columns and this screen owns
 * most of them, so the row is read whole and then split: `values` keeps only the
 * columns in `EDITABLE_COLUMNS`, `readonly` only the scope columns. Reading `*`
 * means a column the whitelist does not know about can never be written by accident.
 */
export async function findTypeRow(
  scope: VehicleTypeAppScope,
  id: number,
): Promise<TypeRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT * FROM vehicle_type WHERE iVehicleTypeId = ? AND ${scopeClause(scope.eType)} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const values = Object.create(null) as Record<string, string | number | null>;
  for (const column of Object.keys(EDITABLE_COLUMNS)) {
    values[column] = r[column] ?? null;
  }
  const readonly = Object.create(null) as Record<string, string | number | null>;
  for (const column of READONLY_COLUMNS) {
    readonly[column] = r[column] ?? null;
  }
  return { id: num(r.iVehicleTypeId), status: mapStatus(r.eStatus), values, readonly };
}

/**
 * Write several columns of one type in a single statement. `sets[].column` is
 * interpolated (column names cannot be bound), so it must pass the
 * `EDITABLE_COLUMNS` whitelist — anything else is refused before SQL is built.
 */
export async function updateTypeColumns(
  scope: VehicleTypeAppScope,
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
    `UPDATE vehicle_type SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iVehicleTypeId = ? AND ${scopeClause(scope.eType)} LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

export async function setTypeStatus(
  scope: VehicleTypeAppScope,
  id: number,
  status: TypeStatus,
): Promise<void> {
  await execute(
    `UPDATE vehicle_type SET eStatus = ? WHERE iVehicleTypeId = ? AND ${scopeClause(scope.eType)} LIMIT 1`,
    [status, id],
  );
}

/** There is no auto-increment, so the new id is the highest one in use, plus one. */
export async function nextTypeId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iVehicleTypeId), 0) + 1 AS nid FROM vehicle_type",
  );
  return Number(rows[0]?.nid ?? 1);
}

/** Next display order within the app's scope, so a new type lands at the end. */
export async function nextDisplayOrder(scope: VehicleTypeAppScope): Promise<number> {
  const rows = await query<{ n: number | null }>(
    `SELECT COALESCE(MAX(iDisplayOrder), 0) + 1 AS n FROM vehicle_type WHERE ${scopeClause(scope.eType)}`,
  );
  return Number(rows[0]?.n ?? 1);
}

/**
 * Add a type to the app's scope. `values` is merged over `CREATE_DEFAULTS`, the
 * `eType` is forced to the scope's own value (never a client's), and because the
 * column names are interpolated every key is re-checked against `INSERT_COLUMNS` —
 * the id itself is supplied by the caller, not by a client.
 */
export async function insertTypeRow(
  scope: VehicleTypeAppScope,
  id: number,
  values: Record<string, string | number>,
): Promise<void> {
  const row = Object.assign({}, CREATE_DEFAULTS, values, { eType: scope.eType });
  if (Number(row.iVehicleTypeId) !== id) row.iVehicleTypeId = id;

  const columns = Object.keys(row).filter((column) =>
    Object.prototype.hasOwnProperty.call(row, column),
  );
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(INSERT_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” cannot be set on a new vehicle type.`);
    }
  }
  if (!columns.includes("iVehicleTypeId")) columns.unshift("iVehicleTypeId");

  await execute(
    `INSERT INTO vehicle_type (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
}

/** Soft delete: the apps stop offering the type, the history keeps its pointer. */
export async function softDeleteType(scope: VehicleTypeAppScope, id: number): Promise<void> {
  await execute(
    `UPDATE vehicle_type SET eStatus = 'Deleted' WHERE iVehicleTypeId = ? AND ${scopeClause(scope.eType)} LIMIT 1`,
    [id],
  );
}

/**
 * What still references the type. Only live work blocks a delete: an ongoing or
 * just-arrived trip, an open booking or request, or a rental package that would
 * be left without a type. Finished history is reported, not guarded.
 */
export async function countTypeUsage(id: number): Promise<TypeUsage> {
  const rows = await query<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM trips WHERE iVehicleTypeId = ? AND iActive IN ('On Going Trip', 'Arrived')) AS ongoing_trips,
       (SELECT COUNT(*) FROM cab_booking WHERE iVehicleTypeId = ? AND eStatus IN ('Pending', 'Assign', 'Accepted')) AS open_bookings,
       (SELECT COUNT(*) FROM cab_request_now WHERE iVehicleTypeId = ? AND eStatus IN ('Requesting', 'Pending')) AS open_requests,
       (SELECT COUNT(*) FROM rental_package WHERE iVehicleTypeId = ?) AS rental_packages,
       (SELECT COUNT(*) FROM trips WHERE iVehicleTypeId = ?) AS trip_records`,
    [id, id, id, id, id],
  );
  const r = rows[0] ?? {};
  return {
    ongoingTrips: num(r.ongoing_trips),
    openBookings: num(r.open_bookings),
    openRequests: num(r.open_requests),
    rentalPackages: num(r.rental_packages),
    tripRecords: num(r.trip_records),
  };
}

/** True when another type in the app's scope already carries this name (case-insensitive). */
export async function isNameTaken(
  scope: VehicleTypeAppScope,
  name: string,
  exceptId: number | null,
): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM vehicle_type
      WHERE ${scopeClause(scope.eType)} AND TRIM(vVehicleType_EN) = ? AND iVehicleTypeId <> ?`,
    [name, exceptId ?? 0],
  );
  return num(rows[0]?.n) > 0;
}

/** One entry of a scope dropdown. */
export interface ScopeOption {
  id: number;
  name: string;
}

/**
 * Location zones (`location_master`). Not filtered by `eFor`: the id only has to
 * exist, and hiding zones tagged for other features would make rows already
 * pointing at one unshowable.
 */
export async function listLocationZoneOptions(): Promise<ScopeOption[]> {
  const rows = await query<{ iLocationId: number | null; name: string | null }>(
    `SELECT iLocationId, vLocationName AS name
       FROM location_master
      WHERE eStatus = 'Active'
      ORDER BY vLocationName`,
  );
  return rows.map((r) => ({ id: num(r.iLocationId), name: str(r.name).trim() }));
}

/** The app's service categories (`vehicle_category`), in the order the apps list them. */
export async function listCategoryOptions(scope: VehicleTypeAppScope): Promise<ScopeOption[]> {
  const rows = await query<{ iVehicleCategoryId: number | null; name: string | null }>(
    `SELECT iVehicleCategoryId, vCategory_EN AS name
       FROM vehicle_category
      WHERE eFor = '${scope.categoryEFor}' AND eStatus <> 'Deleted'
      ORDER BY iDisplayOrder, iVehicleCategoryId`,
  );
  return rows.map((r) => ({ id: num(r.iVehicleCategoryId), name: str(r.name).trim() }));
}

/** Existence checks for the two scope ids — the legacy columns have no keys. */
export async function locationZoneExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    "SELECT COUNT(*) AS n FROM location_master WHERE iLocationId = ? AND eStatus <> 'Deleted'",
    [id],
  );
  return num(rows[0]?.n) > 0;
}

export async function categoryExists(scope: VehicleTypeAppScope, id: number): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM vehicle_category
      WHERE iVehicleCategoryId = ? AND eFor = '${scope.categoryEFor}' AND eStatus <> 'Deleted'`,
    [id],
  );
  return num(rows[0]?.n) > 0;
}

/**
 * Label of one referenced row, existence deliberately not filtered: a type may
 * still be bound to a zone or category that was soft-deleted after linking, and
 * the editor must show what is actually stored rather than pretend it is unset.
 */
export async function findLocationZoneName(id: number): Promise<string> {
  const rows = await query<{ name: string | null }>(
    "SELECT vLocationName AS name FROM location_master WHERE iLocationId = ? LIMIT 1",
    [id],
  );
  return str(rows[0]?.name).trim();
}

export async function findCategoryName(id: number): Promise<string> {
  const rows = await query<{ name: string | null }>(
    "SELECT vCategory_EN AS name FROM vehicle_category WHERE iVehicleCategoryId = ? LIMIT 1",
    [id],
  );
  return str(rows[0]?.name).trim();
}
