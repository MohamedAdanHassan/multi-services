import { AppError } from "../../../errors/AppError";
import { execute, query } from "../../../db/mysql";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the Parcel Delivery → Manage Service Category sub-screen
 * (#sub-136): the legacy `vehicle_sub_category.php` list, which shows the CHILD rows
 * of one parent `vehicle_category` (`iParentId = <parent>`).
 *
 * Unlike the master-category module (which edits `master_service_category_pro` and
 * keeps every language inside one JSON blob), a `vehicle_category` row keeps its
 * per-language name in its own column (`vCategory_<CODE>`). The list reads ONE column
 * for display; the edit form reads/writes every installed language's own column plus
 * `iDisplayOrder` — the two things a sub-category row owns about itself. Nothing else
 * (artwork, the flat JSON copy blobs, the pricing/behaviour settings) is touched here:
 * those belong to the master/taxi category editors. This layer's writes are therefore
 * limited to the whitelisted `EDITABLE_UPDATE_COLUMNS` set below.
 *
 * The screen also DRILLS DOWN: pressing a row's "View" lists that row's own children,
 * so the "current parent" is a per-request value, not a constant. It is still bounded:
 * every app owns a single ROOT parent (Parcel = 178) and the service only ever hands
 * this layer a parent that is the root or a DESCENDANT of it (see {@link isInSubtree}),
 * so the delivery route can never read or write another app's (e.g. the taxi's) tree.
 *
 * `vehicle_category` is MyISAM with no primary key and no auto-increment, so every
 * write is a single UPDATE scoped by `iVehicleCategoryId` re-bound to the CURRENT
 * parent: one statement per action means a save can never half-apply, and a child of a
 * different parent can never be touched through this path. The parent id is validated
 * against the app's subtree, never trusted straight from the payload.
 *
 * Deletion is soft (`eStatus = 'Deleted'`), matching the legacy panel, and it honours
 * the legacy guard: a category that still owns live `vehicle_type` rows cannot be
 * deleted. Deleted rows are hidden from the default list and only surface when the
 * status filter explicitly asks for them.
 */

export type SubCategoryStatus = "Active" | "Inactive";

/** The apps this sub-screen serves, named as the URL segment spells them. */
export type SubCategoryAppKey = "delivery";

/** One app's ROOT parent row plus the label the legacy panel gives the screen. */
export interface SubCategoryScope {
  app: SubCategoryAppKey;
  /** `vehicle_category.iVehicleCategoryId` of the subtree root; only this family is reachable. */
  rootCategoryId: number;
  label: string;
}

export const SUB_CATEGORY_SCOPES: Record<SubCategoryAppKey, SubCategoryScope> = {
  // Parcel Delivery "Sub Service Category (Parcel)": the MoreDelivery parent 178 roots
  // the family. Any parent inside its subtree (178 itself or a descendant) may be listed
  // and edited; anything outside is refused by the service before it reaches this layer.
  delivery: { app: "delivery", rootCategoryId: 178, label: "Parcel Delivery" },
};

export const SUB_CATEGORY_APP_KEYS = Object.keys(
  SUB_CATEGORY_SCOPES,
) as SubCategoryAppKey[];

/** Backstop so an unmapped `:app` segment can never read another app's children. */
export function requireScope(name: unknown): SubCategoryScope {
  const key = String(name ?? "");
  if (!SUB_CATEGORY_APP_KEYS.includes(key as SubCategoryAppKey)) {
    throw AppError.badRequest(`Unknown sub-category app: “${key || "(empty)"}”.`);
  }
  return SUB_CATEGORY_SCOPES[key as SubCategoryAppKey];
}

/** A listed sub-category row, mapped to a camelCase shape. */
export interface SubCategoryRow {
  id: number;
  /** Name in the display language (default language), trimmed. */
  name: string;
  catType: string;
  status: SubCategoryStatus;
  displayOrder: number;
  /** Live children this row owns (the legacy "View (N)" count); the drill-down gate. */
  childCount: number;
  /** Live `vehicle_type` rows under this category — non-empty blocks a delete. */
  liveServiceTypes: number;
}

