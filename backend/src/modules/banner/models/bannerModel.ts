import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `banners` table, which several apps share: Parcel Delivery
 * → Banners (#sub-140) owns the `eType='Deliver'` rows, Delivery Genie → Banners
 * (#sub-142) the `eType='Genie'` ones and Delivery Runner → Banners (#sub-143) the
 * `eType='Runner'` ones. Which slice a call reads or rewrites is decided by the `:app`
 * segment and resolved to a `BannerAppScope` here, so one statement can never reach
 * another app's rows.
 *
 * This table is shaped unlike every other catalog rewritten so far: **one banner is a
 * group of rows, not one row.** `iUniqueId` names the banner and `vCode` holds the
 * language of each row inside it, so the shipped data has 26 rows per banner — "Parcel
 * Delivery", "Pengiriman paket", "Paketzustellung"… — all pointing at the same
 * `vImage`. The app picks the row matching the user's language, which is why the title
 * is per-row while the picture, the display order and the status-bar colour are
 * duplicated on every row of the group.
 *
 * So a screen over this table has to work in groups: the list aggregates by
 * `iUniqueId`, a save fans out over the language rows it touches, and a delete removes
 * the whole group. Two further quirks:
 *
 * - the id column is `iFaqcategoryId` (the table was cloned from a FAQ catalog and kept
 *   its name), the engine is MyISAM with no key, no index and no auto-increment, so
 *   both ids come from `MAX(...)+1` — `iUniqueId` globally, because one group id is
 *   already shared by two different apps' rows;
 * - `eStatus` is `enum('Active','Inactive')` with no `Deleted`, so a delete is a real
 *   DELETE. Nothing else in the database names a banner (`advertise_banners`,
 *   `hotel_banners` and `store_wise_banners` all keep their own tables and ids), so no
 *   usage guard is needed — but the blank `vTitle` on a third of the shipped rows shows
 *   an untranslated language is normal, not broken.
 *
 * `eType` is the app slice, and every statement here is bounded by it. `eFor`,
 * `iServiceId`, `eBuyAnyService`, `iLocationid` and the two category ids are carried
 * along unchanged — they are what the row already says, and a new language row copies
 * them from its own group.
 */

export type BannerStatus = "Active" | "Inactive";

/**
 * The apps whose banner slice this screen serves, in one tuple: the route's `:app`
 * enum and the RBAC key map both derive from it, so an app cannot be added to one
 * and forgotten in the other.
 */
export const BANNER_APPS = ["delivery", "genie", "runner"] as const;
export type BannerApp = (typeof BANNER_APPS)[number];

/** One app's slice of the shared table. */
export interface BannerAppScope {
  app: BannerApp;
  /** The `eType` value that names this app's rows. */
  eType: string;
  /** Module name, for error text. */
  label: string;
}

/**
 * The slices, keyed by the URL segment. Each is the literal the legacy page filters
 * on: `banner.php?eType=Genie` reads `AND eType = 'Genie'` and
 * `banner.php?eType=Runner` reads `AND eType = 'Runner'`, the same file picking its
 * permission family (`banner-genie-delivery` / `banner-runner-delivery`) off that same
 * parameter. Note that the shipped Genie and Runner rows both carry
 * `eBuyAnyService=''`, so that column is not the slice here even though the legacy
 * action page sometimes filters on it.
 */
export const BANNER_APP_SCOPES: Record<BannerApp, BannerAppScope> = {
  delivery: { app: "delivery", eType: "Deliver", label: "Parcel Delivery" },
  genie: { app: "genie", eType: "Genie", label: "Delivery Genie" },
  runner: { app: "runner", eType: "Runner", label: "Delivery Runner" },
};

/** Resolve the `:app` segment, refusing a segment that names no slice. */
export function requireBannerApp(raw: unknown): BannerAppScope {
  const scope = BANNER_APP_SCOPES[String(raw) as BannerApp];
  if (!scope) {
    throw AppError.badRequest(`Unknown banner app “${String(raw)}”.`);
  }
  return scope;
}

/** `iLocationid` value meaning "shown everywhere", which is every shipped row. */
export const ALL_LOCATIONS = "-1";

/** Languages the legacy table can hold a row for. */
export const BANNER_LANGUAGES = TRANSLATION_LANGUAGES;
/** Language a banner must have a row for even when nothing else is translated. */
export const PRIMARY_LANGUAGE = "EN";
/** Every language code, in the order the editor lists them. */
export const BANNER_LANGUAGE_CODES: readonly string[] = BANNER_LANGUAGES.map((l) => l.code);

/** One language row of a banner, as the detail view reads it. */
export interface BannerLanguageRow {
  /** `iFaqcategoryId` of this row. */
  rowId: number;
  code: string;
  title: string;
  status: BannerStatus;
}

/** The values every row of a group shares; a new language row copies them. */
export interface BannerGroupTemplate {
  image: string;
  displayOrder: number;
  statusBarColor: string;
  locationIds: string;
  serviceId: number;
  buyAnyService: string;
  forApp: string;
  vehicleCategoryId: number;
  masterServiceCategoryId: number;
}

/** A whole banner: the group's shared values plus one entry per language row. */
export interface BannerGroup {
  /** `iUniqueId`. */
  id: number;
  template: BannerGroupTemplate;
  rows: BannerLanguageRow[];
}

/** Aggregated group row of the listing. */
export interface BannerGroupSummary {
  id: number;
  /** Raw row count — it exceeds the language count where legacy duplicates exist. */
  rowCount: number;
  /** Distinct language codes present in the group. */
  languageCount: number;
  /** Distinct languages whose title is not blank. */
  filledCount: number;
  /** Distinct languages stored Inactive. */
  inactiveCount: number;
  displayOrder: number;
  statusBarColor: string;
  image: string;
}

/** The display label of a group, resolved from its language rows. */
export interface BannerLabel {
  groupId: number;
  code: string;
  title: string;
  rowId: number;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): BannerStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/** Aggregates one group per row. Counted by *language*, not by row, because the
 * shipped data holds a group with two rows per language. */
const GROUP_AGGREGATES = `b.iUniqueId AS id,
         COUNT(*) AS row_count,
         COUNT(DISTINCT b.vCode) AS language_count,
         COUNT(DISTINCT IF(b.vTitle <> '', b.vCode, NULL)) AS filled_count,
         COUNT(DISTINCT IF(b.eStatus = 'Inactive', b.vCode, NULL)) AS inactive_count,
         MAX(b.iDisplayOrder) AS display_order,
         MAX(b.vStatusBarColor) AS color,
         MAX(b.vImage) AS image`;

/**
 * The filters of the listing, as a HAVING clause. Search and status are group
 * properties ("does any language of this banner say X?", "is the banner off?"), so
 * they cannot go in WHERE — that would drop the sibling rows the aggregate needs.
 */
function havingParts(filters: { search: string; status?: BannerStatus }): {
  sql: string;
  params: unknown[];
} {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  if (filters.search) {
    parts.push("COUNT(DISTINCT IF(b.vTitle LIKE ?, b.vCode, NULL)) > 0");
    params.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (filters.status === "Active") parts.push("COUNT(DISTINCT IF(b.eStatus = 'Inactive', b.vCode, NULL)) = 0");
  if (filters.status === "Inactive") parts.push("COUNT(DISTINCT IF(b.eStatus = 'Inactive', b.vCode, NULL)) > 0");
  return { sql: parts.join(" AND "), params };
}

function mapGroupSummary(r: Record<string, unknown>): BannerGroupSummary {
  return {
    id: num(r.id),
    rowCount: num(r.row_count),
    languageCount: num(r.language_count),
    filledCount: num(r.filled_count),
    inactiveCount: num(r.inactive_count),
    displayOrder: num(r.display_order),
    statusBarColor: str(r.color).trim(),
    image: str(r.image).trim(),
  };
}

/** Groups are ordered the way the app lays them out: slot first, then age. */
const GROUP_ORDER = "ORDER BY display_order, MIN(b.iFaqcategoryId)";

/** One filtered page of banner groups. */
export async function listGroupPage(
  scope: BannerAppScope,
  filters: {
    search: string;
    status?: BannerStatus;
    limit: number;
    offset: number;
  },
): Promise<BannerGroupSummary[]> {
  const having = havingParts(filters);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${GROUP_AGGREGATES} FROM banners b
      WHERE b.eType = ?
      GROUP BY b.iUniqueId
      HAVING ${having.sql}
      ${GROUP_ORDER}
      LIMIT ? OFFSET ?`,
    [scope.eType, ...having.params, filters.limit, filters.offset],
  );
  return rows.map(mapGroupSummary);
}

/** How many banner groups match the same filters. */
export async function countGroups(
  scope: BannerAppScope,
  filters: { search: string; status?: BannerStatus },
): Promise<number> {
  const having = havingParts(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT b.iUniqueId FROM banners b WHERE b.eType = ? GROUP BY b.iUniqueId HAVING ${having.sql}
     ) AS g`,
    [scope.eType, ...having.params],
  );
  return num(rows[0]?.n);
}

/**
 * The titles of the listed groups, so the caller can label each one by its English
 * row — or, where a group has none (the shipped Runner banner has Latvian and
 * Slovenian only), by the first language that says anything.
 */
export async function labelsForGroups(
  scope: BannerAppScope,
  ids: number[],
): Promise<BannerLabel[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await query<Record<string, unknown>>(
    `SELECT b.iUniqueId AS group_id, b.iFaqcategoryId AS row_id, b.vCode AS code, b.vTitle AS title
       FROM banners b
      WHERE b.eType = ? AND b.iUniqueId IN (${placeholders})
      ORDER BY b.iUniqueId, b.iFaqcategoryId`,
    [scope.eType, ...ids],
  );
  return rows.map((r) => ({
    groupId: num(r.group_id),
    rowId: num(r.row_id),
    code: str(r.code).trim(),
    title: str(r.title).trim(),
  }));
}

/** Every column a group's rows share, read off the first row. */
const GROUP_COLUMNS = `b.iUniqueId AS id, b.vImage AS image, b.iDisplayOrder AS display_order,
  b.vStatusBarColor AS color, b.iLocationid AS location_ids, b.iServiceId AS service_id,
  b.eBuyAnyService AS buy_any, b.eFor AS for_app, b.iVehicleCategoryId AS vehicle_category_id,
  b.iMasterServiceCategoryId AS master_service_category_id`;

/** One banner with all of its language rows, or null when the id is not in this slice. */
export async function findGroup(scope: BannerAppScope, id: number): Promise<BannerGroup | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${GROUP_COLUMNS}, b.iFaqcategoryId AS row_id, b.vCode AS code, b.vTitle AS title,
            b.eStatus AS row_status
       FROM banners b
      WHERE b.eType = ? AND b.iUniqueId = ?
      ORDER BY b.iFaqcategoryId`,
    [scope.eType, id],
  );
  if (!rows.length) return null;
  const first = rows[0];
  return {
    id: num(first.id),
    template: {
      image: str(first.image).trim(),
      displayOrder: num(first.display_order),
      statusBarColor: str(first.color).trim(),
      locationIds: str(first.location_ids).trim() || ALL_LOCATIONS,
      serviceId: num(first.service_id),
      buyAnyService: str(first.buy_any).trim(),
      forApp: str(first.for_app).trim() || "General",
      vehicleCategoryId: num(first.vehicle_category_id),
      masterServiceCategoryId: num(first.master_service_category_id),
    },
    rows: rows.map((r) => ({
      rowId: num(r.row_id),
      code: str(r.code).trim(),
      title: str(r.title),
      status: mapStatus(r.row_status),
    })),
  };
}

/**
 * `iUniqueId` is allocated across the whole table, not per app: the shipped data
 * already has one group id serving two apps' rows, and reusing an id another slice
 * holds would quietly merge them.
 */
export async function nextGroupId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iUniqueId), 0) + 1 AS nid FROM banners",
  );
  return num(rows[0]?.nid);
}

/**
 * Row ids come in a run, because a banner is inserted as 26 rows in one statement and
 * the table has no auto-increment to consult between them. MyISAM offers no
 * transaction to make the read-and-allocate atomic, so two simultaneous creates could
 * still collide; the admin panel is not a high-concurrency writer, and a collision
 * fails loudly on the id rather than corrupting a group.
 */
export async function nextRowIds(count: number): Promise<number[]> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iFaqcategoryId), 0) + 1 AS nid FROM banners",
  );
  const start = num(rows[0]?.nid);
  return Array.from({ length: count }, (_unused, i) => start + i);
}

/** The slot a new banner would need to take to appear last. */
export async function nextDisplayOrder(scope: BannerAppScope): Promise<number> {
  const rows = await query<{ n: number | null }>(
    "SELECT COALESCE(MAX(iDisplayOrder), 0) + 1 AS n FROM banners WHERE eType = ?",
    [scope.eType],
  );
  return num(rows[0]?.n);
}

/** One language row of a new banner, with the group's shared values copied in. */
export interface NewBannerRow {
  rowId: number;
  code: string;
  title: string;
  status: BannerStatus;
}

/** Every NOT NULL column is named: MyISAM under STRICT_TRANS_TABLES fills nothing in. */
const INSERT_COLUMNS = `iFaqcategoryId, iServiceId, eStatus, iDisplayOrder, vTitle, vImage, vCode,
  eBuyAnyService, iUniqueId, iLocationid, vStatusBarColor, eType, eFor, iVehicleCategoryId,
  iMasterServiceCategoryId`;

/** Insert a whole banner in one statement: 26 rows sharing the group's values. */
export async function insertBanner(
  scope: BannerAppScope,
  groupId: number,
  rows: NewBannerRow[],
  template: BannerGroupTemplate,
): Promise<void> {
  if (!rows.length) return;
  const tuple = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values: (string | number)[] = [];
  for (const r of rows) {
    values.push(
      r.rowId,
      template.serviceId,
      r.status,
      template.displayOrder,
      r.title,
      template.image,
      r.code,
      template.buyAnyService,
      groupId,
      template.locationIds,
      template.statusBarColor,
      scope.eType,
      template.forApp,
      template.vehicleCategoryId,
      template.masterServiceCategoryId,
    );
  }
  await execute(
    `INSERT INTO banners (${INSERT_COLUMNS}) VALUES ${rows.map(() => tuple).join(", ")}`,
    values,
  );
}

/**
 * Write one language's title. This touches every row of the group carrying that code —
 * the shipped AppHomeScreen group has two per language, and leaving one stale would
 * show the old title to some users.
 */
export async function updateTitle(
  scope: BannerAppScope,
  groupId: number,
  code: string,
  title: string,
): Promise<void> {
  await execute("UPDATE banners SET vTitle = ? WHERE eType = ? AND iUniqueId = ? AND vCode = ?", [
    title,
    scope.eType,
    groupId,
    code,
  ]);
}

/** Group-level edits: the slot and the colour are the same on every row by design. */
export async function updateGroupFields(
  scope: BannerAppScope,
  groupId: number,
  sets: { displayOrder?: number; statusBarColor?: string },
): Promise<void> {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (sets.displayOrder !== undefined) {
    parts.push("iDisplayOrder = ?");
    params.push(sets.displayOrder);
  }
  if (sets.statusBarColor !== undefined) {
    parts.push("vStatusBarColor = ?");
    params.push(sets.statusBarColor);
  }
  if (!parts.length) return;
  params.push(scope.eType, groupId);
  await execute(`UPDATE banners SET ${parts.join(", ")} WHERE eType = ? AND iUniqueId = ?`, params);
}

/** The picture is shared by the group, so a replace writes all of its rows. */
export async function updateImage(
  scope: BannerAppScope,
  groupId: number,
  filename: string,
): Promise<void> {
  await execute("UPDATE banners SET vImage = ? WHERE eType = ? AND iUniqueId = ?", [
    filename,
    scope.eType,
    groupId,
  ]);
}

/** Status is group-wide: half a banner showing in some languages is not a state. */
export async function setGroupStatus(
  scope: BannerAppScope,
  groupId: number,
  status: BannerStatus,
): Promise<void> {
  await execute("UPDATE banners SET eStatus = ? WHERE eType = ? AND iUniqueId = ?", [
    status,
    scope.eType,
    groupId,
  ]);
}

/** Add one missing language to an existing banner, copying its group's values. */
export async function insertLanguageRow(
  scope: BannerAppScope,
  groupId: number,
  row: NewBannerRow,
  template: BannerGroupTemplate,
): Promise<void> {
  await insertBanner(scope, groupId, [row], template);
}

/** Hard delete of the whole group — `eStatus` has no 'Deleted' member to hide into. */
export async function deleteGroup(scope: BannerAppScope, groupId: number): Promise<number> {
  const result = await execute("DELETE FROM banners WHERE eType = ? AND iUniqueId = ?", [
    scope.eType,
    groupId,
  ]);
  return result.affectedRows;
}

/**
 * Rows outside this group that still name the picture. The legacy data reuses one
 * image across several groups, so a file is only ever removed when nothing else
 * refers to it.
 */
export async function countImageRefsOutsideGroup(
  scope: BannerAppScope,
  image: string,
  groupId: number,
): Promise<number> {
  const rows = await query<{ n: number | null }>(
    "SELECT COUNT(*) AS n FROM banners WHERE vImage = ? AND NOT (eType = ? AND iUniqueId = ?)",
    [image, scope.eType, groupId],
  );
  return num(rows[0]?.n);
}

/** Rows anywhere that name the picture, read before a replace drops the old value. */
export async function countImageRefs(image: string): Promise<number> {
  const rows = await query<{ n: number | null }>(
    "SELECT COUNT(*) AS n FROM banners WHERE vImage = ?",
    [image],
  );
  return num(rows[0]?.n);
}
