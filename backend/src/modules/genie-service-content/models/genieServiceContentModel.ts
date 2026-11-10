import { AppError } from "../../../errors/AppError";
import { execute, query } from "../../../db/mysql";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the delivery apps' root row of the legacy `vehicle_category` table
 * (Delivery Genie → Manage Service/Content, group 33 → #sub-141, and its Delivery Runner
 * twin, group 34 → #sub-144).
 *
 * The screen both legacy menus call "Manage Service/Content" opens
 * `vehicle_category_action.php?eServiceType=Genie&id=280` for one app and
 * `…?eServiceType=Runner&id=287` for the other: ONE row each, the app's root category
 * (`iParentId = 0`, `eCatType = 'Genie'` or `'Runner'`), holding everything that app's
 * service list and home tile render. Three kinds of state live in that row, each stored
 * differently, and this layer keeps the difference visible instead of flattening it:
 *
 * - the category NAME is a family of per-language columns (`vCategory_EN`,
 *   `vCategory_AR`, …) — the table pre-allocates one column per shipped language;
 * - the promotional-banner and home-page copy are single JSON columns keyed
 *   `<base>_<LANG>`, merged key by key by the service;
 * - artwork columns keep a bare file name, and settings columns are enums or numbers
 *   whose legal values come from the legacy DDL.
 *
 * `eFor` is NOT usable as the scope here: the Genie and Runner root rows store it empty
 * (only the delivery/ride children carry `DeliveryCategory`, `RideCategory`, …), so the
 * row is pinned by `eCatType` + `iParentId = 0` instead.
 *
 * The table is MyISAM with no primary key and no auto-increment, so every write is a
 * single statement — one that re-binds the scope in its WHERE, so no payload can reach
 * another app's row — and nothing here ever inserts or deletes: the legacy app seeds the
 * row, and this screen edits it.
 */

export type ServiceContentStatus = "Active" | "Inactive";

/**
 * The delivery apps that own a root row here, as their menu segments name them. One tuple
 * is the single source of truth: the scope map below, the route's `:app` enum and the
 * permission-key table all come from it, so an app cannot be registered in one place and
 * half-wired in another.
 */
export const SERVICE_CONTENT_APPS = ["genie", "runner"] as const;
export type ServiceContentApp = (typeof SERVICE_CONTENT_APPS)[number];

/** The row filter of one app's screen: its live root category. */
export interface ServiceContentScope {
  app: ServiceContentApp;
  /** Legacy `eCatType` of the app's root row. */
  eCatType: string;
  /** Module name, as the sidebar prints it. */
  label: string;
  /** Screen name, as the legacy page titles its editor. */
  screenName: string;
}

export const SERVICE_CONTENT_SCOPES: Record<ServiceContentApp, ServiceContentScope> = {
  genie: {
    app: "genie",
    eCatType: "Genie",
    label: "Delivery Genie",
    screenName: "Manage Service/Content",
  },
  runner: {
    app: "runner",
    eCatType: "Runner",
    label: "Delivery Runner",
    screenName: "Manage Service/Content",
  },
};

/**
 * Scope of a route's `:app` segment. The route's enum admits only the keys of the map
 * above, so this is the runtime bridge from `req.params` — a plain string — to the typed
 * scope, and the refusal exists for a path that reaches it without going through that
 * validation (a future caller forgetting the guard) rather than for a typo an admin can
 * type into a URL.
 */
export function requireScope(name: unknown): ServiceContentScope {
  const key = String(name ?? "");
  const scope = (SERVICE_CONTENT_SCOPES as Record<string, ServiceContentScope>)[key];
  if (!scope) throw AppError.badRequest(`Unknown service content app: “${key || "(empty)"}”.`);
  return scope;
}

/** Languages the legacy table pre-allocates a `vCategory_<CODE>` column for. */
export const CATEGORY_LANGUAGES = TRANSLATION_LANGUAGES;

/** The per-language name columns, as `<column>_<LANG>` — never built from a payload. */
export const NAME_COLUMN = "vCategory";
export const NAME_COLUMNS: readonly string[] = CATEGORY_LANGUAGES.map(
  (l) => `${NAME_COLUMN}_${l.code}`,
);

/**
 * JSON columns this screen edits, each keyed `<base>_<LANG>`. One column can carry more
 * than one base: `vServiceCatTitleHomepage` stores both the home-page title and the
 * sub-title the legacy "Shown In Service Section" tab shows.
 */
export interface BlobColumnSpec {
  key: string;
  label: string;
  /** Bases the legacy form actually writes into this column, in form order. */
  bases: readonly string[];
}

export const BLOB_COLUMNS: readonly BlobColumnSpec[] = [
  { key: "tPromoteBannerTitle", label: "Promotional banner title", bases: ["tPromoteBannerTitle"] },
  {
    key: "vServiceCatTitleHomepage",
    label: "Home page service copy",
    bases: ["vServiceCatTitleHomepage", "vServiceCatSubTitleHomepage"],
  },
];

export const BLOB_BY_KEY: Record<string, BlobColumnSpec> = Object.assign(
  Object.create(null) as Record<string, BlobColumnSpec>,
  Object.fromEntries(BLOB_COLUMNS.map((b) => [b.key, b])),
);

/**
 * Artwork columns, each with the directory its file lives in. `dir` is where NEW uploads
 * are written (inside this app's upload root) and `legacyDir` is the relative path inside
 * the read-only legacy install the pre-existing files were written to — they are not the
 * same tree, and both have to be readable or every seeded row shows an empty box.
 */
export interface ImageSlotSpec {
  /** URL name of the slot, as the route's `:slot` segment spells it. */
  slot: string;
  column: string;
  label: string;
  /** Module folder new uploads land in, under the write root. */
  dir: string;
  /**
   * Directory of the file the LEGACY panel wrote, relative to the legacy install root.
   * Vehicle-category artwork is filed per row, so this takes the row id.
   */
  legacyDir: (id: number) => string[];
}

const VEHICLE_CATEGORY_LEGACY_DIR = ["webimages", "icons", "VehicleCategory"];
const HOME_SERVICES_LEGACY_DIR = ["assets", "img", "home-new", "services"];

export const IMAGE_SLOTS: readonly ImageSlotSpec[] = [
  {
    slot: "icon",
    column: "vListLogo3",
    label: "Icon",
    dir: "VehicleCategory",
    legacyDir: (id) => [...VEHICLE_CATEGORY_LEGACY_DIR, String(id)],
  },
  {
    slot: "promote",
    column: "vPromoteBannerImage",
    label: "Promotional banner image",
    dir: "VehicleCategory",
    legacyDir: (id) => [...VEHICLE_CATEGORY_LEGACY_DIR, String(id)],
  },
  {
    slot: "full-logo",
    column: "vHomepageFullLogo",
    label: "Home page Our Services image",
    dir: "HomeServices",
    legacyDir: () => HOME_SERVICES_LEGACY_DIR,
  },
  {
    slot: "services-icon",
    column: "vHomepageLogoOurServices",
    label: "Home page Our Services icon",
    dir: "HomeServices",
    legacyDir: () => HOME_SERVICES_LEGACY_DIR,
  },
];

export const SLOT_BY_NAME: Record<string, ImageSlotSpec> = Object.assign(
  Object.create(null) as Record<string, ImageSlotSpec>,
  Object.fromEntries(IMAGE_SLOTS.map((s) => [s.slot, s])),
);

export const IMAGE_COLUMNS: readonly string[] = IMAGE_SLOTS.map((s) => s.column);

/**
 * Scalar settings this screen writes. `values` is the DDL's member list — what a save may
 * store — and it is what the form renders. `storedOnly` names values the live row can hold
 * without being writable: `eOTPCodeEnable` reads back as `''` on both root rows (280 and
 * 287), which `enum('No','Yes')` only accepted because an old session ran without
 * STRICT_TRANS_TABLES (MySQL keeps such a row at
 * enum index 0 and reads it back as the empty string). Writing it back is refused by the
 * server today — `Data truncated for column` under strict mode — so the row must be READ as
 * `''` and written as one of the real members.
 */
export type SettingSpec =
  | {
      column: string;
      label: string;
      kind: "enum";
      values: readonly string[];
      /** Stored-but-illegal members: readable, never writable. */
      storedOnly?: readonly string[];
    }
  | { column: string; label: string; kind: "int"; min: number; max: number };

export const SETTINGS: readonly SettingSpec[] = [
  {
    column: "eOTPCodeEnable",
    label: "OTP / confirmation code",
    kind: "enum",
    values: ["No", "Yes"],
    storedOnly: [""],
  },
  { column: "ePromoteBanner", label: "Promote as banner", kind: "enum", values: ["No", "Yes"] },
  { column: "iDisplayOrder", label: "Display order", kind: "int", min: 0, max: 9_999 },
  { column: "iDisplayOrderHomepage", label: "Home page display order", kind: "int", min: 0, max: 9_999 },
];

export const SETTINGS_BY_COLUMN: Record<string, SettingSpec> = Object.assign(
  Object.create(null) as Record<string, SettingSpec>,
  Object.fromEntries(SETTINGS.map((s) => [s.column, s])),
);

/**
 * Every column this layer may write. UPDATE statements interpolate column names, so
 * membership is re-checked before SQL is built: an interpolated name must be one of ours.
 */
export const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  Object.fromEntries(
    [...NAME_COLUMNS, ...IMAGE_COLUMNS, ...BLOB_COLUMNS.map((b) => b.key), ...SETTINGS.map((s) => s.column)].map(
      (column) => [column, true as const],
    ),
  ),
);