interface RawRow {
  id: number | string;
  name: string | null;
  eCatType: string | null;
  eStatus: string;
  iDisplayOrder: number | string | null;
  child_count: number | string | null;
  vtype_count: number | string | null;
}

function toRow(r: RawRow): SubCategoryRow {
  return {
    id: Number(r.id),
    name: String(r.name ?? "").trim(),
    catType: String(r.eCatType ?? ""),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    displayOrder: Number(r.iDisplayOrder ?? 0) || 0,
    childCount: Number(r.child_count ?? 0) || 0,
    liveServiceTypes: Number(r.vtype_count ?? 0) || 0,
  };
}

/** `vCategory_<CODE>` is interpolated, so the code must be a known language column. */
function nameColumn(code: string): string {
  if (!/^[A-Z]{1,10}$/.test(code)) {
    throw AppError.badRequest(`Invalid display language: “${code}”.`);
  }
  return `vCategory_${code}`;
}

/** The language codes the legacy table pre-allocates a `vCategory_*` column for. */
const KNOWN_NAME_CODES = new Set<string>(TRANSLATION_LANGUAGES.map((l) => l.code));

/**
 * Columns an edit may write: every `vCategory_<CODE>` name plus `iDisplayOrder`. The
 * UPDATE interpolates column names, so membership is re-checked here even though the
 * service only ever passes whitelisted codes — an interpolated name must be one of ours.
 */
function assertEditableColumn(column: string): void {
  const nameMatch = /^vCategory_([A-Z]{1,10})$/.exec(column);
  const ok = column === "iDisplayOrder" || (nameMatch && KNOWN_NAME_CODES.has(nameMatch[1]));
  if (!ok) {
    throw AppError.badRequest(`Column “${column}” is not editable here.`);
  }
}

/** Detail shape for the edit form: every installed-language name plus the sort order. */
export interface SubCategoryDetailRow {
  id: number;
  /** The row's own parent — the drill level the detail was read at. */
  parentId: number;
  catType: string;
  status: SubCategoryStatus;
  displayOrder: number;
  childCount: number;
  liveServiceTypes: number;
  /** Stored name keyed by language code (only the codes asked for). */
  names: Record<string, string>;
}

/**
 * Is `candidateId` the root or a DESCENDANT of `rootId`? Walks the parent chain upward
 * from the candidate. The Parcel family is shallow (root → category → leaf), so the walk
 * is bounded by {@link MAX_ANCESTOR_DEPTH}; hitting a top-level / self / missing parent
 * before reaching the root answers false, keeping another app's tree unreachable.
 */
const MAX_ANCESTOR_DEPTH = 12;
export async function isInSubtree(rootId: number, candidateId: number): Promise<boolean> {
  if (!Number.isInteger(candidateId) || candidateId <= 0) return false;
  if (candidateId === rootId) return true;
  let current = candidateId;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const rows = await query<{ iParentId: number | string | null }>(
      "SELECT iParentId FROM vehicle_category WHERE iVehicleCategoryId = ? LIMIT 1",
      [current],
    );
    if (!rows.length) return false;
    const pid = Number(rows[0].iParentId ?? 0);
    if (pid === rootId) return true;
    if (pid === 0 || pid === current) return false;
    current = pid;
  }
  return false;
}

export interface SubCategoryFilter {
  /** Substring matched against the display-language name column. */
  keyword?: string;
  /** When set, show exactly this status (including "Deleted"); otherwise hide Deleted. */
  status?: SubCategoryStatus | "Deleted";
}

