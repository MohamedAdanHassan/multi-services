import { AppError } from "../../../errors/AppError";
import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `master_service_category_pro` table. One row per app type
 * holds the master category the app's home screen is built from: `vCategoryName` is a
 * JSON object keyed `vCategoryName_<CODE>` for every installed language, `vIconImage1`
 * a bare file name, and `eStatus` the switch under it.
 *
 * The table is keyed by `eType` — `Deliver` is Parcel Delivery (display group 32 →
 * #sub-136), the twin of the taxi's `Ride` row — and has neither a primary key nor
 * auto-increment, so this layer only ever UPDATEs an existing row: never inserts,
 * never deletes, never reads another app's row.
 *
 * The scope map holds one app today. It is shaped like `CONTENT_SCOPES` in the
 * neighbouring service-content module so that the other master rows (`DeliverAll`,
 * `UberX`, …) become an entry plus three permission names, not a rewrite.
 */

export type MasterCategoryStatus = "Active" | "Inactive";

/** The app types this module serves, named as the URL segment spells them. */
export type MasterCategoryAppKey = "delivery";

/** One app's row filter, plus the name the legacy panel gives that screen. */
export interface MasterCategoryScope {
  app: MasterCategoryAppKey;
  /** Legacy `eType` value the row of this app is keyed by. */
  eType: string;
  /** Module name; the legacy page titles itself "Edit Parcel Delivery" from it. */
  label: string;
}

export const MASTER_CATEGORY_SCOPES: Record<MasterCategoryAppKey, MasterCategoryScope> = {
  delivery: { app: "delivery", eType: "Deliver", label: "Parcel Delivery" },
};

export const MASTER_CATEGORY_APP_KEYS = Object.keys(
  MASTER_CATEGORY_SCOPES,
) as MasterCategoryAppKey[];

/**
 * Scope of a route's `:app` segment: the backstop that keeps an unmapped path from
 * silently reading a different app's master row.
 */
export function requireScope(name: unknown): MasterCategoryScope {
  const key = String(name ?? "");
  if (!MASTER_CATEGORY_APP_KEYS.includes(key as MasterCategoryAppKey)) {
    throw AppError.badRequest(`Unknown master category app: “${key || "(empty)"}”.`);
  }
  return MASTER_CATEGORY_SCOPES[key as MasterCategoryAppKey];
}

/**
 * The icon the pasted legacy form writes. Its file input is named `vImage1`, and
 * `master_service_category_action_pro.php` stores the upload in `vIconImage1` — the
 * neighbouring `vIconImage` column is an older field this form never touches, so
 * editing one must not move the other.
 */
export const ICON_COLUMN = "vIconImage1";

/** Column holding the `<CODE>`-keyed JSON name map. */
export const NAME_COLUMN = "vCategoryName";

const SELECT_ROW =
  `SELECT iMasterServiceCategoryId AS id, eType, eStatus, ${NAME_COLUMN}, ${ICON_COLUMN} ` +
  "FROM master_service_category_pro";

/** Live rows of one app. There is one per `eType` today; the list keeps it honest. */
export async function listCategoryRows(scope: MasterCategoryScope): Promise<MasterCategoryRow[]> {
  const rows = await query<RawRow>(
    `${SELECT_ROW} WHERE eType = ? AND eStatus <> 'Deleted' ORDER BY iMasterServiceCategoryId`,
    [scope.eType],
  );
  return rows.map(toRow);
}

/** One live row of this app, or null when the id belongs to another app type. */
export async function findCategoryRow(
  scope: MasterCategoryScope,
  id: number,
): Promise<MasterCategoryRow | null> {
  const rows = await query<RawRow>(
    `${SELECT_ROW} WHERE iMasterServiceCategoryId = ? AND eType = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id, scope.eType],
  );
  return rows.length ? toRow(rows[0]) : null;
}

export interface MasterCategoryRow {
  id: number;
  eType: string;
  status: MasterCategoryStatus;
  /** Raw JSON blob of `vCategoryName_<CODE>` keys, exactly as stored. */
  nameBlob: string;
  /** Stored file name, empty when the row holds none. */
  icon: string;
}

interface RawRow {
  id: number | string;
  eType: string;
  eStatus: string;
  vCategoryName: string | null;
  vIconImage1: string | null;
}

function toRow(r: RawRow): MasterCategoryRow {
  return {
    id: Number(r.id),
    eType: String(r.eType ?? ""),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    nameBlob: String(r.vCategoryName ?? ""),
    icon: String(r.vIconImage1 ?? "").trim(),
  };
}

/** Every statement below re-binds the scope, so a save cannot cross app types. */
function scopeWhere(scope: MasterCategoryScope, id: number): { sql: string; values: unknown[] } {
  return {
    sql: "WHERE iMasterServiceCategoryId = ? AND eType = ? AND eStatus <> 'Deleted' LIMIT 1",
    values: [id, scope.eType],
  };
}

/** Replace the name blob. The service merges into what was stored; this writes it. */
export async function updateNameBlob(
  scope: MasterCategoryScope,
  id: number,
  raw: string,
): Promise<void> {
  const where = scopeWhere(scope, id);
  await execute(`UPDATE master_service_category_pro SET ${NAME_COLUMN} = ? ${where.sql}`, [
    raw,
    ...where.values,
  ]);
}

/** Point the icon column at a file already written to disk. */
export async function updateIcon(
  scope: MasterCategoryScope,
  id: number,
  filename: string,
): Promise<void> {
  const where = scopeWhere(scope, id);
  await execute(`UPDATE master_service_category_pro SET ${ICON_COLUMN} = ? ${where.sql}`, [
    filename,
    ...where.values,
  ]);
}

/** Flip the row's status. See `deliveryFamilyCategories` for what legacy also did. */
export async function setCategoryStatus(
  scope: MasterCategoryScope,
  id: number,
  status: MasterCategoryStatus,
): Promise<void> {
  const where = scopeWhere(scope, id);
  await execute(`UPDATE master_service_category_pro SET eStatus = ? ${where.sql}`, [
    status,
    ...where.values,
  ]);
}

/**
 * The `vehicle_category` rows the legacy status switch ALSO flips.
 *
 * `master_service_category_action_pro.php` hands a master row's switch to every parent
 * `vehicle_category` whose `eCatType` belongs to the app's family (chosen from module
 * feature flags), honouring `vehicle_category_status_log` overrides, then to the
 * `service_categories` rows linked from them. This screen deliberately writes only its
 * own row; the list exists so the difference can be shown rather than discovered later.
 *
 * `DeliverAll` is left out: those parents belong to the Store Delivery master row, and
 * counting them here would blame this switch for rows another module owns.
 */
const DELIVERY_FAMILY_CAT_TYPES = [
  "Delivery",
  "MultipleDelivery",
  "MotoDelivery",
  "MoreDelivery",
  "Genie",
  "Runner",
  "Anywhere",
] as const;

export interface LinkedCategoryRow {
  id: number;
  name: string;
  catType: string;
  status: string;
}

/** Read-only: the categories a legacy toggle of this row would have cascaded to. */
export async function deliveryFamilyCategories(): Promise<LinkedCategoryRow[]> {
  const rows = await query<{
    id: number | string;
    name: string | null;
    catType: string;
    eStatus: string;
  }>(
    `SELECT iVehicleCategoryId AS id, vCategory_EN AS name, eCatType AS catType, eStatus
       FROM vehicle_category
      WHERE iParentId = 0 AND eStatus <> 'Deleted'
        AND eCatType IN (${DELIVERY_FAMILY_CAT_TYPES.map(() => "?").join(", ")})
      ORDER BY iDisplayOrder, iVehicleCategoryId`,
    [...DELIVERY_FAMILY_CAT_TYPES],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? "").trim(),
    catType: String(r.catType ?? ""),
    status: String(r.eStatus ?? ""),
  }));
}