/** Listing / header shape: what the panel shows for the one row. */
export interface ServiceContentSummaryRow {
  id: number;
  catType: string;
  status: ServiceContentStatus;
  /** Name in the default language, or the first non-empty one. */
  displayName: string;
  namesFilled: number;
  displayOrder: number;
  displayOrderHomepage: number;
  otpEnabled: string;
  promoteBanner: string;
  /** Stored file name of the icon, empty when the row holds none. */
  icon: string;
  promoteImage: string;
}

/** Detail shape: every writable column plus the read-only scope columns. */
export interface ServiceContentRow {
  id: number;
  catType: string;
  parentId: number;
  status: ServiceContentStatus;
  /** Raw column values keyed by column name (prototype-less). */
  values: Record<string, string | number | null>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): ServiceContentStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/**
 * `WHERE` fragment pinning a row to this app's root category. `eCatType` is interpolated
 * (the scope is read before the values are bound), so it is re-checked against the shape
 * the table actually holds even though every value comes from the scope map above: a
 * future entry with a stray quote in it must fail here rather than build SQL.
 */
const CAT_TYPE = /^[A-Za-z0-9_]{1,32}$/;

function scopeSql(scope: ServiceContentScope): string {
  if (!CAT_TYPE.test(scope.eCatType)) {
    throw AppError.badRequest(`Invalid service type “${scope.eCatType}”.`);
  }
  return `iParentId = 0 AND eCatType = '${scope.eCatType}' AND eStatus <> 'Deleted'`;
}

