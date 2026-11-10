import { execute, query } from "../../../db/mysql";
import type { ResultSetHeader } from "mysql2/promise";
import { mapRow } from "../../settings/models/settingsModel";
import type { SettingRow } from "../../settings/models/settingsModel";

/**
 * Data access for Marketing Tools → MLM Referral Settings (#sub-146). Everything
 * here was read off the live schema and the five rows this dataset ships with.
 *
 * The page spans two legacy sources:
 *  - `multi_level_referral_master` — one row per referral depth: how far up the
 *    chain a commission still pays, and how much. `iReferralId int NOT NULL`
 *    with **no AUTO_INCREMENT and no index of any kind** (`SHOW INDEX` returns
 *    nothing), so ids are allocated MAX+1 and every write filters by id with
 *    `LIMIT 1`. `eStatus` is enum('Active','Deleted'), i.e. the legacy panel
 *    could retire a level — but this module never writes 'Deleted': the RBAC row
 *    `delete-referral-settings` (#702) is **Inactive**, so there is no delete
 *    permission and therefore no delete route. Reads hide retired rows.
 *  - `configurations` — the scheme switches the levels are interpreted by
 *    (enable flag, Percentage/Fixed, and the maximum level number). Scoped to a
 *    curated allowlist exactly like Maps API Settings (#sub-129), because these
 *    rows are `eAdminDisplay='Yes'` and also appear on General Settings (#sub-125).
 *
 * `iAmount` is `decimal(15,10)`: ten decimal places leaves five integer digits,
 * so 99999.9999999999 is the largest storable value — that ceiling (not a made
 * up money limit) bounds what the service accepts.
 */

/** Legacy status values of a level row. 'Deleted' is never written by this panel. */
export type ReferralLevelStatus = "Active" | "Deleted";

/** One referral level (`multi_level_referral_master`). */
export interface ReferralLevelRow {
  id: number; // iReferralId
  level: number; // iLevel — depth in the referral chain
  title: string; // vTitle
  amount: number; // iAmount
  status: ReferralLevelStatus; // eStatus
}

/** A validated level, ready to persist. */
export interface ReferralLevelWrite {
  level: number;
  title: string;
  amount: number;
}

/**
 * Referral switches this page may edit, in display order. `REFERRAL_LEVEL` is
 * the ceiling the level form validates against, so it belongs on the page that
 * enforces it.
 */
export const EDITABLE_REFERRAL_KEYS = [
  "MULTI_LEVEL_REFERRAL_SCHEME_ENABLE",
  "REFERRAL_AMOUNT_EARN_STRATEGY",
  "REFERRAL_LEVEL",
] as const;

/**
 * Read-only context: the single-level scheme that multi-level builds on. They
 * stay editable only through General Settings, so the id guard below never lets
 * this page write them.
 */
export const READ_ONLY_REFERRAL_KEYS = ["REFERRAL_SCHEME_ENABLE", "REFERRAL_AMOUNT"] as const;

const ALL_REFERRAL_KEYS: readonly string[] = [...EDITABLE_REFERRAL_KEYS, ...READ_ONLY_REFERRAL_KEYS];

// Preserves the array order above straight in SQL (FIELD returns 1..n).
const KEY_ORDER = `FIELD(vName, ${ALL_REFERRAL_KEYS.map(() => "?").join(", ")})`;
const ALL_KEY_FILTER = `vName IN (${ALL_REFERRAL_KEYS.map(() => "?").join(", ")})`;
const EDITABLE_KEY_FILTER = `vName IN (${EDITABLE_REFERRAL_KEYS.map(() => "?").join(", ")})`;

const SETTING_COLUMNS = `iSettingId, vName, tDescription, vValue, tHelp, eInputType, tSelectVal,
  eType, eFor, vOrder, eZeroAllowed, eSpaceAllowed, eDoubleValueAllowed,
  eRequireField, eSensitive, iMaxVal`;

