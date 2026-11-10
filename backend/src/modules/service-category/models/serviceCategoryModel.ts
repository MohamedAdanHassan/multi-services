import { execute, getConnection, query } from "../../../db/mysql";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { AppError } from "../../../errors/AppError";
import type { ContentFieldKind } from "../../../utils/contentSanitizer";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `vehicle_category` table (MyISAM, Taxi Service →
 * Manage Service Category, #sub-13). One row per service category carries the
 * name, artwork and pricing/behaviour settings the apps use to list and open
 * that service.
 *
 * Only `eFor='RideCategory'` rows are exposed: `eFor` is the scope column that
 * ties a category to the service line owning it, and display group 7 (Taxi
 * Service, `eFor='Ride'`) is seeded with `view/update/update-status-service-
 * category-taxi-service` for exactly those rows — the delivery groups own the
 * `DeliveryCategory` / `DeliverAllCategory` siblings.
 *
 * The table has no primary key and no auto-increment column, so edits UPDATE by
 * `iVehicleCategoryId` inside the Ride scope and new rows take `MAX(+1)` (there is
 * still no delete path — soft-deleted rows stay hidden). Every edit is a single
 * statement so a save cannot half-apply on a storage engine without transactions;
 * the one INSERT (`createCategory`) runs on a relaxed-mode connection because the
 * table's many NOT NULL / out-of-enum columns have no valid strict-mode default.
 */

export type CategoryStatus = "Active" | "Inactive";

/** Row scope of this screen: live Ride categories (soft-deleted rows stay hidden). */
const SCOPE = "eFor = 'RideCategory' AND eStatus <> 'Deleted'";

/** Languages the legacy table pre-allocates a column for. */
export const CATEGORY_LANGUAGES = TRANSLATION_LANGUAGES;

/**
 * Per-language scalar columns, grouped into the three families the apps read.
 * The column name is `<column>_<LANG>`, and the language part is always taken
 * from `CATEGORY_LANGUAGES` — never from the payload.
 */
export interface TextFamilySpec {
  key: string;
  column: string;
  label: string;
  /** How the apps render this family, i.e. which sanitizer rules apply. */
  kind: ContentFieldKind;
  max: number;
  multiline: boolean;
}

export const TEXT_FAMILIES: readonly TextFamilySpec[] = [
  { key: "name", column: "vCategory", label: "Category name", kind: "text", max: 200, multiline: false },
  { key: "title", column: "vCategoryTitle", label: "Title", kind: "text", max: 255, multiline: false },
  { key: "description", column: "tCategoryDesc", label: "Description", kind: "html", max: 5_000, multiline: true },
];

/** Artwork columns: a bare file name the apps concatenate into an image URL. */
export interface MediaColumnSpec {
  column: string;
  label: string;
}

export const MEDIA_COLUMNS: readonly MediaColumnSpec[] = [
  { column: "vLogo", label: "Logo" },
  { column: "vLogo1", label: "Logo 1" },
  { column: "vLogo2", label: "Logo 2" },
  { column: "vHomepageLogo", label: "Homepage logo" },
  { column: "vHomepageFullLogo", label: "Homepage full logo" },
  { column: "vHomepageLogoOurServices", label: "“Our services” logo" },
  { column: "vBannerImage", label: "Banner image" },
  { column: "vHomepageBanner", label: "Homepage banner" },
  { column: "vServiceHomepageBanner", label: "Homepage service banner" },
  { column: "vListLogo", label: "List logo" },
  { column: "vListLogo1", label: "List logo 1" },
  { column: "vListLogo2", label: "List logo 2" },
  { column: "vListLogo3", label: "List logo 3" },
  { column: "vPromoteBannerImage", label: "Promote banner image" },
];

/**
 * Columns stored as a flat JSON object of `<base>_<LANG>` keys (the homepage
 * tile and promote-banner copy). They are merged key by key, like the #sub-12
 * section blobs.
 */
export interface BlobColumnSpec {
  key: string;
  label: string;
}

export const BLOB_COLUMNS: readonly BlobColumnSpec[] = [
  { key: "tListDescription", label: "List description" },
  { key: "tBannerButtonText", label: "Banner button text" },
  { key: "vCatNameHomepage", label: "Homepage name" },
  { key: "vCatTitleHomepage", label: "Homepage title" },
  { key: "vCatDescbtnHomepage", label: "Homepage button description" },
  { key: "vCatSloganHomepage", label: "Homepage slogan" },
  { key: "lCatDescHomepage", label: "Homepage description" },
  { key: "tPromoteBannerTitle", label: "Promote banner title" },
  { key: "vServiceCatTitleHomepage", label: "Homepage service category title" },
];

/** Settings columns: the enum lists mirror the legacy DDL, plus the values the rows really hold. */
export type SettingSpec =
  | { column: string; label: string; kind: "enum"; values: readonly string[]; note?: string }
  | { column: string; label: string; kind: "int"; min: number; max: number; note?: string }
  | { column: string; label: string; kind: "float"; min: number; max: number; note?: string };

export const SETTINGS: readonly SettingSpec[] = [
  { column: "eShowType", label: "Show as", kind: "enum", values: ["Icon", "Banner", "Icon-Banner"] },
  {
    column: "eDetailPageView",
    label: "Detail page view",
    kind: "enum",
    values: ["", "Icon", "Banner"],
    note: "Empty follows the app default.",
  },
  { column: "ePriceType", label: "Price basis", kind: "enum", values: ["Service", "Provider"] },
  {
    column: "eBeforeUpload",
    label: "Proof upload before service",
    kind: "enum",
    // The DDL says Yes/No, but every live Ride row stores '' — an out-of-enum
    // value the legacy app wrote in non-strict mode. Accepting '' keeps a save of
    // an untouched row from failing on the value it already has.
    values: ["", "Yes", "No"],
  },
  { column: "eAfterUpload", label: "Proof upload after service", kind: "enum", values: ["", "Yes", "No"] },
  { column: "eOTPCodeEnable", label: "OTP code", kind: "enum", values: ["No", "Yes"] },
  { column: "ePromoteBanner", label: "Promote banner", kind: "enum", values: ["No", "Yes"] },
  { column: "eMaterialCommision", label: "Material commission", kind: "enum", values: ["Yes", "No"] },
  { column: "fCommision", label: "Commission", kind: "float", min: 0, max: 100, note: "percent" },
  { column: "fWaitingFees", label: "Waiting fees", kind: "float", min: 0, max: 99_999 },
  { column: "iWaitingFeeTimeLimit", label: "Waiting fee starts after", kind: "int", min: 0, max: 9_999, note: "minutes" },
  { column: "fCancellationFare", label: "Cancellation fare", kind: "float", min: 0, max: 99_999 },
  { column: "iCancellationTimeLimit", label: "Cancellation charge window", kind: "int", min: 0, max: 9_999, note: "minutes" },
  { column: "iDisplayOrder", label: "Display order", kind: "int", min: 0, max: 9_999 },
  { column: "iDisplayOrderHomepage", label: "Homepage display order", kind: "int", min: 0, max: 9_999 },
];

/** `column` → spec, prototype-less so `__proto__` cannot resolve to anything. */
export const SETTINGS_BY_COLUMN: Record<string, SettingSpec> = Object.assign(
  Object.create(null) as Record<string, SettingSpec>,
  Object.fromEntries(SETTINGS.map((s) => [s.column, s])),
);

/** Columns owned by the text families, in `<column>_<LANG>` form. */
export const TEXT_COLUMN_NAMES: readonly string[] = TEXT_FAMILIES.flatMap((f) =>
  CATEGORY_LANGUAGES.map((l) => `${f.column}_${l.code}`),
);

/**
 * Every column this screen may write. The UPDATE statements interpolate column
 * names, so membership is re-checked here even though the service resolves names
 * out of the whitelists above: an interpolated name must be one of ours.
 */
export const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  Object.fromEntries(
    [
      ...TEXT_COLUMN_NAMES,
      ...MEDIA_COLUMNS.map((m) => m.column),
      ...BLOB_COLUMNS.map((b) => b.key),
      ...SETTINGS.map((s) => s.column),
    ].map((column) => [column, true as const]),
  ),
);