const SELECT_COLUMNS = [
  "iVehicleCategoryId AS id",
  "eCatType",
  "iParentId",
  "eStatus",
  ...NAME_COLUMNS,
  ...IMAGE_COLUMNS,
  ...BLOB_COLUMNS.map((b) => b.key),
  ...SETTINGS.map((s) => s.column),
].join(", ");

/** The app's root row, or null when the id belongs to another app / a child row. */
export async function findRow(
  scope: ServiceContentScope,
  id: number,
): Promise<ServiceContentRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM vehicle_category
      WHERE iVehicleCategoryId = ? AND ${scopeSql(scope)} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const values = Object.create(null) as Record<string, string | number | null>;
  for (const column of [
    ...NAME_COLUMNS,
    ...IMAGE_COLUMNS,
    ...BLOB_COLUMNS.map((b) => b.key),
    ...SETTINGS.map((s) => s.column),
  ]) {
    values[column] = r[column] ?? null;
  }
  return {
    id: num(r.id),
    catType: str(r.eCatType),
    parentId: num(r.iParentId),
    status: mapStatus(r.eStatus),
    values,
  };
}

/** The app's live root rows. There is one today; the list keeps it honest. */
export async function listRows(scope: ServiceContentScope): Promise<ServiceContentSummaryRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM vehicle_category
      WHERE ${scopeSql(scope)}
      ORDER BY iDisplayOrder, iVehicleCategoryId`,
  );
  return rows.map((r) => ({
    id: num(r.id),
    catType: str(r.eCatType),
    status: mapStatus(r.eStatus),
    displayName:
      str(r[`${NAME_COLUMN}_EN`]).trim() ||
      CATEGORY_LANGUAGES.map((l) => str(r[`${NAME_COLUMN}_${l.code}`]).trim()).find(Boolean) ||
      "",
    namesFilled: CATEGORY_LANGUAGES.filter((l) => str(r[`${NAME_COLUMN}_${l.code}`]).trim()).length,
    displayOrder: num(r.iDisplayOrder),
    displayOrderHomepage: num(r.iDisplayOrderHomepage),
    otpEnabled: str(r.eOTPCodeEnable),
    promoteBanner: str(r.ePromoteBanner),
    icon: str(r.vListLogo3).trim(),
    promoteImage: str(r.vPromoteBannerImage).trim(),
  }));
}

/**
 * Write several columns of the row in ONE statement. `sets[].column` is interpolated
 * (column names cannot be bound), so it must pass the `EDITABLE_COLUMNS` whitelist —
 * anything else is refused before any SQL is built. One statement is also the point:
 * the table is MyISAM, so a save that spans two could half-apply.
 */
export async function updateRowColumns(
  scope: ServiceContentScope,
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
    `UPDATE vehicle_category SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iVehicleCategoryId = ? AND ${scopeSql(scope)} LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