/** The columns every list/find row reads, keyed to the parent so the counts stay in scope. */
const ROW_SELECT = `iVehicleCategoryId AS id, {col} AS name, eCatType, eStatus, iDisplayOrder,
            (SELECT COUNT(*) FROM vehicle_type vt
               WHERE vt.iVehicleCategoryId = vehicle_category.iVehicleCategoryId
                 AND vt.eStatus <> 'Deleted') AS vtype_count,
            (SELECT COUNT(*) FROM vehicle_category c
               WHERE c.iParentId = vehicle_category.iVehicleCategoryId
                 AND c.eStatus <> 'Deleted') AS child_count`;

/**
 * List one parent's live children (or one exact status when filtered). Keyword narrows
 * on the display-language name; the `Deleted` set is only reachable through an explicit
 * status filter, so the default view never shows soft-deleted rows.
 */
export async function listSubCategories(
  parentId: number,
  displayLang: string,
  filter: SubCategoryFilter,
): Promise<SubCategoryRow[]> {
  const column = nameColumn(displayLang);
  const clauses: string[] = ["iParentId = ?"];
  const values: unknown[] = [parentId];

  if (filter.status) {
    clauses.push("eStatus = ?");
    values.push(filter.status);
  } else {
    clauses.push("eStatus <> 'Deleted'");
  }

  const keyword = (filter.keyword ?? "").trim();
  if (keyword) {
    // Column name is whitelisted above; the value is bound, so no injection via search.
    clauses.push(`${column} LIKE ?`);
    values.push(`%${keyword.replace(/[%_]/g, "")}%`);
  }

  const rows = await query<RawRow>(
    `SELECT ${ROW_SELECT.replace("{col}", column)}
       FROM vehicle_category
      WHERE ${clauses.join(" AND ")}
      ORDER BY iDisplayOrder, iVehicleCategoryId`,
    values,
  );
  return rows.map(toRow);
}

/** One live child of `parentId`, or null when absent / a child of another parent. */
export async function findSubCategory(
  parentId: number,
  id: number,
  displayLang: string,
): Promise<SubCategoryRow | null> {
  const column = nameColumn(displayLang);
  const rows = await query<RawRow>(
    `SELECT ${ROW_SELECT.replace("{col}", column)}
       FROM vehicle_category
      WHERE iVehicleCategoryId = ? AND iParentId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id, parentId],
  );
  return rows.length ? toRow(rows[0]) : null;
}

/**
 * One live child for the edit form, carrying the stored name of every language in
 * `codes` (each whitelisted through {@link nameColumn}) plus the sort order. Same
 * live-child-of-`parentId` scope as {@link findSubCategory}, so an edit form can never
 * be opened for a row that is not in the current level's subtree.
 */
export async function findSubCategoryDetail(
  parentId: number,
  id: number,
  codes: string[],
): Promise<SubCategoryDetailRow | null> {
  const columns = codes.map(nameColumn);
  const select = [
    "iVehicleCategoryId AS id",
    "iParentId AS parentId",
    "eCatType",
    "eStatus",
    "iDisplayOrder",
    ...columns.map((c) => `${c} AS \`${c}\``),
    `(SELECT COUNT(*) FROM vehicle_type vt
        WHERE vt.iVehicleCategoryId = vehicle_category.iVehicleCategoryId
          AND vt.eStatus <> 'Deleted') AS vtype_count`,
    `(SELECT COUNT(*) FROM vehicle_category c
        WHERE c.iParentId = vehicle_category.iVehicleCategoryId
          AND c.eStatus <> 'Deleted') AS child_count`,
  ].join(", ");
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${select}
       FROM vehicle_category
      WHERE iVehicleCategoryId = ? AND iParentId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id, parentId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const names: Record<string, string> = {};
  codes.forEach((code, i) => {
    names[code] = String(r[columns[i]] ?? "");
  });
  return {
    id: Number(r.id),
    parentId: Number(r.parentId ?? 0),
    catType: String(r.eCatType ?? ""),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    displayOrder: Number(r.iDisplayOrder ?? 0) || 0,
    childCount: Number(r.child_count ?? 0) || 0,
    liveServiceTypes: Number(r.vtype_count ?? 0) || 0,
    names,
  };
}

