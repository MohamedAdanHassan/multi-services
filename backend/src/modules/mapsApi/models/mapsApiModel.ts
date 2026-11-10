import { execute, query } from "../../../db/mysql";
import { mapRow } from "../../settings/models/settingsModel";
import type { SettingRow } from "../../settings/models/settingsModel";

/**
 * Data access for the Maps API Settings page (#sub-129). Like General Settings
 * this edits rows of the legacy `configurations` key/value table, but it is
 * scoped to a curated allowlist of Maps-related keys rather than the whole
 * admin-displayable set. Two of the core rows (`MAPS_API_REPLACEMENT_STRATEGY`,
 * `ENABLE_MAPS_API_REPLACEMENT`) carry `eAdminDisplay = 'No'`, so we cannot
 * reuse the general `EDITABLE_WHERE`; instead we require only `eStatus =
 * 'Active'` and let the allowlist itself be the safety boundary. Writes touch
 * just `vValue` and are additionally guarded by the same `vName IN (...)` list,
 * so this path can never write a non-Maps setting even given a foreign id.
 */

/**
 * Curated Maps keys, in the order they should appear on the page. Only rows
 * that also have `eStatus = 'Active'` are ever surfaced/writable — the inactive
 * duplicates in the legacy data (e.g. the iOS passenger/driver geo keys) simply
 * do not render, mirroring how the app itself ignores them.
 */
export const MAPS_API_KEYS = [
  "ENABLE_MAPS_API_REPLACEMENT",
  "MAPS_API_REPLACEMENT_STRATEGY",
  "GOOGLE_SEVER_API_KEY_WEB",
  "GOOGLE_IOS_PASSENGER_APP_GEO_KEY",
  "GOOGLE_IOS_DRIVER_APP_GEO_KEY",
  "GOOGLE_IOS_COMPANY_APP_GEO_KEY",
  "IS_SHOW_ROUTE_ON_REQUEST",
  "ENABLE_NAVIGATION_MODE_DRIVER_APP",
] as const;

// Preserves the array order above straight in SQL (FIELD returns 1..n).
const KEY_ORDER = `FIELD(vName, ${MAPS_API_KEYS.map(() => "?").join(", ")})`;
const KEY_FILTER = `vName IN (${MAPS_API_KEYS.map(() => "?").join(", ")})`;

const SELECT_COLUMNS = `iSettingId, vName, tDescription, vValue, tHelp, eInputType, tSelectVal,
  eType, eFor, vOrder, eZeroAllowed, eSpaceAllowed, eDoubleValueAllowed,
  eRequireField, eSensitive, iMaxVal`;

/** The active Maps settings, ordered by the curated allowlist above. */
export async function listMapsSettings(): Promise<SettingRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS}
       FROM configurations
      WHERE ${KEY_FILTER} AND eStatus = 'Active'
      ORDER BY ${KEY_ORDER}`,
    [...MAPS_API_KEYS, ...MAPS_API_KEYS],
  );
  return rows.map(mapRow);
}

/**
 * Persist many Maps settings in ONE statement (CASE-per-id) instead of one
 * round trip per row. The `KEY_FILTER` + `eStatus='Active'` guard is repeated
 * in the WHERE clause so only a known, active Maps row can be written, even if
 * an unexpected id slips past the service's validation.
 */
export async function bulkUpdateMapSettingValues(
  changes: { id: number; value: string }[],
): Promise<number> {
  if (!changes.length) return 0;
  const ids = changes.map((c) => c.id);
  const sql = `UPDATE configurations SET vValue = CASE iSettingId ${changes
    .map(() => "WHEN ? THEN ?")
    .join(" ")} END
    WHERE iSettingId IN (${ids.map(() => "?").join(", ")}) AND ${KEY_FILTER} AND eStatus = 'Active'`;
  const res = await execute(sql, [...changes.flatMap((c) => [c.id, c.value]), ...ids, ...MAPS_API_KEYS]);
  return res.affectedRows;
}