/** Listing shape: no blobs, just what the table shows. */
export interface CategorySummaryRow {
  id: number;
  name: string;
  catType: string;
  subCatType: string;
  status: CategoryStatus;
  showType: string;
  logo: string;
  displayOrder: number;
  displayOrderHomepage: number;
  commission: number;
  /** How many of the 26 `vCategory_*` columns carry a name. */
  namesFilled: number;
}

/** Detail shape: every editable column plus the read-only scope columns. */
export interface CategoryRow {
  id: number;
  eFor: string;
  catType: string;
  subCatType: string;
  status: CategoryStatus;
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

function mapStatus(value: unknown): CategoryStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

const LIST_SQL = `SELECT iVehicleCategoryId AS id, eCatType, eSubCatType, eStatus, eShowType,
         vCategory_EN AS name, vLogo AS logo, iDisplayOrder, iDisplayOrderHomepage, fCommision,
         ${CATEGORY_LANGUAGES.map((l) => `CHAR_LENGTH(vCategory_${l.code}) AS name_${l.code}`).join(",\n         ")}
       FROM vehicle_category
       WHERE ${SCOPE}
       ORDER BY iDisplayOrder, iVehicleCategoryId`;

/** SELECT list of one category: scope columns first, then every writable column. */
const DETAIL_SELECT = [
  "iVehicleCategoryId AS id",
  "eFor",
  "eCatType",
  "eSubCatType",
  "eStatus",
  ...TEXT_COLUMN_NAMES,
  ...MEDIA_COLUMNS.map((m) => m.column),
  ...BLOB_COLUMNS.map((b) => b.key),
  ...SETTINGS.map((s) => s.column),
].join(", ");

/** All live Ride categories, in the order the apps list them. */
export async function listCategoryRows(): Promise<CategorySummaryRow[]> {
  const rows = await query<Record<string, string | number | null>>(LIST_SQL);
  return rows.map((r) => ({
    id: num(r.id),
    name: str(r.name).trim(),
    catType: str(r.eCatType),
    subCatType: str(r.eSubCatType),
    status: mapStatus(r.eStatus),
    showType: str(r.eShowType),
    logo: str(r.logo).trim(),
    displayOrder: num(r.iDisplayOrder),
    displayOrderHomepage: num(r.iDisplayOrderHomepage),
    commission: num(r.fCommision),
    namesFilled: CATEGORY_LANGUAGES.filter((l) => num(r[`name_${l.code}`]) > 0).length,
  }));
}

/** One live Ride category with every editable column, or null when out of scope. */
export async function findCategoryRow(id: number): Promise<CategoryRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${DETAIL_SELECT} FROM vehicle_category WHERE iVehicleCategoryId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const values = Object.create(null) as Record<string, string | number | null>;
  for (const column of [...TEXT_COLUMN_NAMES, ...MEDIA_COLUMNS.map((m) => m.column), ...BLOB_COLUMNS.map((b) => b.key), ...SETTINGS.map((s) => s.column)]) {
    values[column] = r[column] ?? null;
  }
  return {
    id: num(r.id),
    eFor: str(r.eFor),
    catType: str(r.eCatType),
    subCatType: str(r.eSubCatType),
    status: mapStatus(r.eStatus),
    values,
  };
}

