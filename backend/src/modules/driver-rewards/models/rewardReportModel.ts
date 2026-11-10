import { query } from "../../../db/mysql";
import { readEnglishLevel } from "./rewardSettingsModel";

/**
 * Legacy `driver_reward` — the reward grants the app writes when a driver meets
 * a ladder rung (Drivers → Manage Reward → report tab, `view-driver-reward-report`).
 *
 * The panel is read-only: no seeded permission lets an admin hand out a reward,
 * so this layer only lists/describes grants and never writes them. Grants are
 * snapshots — they copy the criteria of the level at grant time — so the list
 * shows the snapshot rather than today's ladder values.
 *
 * `driver_reward` is empty in this dataset; the shape is defined anyway so the
 * tab is correct the moment the app starts granting rewards.
 */

export interface RewardGrantRow {
  id: number;
  driverId: number;
  driverName: string;
  campaignId: number;
  campaignTitle: string;
  levelName: string;
  rewardLevel: number;
  minTrips: number;
  ratings: number;
  acceptanceRate: number;
  cancellationRate: number;
  duration: number;
  credit: number;
  grantedAt: string;
}

export interface RewardGrantFilters {
  search: string;
  driverId?: number;
  campaignId?: number;
  /** YYYY-MM-DD, inclusive (tDate is a timestamp). */
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

type RawRow = Record<string, string | number | null>;

const FROM_JOIN = `
  driver_reward dr
  LEFT JOIN register_driver rd ON rd.iDriverId = dr.iDriverId
  LEFT JOIN reward_campaign rc ON rc.iCampaignId = dr.iCampaignId
  LEFT JOIN reward_settings rs ON rs.iRewardId = dr.iRewardId`;

// Every branch of CONCAT_WS is NULLIF-wrapped: a non-matching join yields '',
// which COALESCE alone would stop at and blank out the fallback.
const SELECT_COLUMNS = `
  dr.iDriverReward AS id,
  dr.iDriverId AS driverId,
  dr.iRewardId AS rewardId,
  dr.iCampaignId AS campaignId,
  COALESCE(NULLIF(TRIM(CONCAT_WS(' ', rd.vName, rd.vLastName)), ''), '') AS driverName,
  IFNULL(rc.vTitle, '') AS campaignTitle,
  rs.vLevel AS levelBlob,
  dr.eRewardLevel AS rewardLevel,
  dr.vMinimumTrips AS minTrips,
  dr.fRatings AS ratings,
  dr.iAcceptanceRate AS acceptanceRate,
  dr.iCancellationRate AS cancellationRate,
  dr.iDuration AS duration,
  dr.fCredit AS credit,
  DATE_FORMAT(dr.tDate, '%Y-%m-%d %H:%i') AS grantedAt`;

function mapRow(r: RawRow): RewardGrantRow {
  const level = readEnglishLevel(String(r.levelBlob ?? ""));
  return {
    id: Number(r.id),
    driverId: Number(r.driverId),
    driverName: String(r.driverName ?? ""),
    campaignId: Number(r.campaignId) || 0,
    campaignTitle: String(r.campaignTitle ?? ""),
    levelName: level || `Level #${Number(r.rewardLevel) || 0}`,
    rewardLevel: Number(r.rewardLevel) || 0,
    minTrips: Number(r.minTrips) || 0,
    ratings: Number(r.ratings) || 0,
    acceptanceRate: Number(r.acceptanceRate) || 0,
    cancellationRate: Number(r.cancellationRate) || 0,
    duration: Number(r.duration) || 0,
    credit: Number(r.credit) || 0,
    // DATE_FORMAT yields NULL for a zero timestamp.
    grantedAt: r.grantedAt == null ? "" : String(r.grantedAt),
  };
}

function escapeLike(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildFilters(f: RewardGrantFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["1=1"];
  const params: unknown[] = [];
  if (f.driverId) {
    clauses.push("dr.iDriverId = ?");
    params.push(f.driverId);
  }
  if (f.campaignId) {
    clauses.push("dr.iCampaignId = ?");
    params.push(f.campaignId);
  }
  if (f.search) {
    clauses.push("(rd.vName LIKE ? OR rd.vLastName LIKE ? OR rc.vTitle LIKE ?)");
    const p = escapeLike(f.search);
    params.push(p, p, p);
  }
  if (f.from) {
    clauses.push("dr.tDate >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("dr.tDate <= ?");
    params.push(`${f.to} 23:59:59`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One page of grants, newest first. */
export async function listGrants(
  f: RewardGrantFilters,
): Promise<RewardGrantRow[]> {
  const { where, params } = buildFilters(f);
  const rows = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN} ${where}
      ORDER BY dr.tDate DESC, dr.iDriverReward DESC
      LIMIT ? OFFSET ?`,
    [...params, f.limit, (f.page - 1) * f.limit],
  );
  return rows.map(mapRow);
}

export async function countGrants(f: RewardGrantFilters): Promise<number> {
  const { where, params } = buildFilters(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM_JOIN} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
