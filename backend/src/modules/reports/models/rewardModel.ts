import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — User Reward Report.
 *
 * The legacy `driver_reward` grants table is empty in this dataset, so the
 * report is campaign-centric: one row per `reward_campaign` with the number
 * of rewards granted and the total credit from `driver_reward` rolled up per
 * campaign. Deleted campaigns stay hidden, matching the legacy panel.
 * List only — the legacy panel defines no export permission for it.
 */

export interface UserRewardFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  /** eStatus filter (Active | Inactive | Cancelled | Expired). */
  status?: string;
}

export interface UserRewardRow {
  id: number;
  title: string;
  startDate: string;
  endDate: string;
  status: string;
  currentActive: string;
  rewardsGranted: number;
  totalCredit: number;
}

const FROM = `reward_campaign rc
  LEFT JOIN (
    SELECT iCampaignId, COUNT(*) AS grants, IFNULL(SUM(fCredit), 0) AS credit
    FROM driver_reward
    GROUP BY iCampaignId
  ) drg ON drg.iCampaignId = rc.iCampaignId`;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: UserRewardFilters): { where: string; params: unknown[] } {
  // Deleted campaigns are never listed (legacy behaviour).
  const clauses = ["rc.eStatus != 'Deleted'"];
  const params: unknown[] = [];

  if (f.search) {
    clauses.push("rc.vTitle LIKE ?");
    params.push(escapeLike(f.search));
  }
  if (f.status) {
    clauses.push("rc.eStatus = ?");
    params.push(f.status);
  }
  if (f.from) {
    clauses.push("rc.dStart_date >= ?");
    params.push(f.from);
  }
  if (f.to) {
    clauses.push("rc.dStart_date <= ?");
    params.push(f.to);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// DATE_FORMAT yields NULL for zero-dates; mapRow flattens them to "".
const SELECT_COLUMNS = `
  rc.iCampaignId AS id,
  IFNULL(rc.vTitle, '') AS title,
  DATE_FORMAT(rc.dStart_date, '%Y-%m-%d') AS startDate,
  DATE_FORMAT(rc.dEnd_date, '%Y-%m-%d') AS endDate,
  rc.eStatus AS status,
  rc.eCurrentActive AS currentActive,
  IFNULL(drg.grants, 0) AS rewardsGranted,
  IFNULL(drg.credit, 0) AS totalCredit
`;

function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, unknown>): UserRewardRow {
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    startDate: cleanDate(r.startDate),
    endDate: cleanDate(r.endDate),
    status: String(r.status ?? ""),
    currentActive: String(r.currentActive ?? ""),
    rewardsGranted: Number(r.rewardsGranted ?? 0),
    totalCredit: Number(r.totalCredit ?? 0),
  };
}

export async function listRewardCampaigns(f: UserRewardFilters): Promise<UserRewardRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY rc.dStart_date DESC, rc.iCampaignId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countRewardCampaigns(f: UserRewardFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