/** Flip the row's status. */
export async function setRowStatus(
  scope: ServiceContentScope,
  id: number,
  status: ServiceContentStatus,
): Promise<void> {
  await execute(
    `UPDATE vehicle_category SET eStatus = ?
      WHERE iVehicleCategoryId = ? AND ${scopeSql(scope)} LIMIT 1`,
    [status, id],
  );
}

/**
 * The legacy exclusivity switch. Turning one service into the home-screen banner turns
 * every OTHER `vehicle_category` row off (`vehicle_category_action.php:905`), because the
 * apps render exactly one promoted service. The statement deliberately spans the whole
 * table — children and other apps included — so a save here cannot leave the product
 * with two promoted rows, and the return value tells the caller how many were cleared.
 */
export async function clearPromoteBannerEverywhereExcept(id: number): Promise<number> {
  const result = await execute(
    "UPDATE vehicle_category SET ePromoteBanner = 'No' WHERE iVehicleCategoryId <> ? AND ePromoteBanner = 'Yes'",
    [id],
  );
  return Number(result?.affectedRows ?? 0);
}

export interface PromotedRow {
  id: number;
  name: string;
  catType: string;
}

/** Read-only: which other rows currently hold the promotion the toggle would take. */
export async function promotedRowsExcept(id: number): Promise<PromotedRow[]> {
  const rows = await query<{ id: number | string; name: string | null; catType: string }>(
    `SELECT iVehicleCategoryId AS id, vCategory_EN AS name, eCatType AS catType
       FROM vehicle_category
      WHERE iVehicleCategoryId <> ? AND ePromoteBanner = 'Yes' AND eStatus <> 'Deleted'
      ORDER BY iDisplayOrder, iVehicleCategoryId`,
    [id],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: str(r.name).trim(),
    catType: str(r.catType),
  }));
}
