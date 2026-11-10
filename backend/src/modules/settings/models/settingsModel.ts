import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `configurations` table — the app's global
 * key/value settings store (MyISAM, no primary key, logical `iSettingId`).
 *
 * We never alter the table: reads are restricted to the admin-editable subset
 * (`eStatus = 'Active' AND eAdminDisplay = 'Yes'`) and writes only ever touch
 * `vValue`, so the legacy PHP app keeps working unchanged. Each row carries
 * enough metadata (input type, options, validation flags) to render and
 * validate the field without any hard-coded per-key knowledge — the whole
 * feature is data-driven.
 */

/** Rendering / validation metadata + current value for one setting. */
export interface SettingRow {
  id: number; // iSettingId
  key: string; // vName (stable machine key)
  label: string; // tDescription (human label)
  value: string; // vValue
  help: string; // tHelp
  inputType: "Text" | "Textarea" | "Select" | "Number" | "NumericRange" | "Time";
  selectOptions: string; // raw tSelectVal (comma separated; may be empty)
  category: string; // eType
  appArea: string; // eFor
  order: number; // vOrder
  zeroAllowed: boolean; // eZeroAllowed
  spaceAllowed: boolean; // eSpaceAllowed
  doubleAllowed: boolean; // eDoubleValueAllowed
  required: boolean; // eRequireField
  sensitive: boolean; // eSensitive
  maxValue: number; // iMaxVal (0 = unconstrained)
}

/** A single write from the UI: an id and its new raw value. */
export interface SettingWrite {
  id: number;
  value: string;
}

const EDITABLE_WHERE = `eStatus = 'Active' AND eAdminDisplay = 'Yes'`;

// Group categories in a stable, human-friendly order regardless of the enum's
// declaration order, then by each row's own `vOrder`.
const CATEGORY_ORDER = `FIELD(eType,
  'General', 'Apperance', 'Email', 'SMS', 'Payment', 'Prices', 'Paypal',
  'Social Media', 'App Settings', 'Installation Settings', 'Store Settings',
  'Blocked', 'Ride Share Settings')`;

function toBool(v: string): boolean {
  return v === "Yes";
}

/**
 * Map a raw `configurations` row to the trimmed `SettingRow` shape used across
 * the service/controller. Enum/text columns arrive as strings; the Yes/No
 * columns become booleans so downstream code never string-compares. Shared with
 * the Maps API feature (same underlying `configurations` table).
 */
export function mapRow(r: Record<string, string | number | null>): SettingRow {
  return {
    id: Number(r.iSettingId),
    key: String(r.vName ?? ""),
    label: String(r.tDescription ?? "").trim(),
    value: String(r.vValue ?? ""),
    help: String(r.tHelp ?? "").trim(),
    inputType: String(r.eInputType ?? "Text") as SettingRow["inputType"],
    selectOptions: String(r.tSelectVal ?? ""),
    category: String(r.eType ?? "General"),
    appArea: String(r.eFor ?? ""),
    order: Number(r.vOrder) || 0,
    zeroAllowed: toBool(String(r.eZeroAllowed)),
    spaceAllowed: toBool(String(r.eSpaceAllowed)),
    doubleAllowed: toBool(String(r.eDoubleValueAllowed)),
    required: toBool(String(r.eRequireField)),
    sensitive: toBool(String(r.eSensitive)),
    maxValue: Number(r.iMaxVal) || 0,
  };
}

/** All admin-editable settings, ordered by category then display order. */
export async function listEditableSettings(): Promise<SettingRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT iSettingId, vName, tDescription, vValue, tHelp, eInputType, tSelectVal,
            eType, eFor, vOrder, eZeroAllowed, eSpaceAllowed, eDoubleValueAllowed,
            eRequireField, eSensitive, iMaxVal
       FROM configurations
      WHERE ${EDITABLE_WHERE}
      ORDER BY ${CATEGORY_ORDER}, vOrder, iSettingId`,
  );
  return rows.map(mapRow);
}

/**
 * Persist many settings in ONE statement (CASE-per-id) instead of one round
 * trip per row. The editable-subset guard is repeated in the WHERE clause so a
 * stale/foreign id can never be written even if it slips past the service's
 * validation; within a batch such an id simply matches zero rows.
 */
export async function bulkUpdateSettingValues(
  changes: { id: number; value: string }[],
): Promise<number> {
  if (!changes.length) return 0;
  const ids = changes.map((c) => c.id);
  const sql = `UPDATE configurations SET vValue = CASE iSettingId ${changes
    .map(() => "WHEN ? THEN ?")
    .join(" ")} END
    WHERE iSettingId IN (${ids.map(() => "?").join(", ")}) AND ${EDITABLE_WHERE}`;
  const params = [...changes.flatMap((c) => [c.id, c.value]), ...ids];
  const res = await execute(sql, params);
  return res.affectedRows;
}