/**
 * Which live parent a row hangs from, read WITHOUT a parent scope. The edit PAGE uses it
 * to re-resolve the drill level when it was opened by id alone (a deep-linked / refreshed
 * `/<app>/<id>/edit` URL carries no `?parent=`), so the service can then re-scope every
 * following read/write to `iParentId` as usual. Returns null for a Deleted or unknown id;
 * the CALLER still bounds the answer to the app's subtree — this only reports what the
 * data says, it authorises nothing.
 */
export async function findOwnParent(id: number): Promise<number | null> {
  const rows = await query<{ iParentId: number | string | null }>(
    `SELECT iParentId FROM vehicle_category
      WHERE iVehicleCategoryId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return Number(rows[0].iParentId ?? 0) || null;
}

/**
 * Write a child's name columns and/or display order in ONE statement, scoped to a live
 * child of `parentId`. `vehicle_category` is MyISAM (no transactions), so a single UPDATE
 * is what guarantees a save cannot half-apply; a row under a different parent matches
 * nothing and is left untouched. Every column is re-checked against the edit whitelist
 * before it is interpolated.
 */
export async function updateChild(
  parentId: number,
  id: number,
  sets: { column: string; value: string | number }[],
): Promise<void> {
  if (!sets.length) return;
  for (const { column } of sets) assertEditableColumn(column);
  await execute(
    `UPDATE vehicle_category SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iVehicleCategoryId = ? AND iParentId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [...sets.map((s) => s.value), id, parentId],
  );
}

/**
 * Activate / deactivate one child. Never resurrects a Deleted row (the `<> 'Deleted'`
 * guard) and only matches a row whose parent is `parentId`, so a status toggle can
 * neither undo a delete nor touch a child of another parent.
 */
export async function setStatus(
  parentId: number,
  id: number,
  status: SubCategoryStatus,
): Promise<void> {
  await execute(
    `UPDATE vehicle_category SET eStatus = ?
      WHERE iVehicleCategoryId = ? AND iParentId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [status, id, parentId],
  );
}

/** Activate / deactivate several children of `parentId` at once. */
export async function setStatusMany(
  parentId: number,
  ids: number[],
  status: SubCategoryStatus,
): Promise<void> {
  if (!ids.length) return;
  await execute(
    `UPDATE vehicle_category SET eStatus = ?
      WHERE iVehicleCategoryId IN (${ids.map(() => "?").join(", ")})
        AND iParentId = ? AND eStatus <> 'Deleted'`,
    [status, ...ids, parentId],
  );
}

/**
 * Soft-delete children of `parentId` that have no live `vehicle_type` rows. Returns the
 * ids actually deleted; the caller checks {@link blockedByServiceTypes} first so a
 * request naming a service-type owner is refused whole (the legacy panel refuses too),
 * rather than half-deleting a multi-select.
 */
export async function softDelete(parentId: number, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await execute(
    `UPDATE vehicle_category SET eStatus = 'Deleted'
      WHERE iVehicleCategoryId IN (${ids.map(() => "?").join(", ")})
        AND iParentId = ? AND eStatus <> 'Deleted'`,
    [...ids, parentId],
  );
  return res.affectedRows;
}

/**
 * Children of `parentId` that still own live `vehicle_type` rows and therefore cannot be
 * deleted. Read straight from the table so the answer reflects current data, not payload.
 */
export async function blockedByServiceTypes(
  parentId: number,
  ids: number[],
): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await query<{ id: number | string }>(
    `SELECT DISTINCT vc.iVehicleCategoryId AS id
       FROM vehicle_category vc
       JOIN vehicle_type vt ON vt.iVehicleCategoryId = vc.iVehicleCategoryId AND vt.eStatus <> 'Deleted'
      WHERE vc.iVehicleCategoryId IN (${ids.map(() => "?").join(", ")})
        AND vc.iParentId = ?`,
    [...ids, parentId],
  );
  return rows.map((r) => Number(r.id));
}
