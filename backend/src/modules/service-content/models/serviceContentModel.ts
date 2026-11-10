import { AppError } from "../../../errors/AppError";
import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `content_cjx_details` table (MyISAM). One row per app
 * landing page holds the marketing copy the apps render: `l*Section` columns, each a
 * JSON object keyed `<field>_<LANG>` (`title_EN`, `img_AR`, …), plus three meta columns.
 *
 * The legacy panel keys those rows by `eFor`, and each module owns one value of it: Taxi
 * Service edits `eFor='Ride'` (display group 7 → #sub-12) and Parcel Delivery edits
 * `eFor='Delivery'` (group 32 → #sub-135). The two apps also render different blocks, so
 * a scope carries BOTH the row filter and the editable column list — every statement here
 * is bound to one scope, and no request may mix the two.
 *
 * Rows are seeded by the legacy app and the table has no primary key or auto-increment,
 * so this layer only ever UPDATEs (never inserts or deletes).
 */

export type ContentStatus = "Active" | "Inactive";

/** The eleven editable Taxi Service blocks, in the order the apps render them. */
export const CONTENT_SECTIONS = [
  { key: "Banner", column: "lBannerSection", label: "Banner" },
  { key: "Howitwork", column: "lHowitworkSection", label: "How it works" },
  { key: "Securesafe", column: "lSecuresafeSection", label: "Secure & safe" },
  { key: "Downloadapp", column: "lDownloadappSection", label: "Download app" },
  { key: "Calltobook", column: "lCalltobookSection", label: "Call to book" },
  { key: "Earn", column: "lEarnSection", label: "Earn" },
  { key: "Calculate", column: "lCalculateSection", label: "Fare calculator" },
  { key: "Cartype", column: "lCartypeSection", label: "Car types" },
  { key: "Service", column: "lServiceSection", label: "Service" },
  { key: "Benefit", column: "lBenefitSection", label: "Benefits" },
  { key: "Kiosk", column: "lKioskSection", label: "Kiosk" },
] as const;

export type ContentSectionKey = (typeof CONTENT_SECTIONS)[number]["key"];

/**
 * The blocks the Parcel Delivery landing page renders. This is the section list of the
 * legacy delivery form (`admin368/home_content_delivery_action.php`), not the taxi's: the
 * three ride-only blocks are empty on the delivery row, and copy written into a column no
 * delivery screen reads would be saved, reported as filled, and never shown anywhere.
 */
const DELIVERY_SECTION_KEYS: readonly ContentSectionKey[] = [
  "Banner",
  "Howitwork",
  "Securesafe",
  "Downloadapp",
  "Calltobook",
  "Calculate",
  "Service",
  "Benefit",
];

/** The app types this module serves, named as the URL segment spells them. */
export type ContentAppKey = "ride" | "delivery";

/** One app's row filter plus the blocks its screens actually render. */
export interface ContentAppScope {
  app: ContentAppKey;
  /** Legacy `eFor` value every row of this app is keyed by. */
  eFor: string;
  sections: readonly { key: string; column: string; label: string }[];
  /**
   * Section key → legacy column for THIS app only. Prototype-less so that a payload key
   * like `__proto__` cannot resolve to an inherited value and be interpolated as a column
   * name; the per-app restriction is what stops a delivery save reaching a ride-only
   * column that happens to exist in the same table.
   */
  columns: Record<string, string>;
}

function buildScope(
  app: ContentAppKey,
  eFor: string,
  sections: ContentAppScope["sections"],
): ContentAppScope {
  return {
    app,
    eFor,
    sections,
    columns: Object.assign(
      Object.create(null) as Record<string, string>,
      Object.fromEntries(sections.map((s) => [s.key, s.column])),
    ),
  };
}

export const CONTENT_SCOPES: Record<ContentAppKey, ContentAppScope> = {
  ride: buildScope(
    "ride",
    "Ride",
    CONTENT_SECTIONS,
  ),
  delivery: buildScope(
    "delivery",
    "Delivery",
    CONTENT_SECTIONS.filter((s) => DELIVERY_SECTION_KEYS.includes(s.key)),
  ),
};

export const CONTENT_APP_KEYS = Object.keys(CONTENT_SCOPES) as ContentAppKey[];

/**
 * Scope of a route's `:app` segment. The zod enum normally guarantees the name, so this
 * is the backstop that keeps an unmapped route from silently reading the other app's rows.
 */
export function requireScope(name: unknown): ContentAppScope {
  const key = String(name ?? "");
  if (!CONTENT_APP_KEYS.includes(key as ContentAppKey)) {
    throw AppError.badRequest(`Unknown content app: “${key || "(empty)"}”.`);
  }
  return CONTENT_SCOPES[key as ContentAppKey];
}

/** Column of one section, but only when THIS app renders that section. */
export function sectionColumn(scope: ContentAppScope, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(scope.columns, key) ? scope.columns[key] : undefined;
}

/** Listing shape: no JSON blobs, just what the table shows. */
export interface ContentSummaryRow {
  id: number;
  vehicleCategoryId: number;
  categoryName: string | null;
  status: ContentStatus;
  metaTitle: string;
  sectionsFilled: number;
}

/** Detail shape: raw section JSON texts keyed by section key. */
export interface ContentRow extends Omit<ContentSummaryRow, "sectionsFilled"> {
  eFor: string;
  metaKeyword: string;
  metaDescription: string;
  sections: Record<string, string>;
}

function mapStatus(value: unknown): ContentStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/** `iVehicleCategoryId = 0` is the app-wide default; it sorts first. */
function listSql(scope: ContentAppScope): string {
  return `SELECT c.id, c.iVehicleCategoryId, c.eStatus, c.vMetaTitle,
       vc.vCategory_EN AS categoryName,
       ${scope.sections.map((s) => `CHAR_LENGTH(c.${s.column}) AS len_${s.key}`).join(",\n       ")}
     FROM content_cjx_details c
     LEFT JOIN vehicle_category vc ON vc.iVehicleCategoryId = c.iVehicleCategoryId
     WHERE c.eFor = ?
     ORDER BY c.iVehicleCategoryId = 0 DESC, vc.vCategory_EN, c.id`;
}

/** Statement text depends only on the scope, so build each app's once. */
const LIST_SQL = new Map<string, string>();

/** All rows of one app, default row first then by category name. */
export async function listContentRows(scope: ContentAppScope): Promise<ContentSummaryRow[]> {
  let sql = LIST_SQL.get(scope.app);
  if (!sql) {
    sql = listSql(scope);
    LIST_SQL.set(scope.app, sql);
  }
  const rows = await query<Record<string, string | number | null>>(sql, [scope.eFor]);
  return rows.map((r) => ({
    id: Number(r.id),
    vehicleCategoryId: Number(r.iVehicleCategoryId ?? 0),
    categoryName: r.categoryName == null ? null : String(r.categoryName),
    status: mapStatus(r.eStatus),
    metaTitle: String(r.vMetaTitle ?? ""),
    // An untouched legacy block is either '' or '{}' — neither is content.
    sectionsFilled: scope.sections.filter((s) => Number(r[`len_${s.key}`] ?? 0) > 2).length,
  }));
}

/** One row of one app with every section blob, or null when missing. */
export async function findContentRow(
  scope: ContentAppScope,
  id: number,
): Promise<ContentRow | null> {
  const columns = [
    "c.id",
    "c.eFor",
    "c.iVehicleCategoryId",
    "c.eStatus",
    "c.vMetaTitle",
    "c.tMetaKeyword",
    "c.tMetaDescription",
    ...scope.sections.map((s) => `c.${s.column}`),
  ].join(", ");
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${columns}, vc.vCategory_EN AS categoryName
       FROM content_cjx_details c
       LEFT JOIN vehicle_category vc ON vc.iVehicleCategoryId = c.iVehicleCategoryId
      WHERE c.id = ? AND c.eFor = ?
      LIMIT 1`,
    [id, scope.eFor],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const sections: Record<string, string> = {};
  for (const s of scope.sections) sections[s.key] = String(r[s.column] ?? "");
  return {
    id: Number(r.id),
    eFor: String(r.eFor ?? ""),
    vehicleCategoryId: Number(r.iVehicleCategoryId ?? 0),
    categoryName: r.categoryName == null ? null : String(r.categoryName),
    status: mapStatus(r.eStatus),
    metaTitle: String(r.vMetaTitle ?? ""),
    metaKeyword: String(r.tMetaKeyword ?? ""),
    metaDescription: String(r.tMetaDescription ?? ""),
    sections,
  };
}

export async function updateMeta(
  scope: ContentAppScope,
  id: number,
  meta: { title: string; keyword: string; description: string },
): Promise<void> {
  await execute(
    `UPDATE content_cjx_details SET vMetaTitle = ?, tMetaKeyword = ?, tMetaDescription = ?
      WHERE id = ? AND eFor = ? LIMIT 1`,
    [meta.title, meta.keyword, meta.description, id, scope.eFor],
  );
}

/**
 * Write section columns of the same row in ONE UPDATE (the old path
 * issued one round trip per changed section). `column` is interpolated into the
 * statement because column names cannot be bound, so it is re-checked against the
 * scope here rather than trusting the caller to have filtered it.
 */
export async function updateSections(
  scope: ContentAppScope,
  id: number,
  parts: { column: string; raw: string }[],
): Promise<void> {
  if (!parts.length) return;
  for (const p of parts) {
    if (!Object.values(scope.columns).includes(p.column)) {
      throw AppError.badRequest(`Column “${p.column}” is not editable for this app.`);
    }
  }
  await execute(
    `UPDATE content_cjx_details SET ${parts.map((p) => `${p.column} = ?`).join(", ")}
     WHERE id = ? AND eFor = ? LIMIT 1`,
    [...parts.map((p) => p.raw), id, scope.eFor],
  );
}

export async function setContentStatus(
  scope: ContentAppScope,
  id: number,
  status: ContentStatus,
): Promise<void> {
  await execute(
    "UPDATE content_cjx_details SET eStatus = ? WHERE id = ? AND eFor = ? LIMIT 1",
    [status, id, scope.eFor],
  );
}