/**
 * Write several columns of one category in a single statement. `sets[].column`
 * is interpolated (column names cannot be bound), so it must pass the
 * `EDITABLE_COLUMNS` whitelist — anything else is refused before SQL is built.
 */
export async function updateCategoryColumns(
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
      WHERE iVehicleCategoryId = ? AND ${SCOPE} LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

export async function setCategoryStatus(id: number, status: CategoryStatus): Promise<void> {
  await execute(
    `UPDATE vehicle_category SET eStatus = ? WHERE iVehicleCategoryId = ? AND ${SCOPE} LIMIT 1`,
    [status, id],
  );
}

/** Minimal identity a new Ride category needs; everything else takes the legacy empty default. */
export interface NewCategoryInput {
  status: CategoryStatus;
  name: string;
}

/** `vehicle_category` has no auto-increment, so new ids go MAX(+1) over the whole table. */
async function nextCategoryId(conn: PoolConnection): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT MAX(iVehicleCategoryId) AS max FROM vehicle_category",
  );
  return (Number(rows[0]?.max) || 0) + 1;
}

/**
 * Insert a new Ride category. The table is MyISAM with no auto-increment and
 * ~40 NOT NULL columns, several of which are enums the legacy app fills with an
 * out-of-enum `''` (eBeforeUpload, eDeliveryType, eDetailPageView, …). Under the
 * pool's STRICT_TRANS_TABLES an INSERT that omits those errors and one that binds
 * `''` to them is rejected as truncated data, so the write runs on a dedicated
 * connection with the session sql_mode relaxed (the same approach the drivers,
 * promos and users modules use for legacy full-column writes). Only the identity
 * columns are listed; MySQL supplies each omitted column's implicit empty default,
 * exactly as the legacy "Add New Taxi Service" screen relied on. The connection's
 * own mode is captured and restored before it returns to the shared pool.
 */
export async function createCategory(input: NewCategoryInput): Promise<number> {
  const conn = await getConnection();
  let previous: string | null = null;
  try {
    const [modeRows] = await conn.query<RowDataPacket[]>("SELECT @@SESSION.sql_mode AS m");
    // An empty mode is a legitimate value here, so only a missing/unreadable
    // column counts as "nothing to restore".
    const raw = (modeRows[0] as { m: string | null } | undefined)?.m;
    previous = typeof raw === "string" ? raw : null;
    await conn.query("SET SESSION sql_mode = ''");

    const id = await nextCategoryId(conn);
    await conn.query(
      `INSERT INTO vehicle_category
         (iVehicleCategoryId, eFor, eCatType, eStatus, vCategory_EN)
       VALUES (?, 'RideCategory', 'Ride', ?, ?)`,
      [id, input.status, input.name],
    );
    return id;
  } finally {
    if (previous !== null) {
      try {
        await conn.query("SET SESSION sql_mode = ?", [previous]);
      } catch {
        /* a connection that cannot be restored is released anyway */
      }
    }
    conn.release();
  }
}
