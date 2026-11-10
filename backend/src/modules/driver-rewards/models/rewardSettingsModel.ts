import { execute, query } from "../../../db/mysql";

/**
 * Legacy `reward_settings` — the driver loyalty ladder (Drivers → Manage Reward,
 * #sub-5). Quirks:
 *  - MyISAM, no primary key and no auto-increment; the seeded ladder is a fixed
 *    set of rows (`iRewardId` 3/4/8/9 = Silver/Gold/Platinum/Diamond). The RBAC
 *    seed only exposes view + update, so this module never inserts or removes a
 *    level — it edits the thresholds of rows that already exist.
 *  - `vMinimumTrips` is an int despite the `v` prefix.
 *  - `vLevel` is NOT a plain string: it holds a per-language JSON map
 *    (`{"vLevel_EN":"Gold","vLevel_AR":"…", …}`), so a name edit is a
 *    read-modify-write that replaces the English entry only.
 *  - `eRewardLevel` is the ladder position (1..4) and drives the display order.
 */

export interface RewardSettingRow {
  id: number; // iRewardId
  levelName: string; // English entry of the vLevel JSON map
  minTrips: number; // vMinimumTrips
  ratings: number; // fRatings
  acceptanceRate: number; // iAcceptanceRate
  cancellationRate: number; // iCancellationRate
  duration: number; // iDuration
  credit: number; // fCredit
  image: string; // vImage (bare badge filename under the legacy app root)
  rewardLevel: number; // eRewardLevel
}

export interface RewardSettingInput {
  levelName: string;
  minTrips: number;
  ratings: number;
  acceptanceRate: number;
  cancellationRate: number;
  duration: number;
  credit: number;
}

/** Raw row: the level blob stays text so the map can be rewritten loss-free. */
type RawRow = Record<string, string | number | null>;

const SELECT_COLUMNS = `
  iRewardId, vLevel, vMinimumTrips, fRatings, iAcceptanceRate,
  iCancellationRate, iDuration, fCredit, vImage, eRewardLevel`;

function mapRow(r: RawRow): RewardSettingRow {
  return {
    id: Number(r.iRewardId),
    levelName: readEnglishLevel(String(r.vLevel ?? "")),
    minTrips: Number(r.vMinimumTrips) || 0,
    ratings: Number(r.fRatings) || 0,
    acceptanceRate: Number(r.iAcceptanceRate) || 0,
    cancellationRate: Number(r.iCancellationRate) || 0,
    duration: Number(r.iDuration) || 0,
    credit: Number(r.fCredit) || 0,
    image: String(r.vImage ?? ""),
    rewardLevel: Number(r.eRewardLevel) || 0,
  };
}

// ---------------------------------------------------------------------------
// vLevel multilingual map (same shape as the news / donation / promo blobs)
// ---------------------------------------------------------------------------

const LEVEL_PREFIX = "vLevel";

/** English label of a `vLevel` blob; a plain-text legacy value is the label. */
export function readEnglishLevel(raw: string): string {
  if (!raw) return "";
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return String(obj[`${LEVEL_PREFIX}_EN`] ?? "");
  } catch {
    return raw;
  }
}

/**
 * Replace the English entry of a `vLevel` blob, carrying every other language
 * over untouched. A blob that was not JSON (or had no map at all) is upgraded
 * into one without losing the other languages it did declare.
 */
export function writeEnglishLevel(raw: string, english: string): string {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    obj = {};
  }
  obj[`${LEVEL_PREFIX}_EN`] = english;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------

/** The whole ladder, bottom level first. */
export async function listSettings(): Promise<RewardSettingRow[]> {
  const rows = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS} FROM reward_settings ORDER BY eRewardLevel ASC, iRewardId ASC`,
  );
  return rows.map(mapRow);
}

export async function findSetting(id: number): Promise<RewardSettingRow | null> {
  const rows = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS} FROM reward_settings WHERE iRewardId = ?`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Edit one ladder rung; `vImage` and `eRewardLevel` are never touched. */
export async function updateSetting(
  id: number,
  input: RewardSettingInput,
): Promise<void> {
  // Read-modify-write: the other 25 languages of the blob must survive.
  const current = await query<{ vLevel: string | null }>(
    "SELECT vLevel FROM reward_settings WHERE iRewardId = ?",
    [id],
  );
  const blob = writeEnglishLevel(String(current[0]?.vLevel ?? ""), input.levelName);

  await execute(
    `UPDATE reward_settings
        SET vLevel = ?, vMinimumTrips = ?, fRatings = ?, iAcceptanceRate = ?,
            iCancellationRate = ?, iDuration = ?, fCredit = ?
      WHERE iRewardId = ?`,
    [
      blob,
      input.minTrips,
      input.ratings,
      input.acceptanceRate,
      input.cancellationRate,
      input.duration,
      input.credit,
      id,
    ],
  );
}