/** The referral scheme settings (editable + read-only context), curated order. */
export async function listReferralSettings(): Promise<SettingRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SETTING_COLUMNS}
       FROM configurations
      WHERE ${ALL_KEY_FILTER} AND eStatus = 'Active'
      ORDER BY ${KEY_ORDER}`,
    [...ALL_REFERRAL_KEYS, ...ALL_REFERRAL_KEYS],
  );
  return rows.map(mapRow);
}

/**
 * Persist many scheme settings in ONE statement (CASE-per-id) instead of one
 * round trip per row. The editable-allowlist guard is repeated in the WHERE
 * clause, so a read-only context row or a foreign id can never be written
 * through this path even if it slips past the service.
 */
export async function bulkUpdateReferralSettingValues(
  changes: { id: number; value: string }[],
): Promise<number> {
  if (!changes.length) return 0;
  const ids = changes.map((c) => c.id);
  const sql = `UPDATE configurations SET vValue = CASE iSettingId ${changes
    .map(() => "WHEN ? THEN ?")
    .join(" ")} END
    WHERE iSettingId IN (${ids.map(() => "?").join(", ")}) AND ${EDITABLE_KEY_FILTER} AND eStatus = 'Active'`;
  const res = await execute(sql, [
    ...changes.flatMap((c) => [c.id, c.value]),
    ...ids,
    ...EDITABLE_REFERRAL_KEYS,
  ]);
  return res.affectedRows;
}

const LEVEL_COLUMNS = `iReferralId, iLevel, vTitle, iAmount, eStatus`;

function mapLevel(r: Record<string, string | number | null>): ReferralLevelRow {
  return {
    id: Number(r.iReferralId),
    level: Number(r.iLevel),
    // vTitle is longtext in the legacy schema; the panel treats it as a label.
    title: String(r.vTitle ?? "").trim(),
    // DECIMAL comes back as a string unless the driver is told otherwise.
    amount: Number(r.iAmount ?? 0),
    status: String(r.eStatus ?? "Active") as ReferralLevelStatus,
  };
}

/** Every live level, shallowest depth first. */
export async function listLevels(): Promise<ReferralLevelRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${LEVEL_COLUMNS} FROM multi_level_referral_master
      WHERE eStatus = 'Active'
      ORDER BY iLevel, iReferralId`,
  );
  return rows.map(mapLevel);
}

/** One live level, or null. */
export async function findLevel(id: number): Promise<ReferralLevelRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${LEVEL_COLUMNS} FROM multi_level_referral_master
      WHERE iReferralId = ? AND eStatus = 'Active'
      LIMIT 1`,
    [id],
  );
  return rows.length ? mapLevel(rows[0]) : null;
}

/**
 * The live level row already claiming this depth, if any. Only Active rows are
 * considered: a retired level frees its number, because nothing in the schema
 * references `iReferralId` (the only related column is the free-text
 * `user_referrer_transaction.tReferrerInfo`).
 */
export async function findLevelByDepth(level: number): Promise<ReferralLevelRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${LEVEL_COLUMNS} FROM multi_level_referral_master
      WHERE iLevel = ? AND eStatus = 'Active'
      ORDER BY iReferralId
      LIMIT 1`,
    [level],
  );
  return rows.length ? mapLevel(rows[0]) : null;
}

/**
 * MAX+1 over every row INCLUDING retired ones: a 'Deleted' level still occupies
 * its id, and reusing it would re-attach that history to a new depth.
 */
export async function nextLevelId(): Promise<number> {
  const rows = await query<{ nextId: number | null }>(
    "SELECT MAX(iReferralId) + 1 AS nextId FROM multi_level_referral_master",
  );
  return Number(rows[0]?.nextId ?? 0) || 1;
}

/** Insert one level. New levels are always Active — retirement needs the (inactive) delete permission. */
export async function createLevel(id: number, d: ReferralLevelWrite): Promise<void> {
  await execute(
    `INSERT INTO multi_level_referral_master
       (iReferralId, vTitle, iAmount, eStatus, iLevel)
     VALUES (?, ?, ?, 'Active', ?)`,
    [id, d.title, d.amount, d.level],
  );
}

/** Edit one live level. `eStatus` is deliberately not part of the write. */
export async function updateLevel(id: number, d: ReferralLevelWrite): Promise<void> {
  const res = await execute(
    `UPDATE multi_level_referral_master
        SET vTitle = ?, iAmount = ?, iLevel = ?
      WHERE iReferralId = ? AND eStatus = 'Active'
      LIMIT 1`,
    [d.title, d.amount, d.level, id],
  );
  if (res.affectedRows === 0) {
    throw new Error(`Level #${id} disappeared while saving.`);
  }
}
