import { execute, query } from "../../../db/mysql";

/**
 * Legacy `reward_campaign` (Drivers → Manage Reward, #sub-5). Quirks:
 *  - MyISAM, `iCampaignId` has NO AUTO_INCREMENT, so new ids go MAX+1. Soft
 *    deletes keep the row, so a reused id can never shadow a cancelled
 *    campaign's grant history.
 *  - `eStatus` also carries 'Deleted', but the RBAC seed flags
 *    `delete-driver-reward-campaign` as Deleted: this panel has no delete path,
 *    so 'Deleted' rows are hidden everywhere and unreachable from the status
 *    action (Active / Inactive / Cancelled / Expired only).
 *  - `eCurrentActive` marks the one campaign the app is currently running; the
 *    seed has no separate permission for it, so it is written by create/edit and
 *    kept exclusive by `setCurrent`.
 */

export type RewardCampaignStatus = "Active" | "Inactive" | "Cancelled" | "Expired";

export interface RewardCampaignRow {
  id: number;
  title: string;
  startDate: string; // YYYY-MM-DD ("" for a legacy zero date)
  endDate: string;
  status: RewardCampaignStatus;
  currentActive: boolean;
  grants: number; // driver_reward rows pointing at this campaign
  totalCredit: number;
}

export interface RewardCampaignInput {
  title: string;
  startDate: string;
  endDate: string;
  currentActive: boolean;
}

export interface RewardCampaignFilters {
  search: string;
  /** Undefined = every non-deleted status. */
  status?: RewardCampaignStatus;
  currentOnly?: boolean;
}

type RawRow = Record<string, string | number | null>;

/** Grants rollup, shared by the list and the single fetch. */
const FROM_JOIN = `
  reward_campaign rc
  LEFT JOIN (
    SELECT iCampaignId, COUNT(*) AS grants, IFNULL(SUM(fCredit), 0) AS credit
    FROM driver_reward GROUP BY iCampaignId
  ) drg ON drg.iCampaignId = rc.iCampaignId`;

const SELECT_COLUMNS = `
  rc.iCampaignId, IFNULL(rc.vTitle, '') AS vTitle,
  DATE_FORMAT(rc.dStart_date, '%Y-%m-%d') AS startDate,
  DATE_FORMAT(rc.dEnd_date, '%Y-%m-%d') AS endDate,
  rc.eStatus, rc.eCurrentActive,
  IFNULL(drg.grants, 0) AS grants, IFNULL(drg.credit, 0) AS totalCredit`;

/** DATE_FORMAT yields NULL for a zero date; the DTO flattens it to "". */
function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: RawRow): RewardCampaignRow {
  const raw = String(r.eStatus ?? "Inactive");
  return {
    id: Number(r.iCampaignId),
    title: String(r.vTitle ?? ""),
    startDate: cleanDate(r.startDate),
    endDate: cleanDate(r.endDate),
    status:
      raw === "Active" || raw === "Cancelled" || raw === "Expired" ? raw : "Inactive",
    currentActive: String(r.eCurrentActive) === "Yes",
    grants: Number(r.grants) || 0,
    totalCredit: Number(r.totalCredit) || 0,
  };
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

function buildFilters(f: RewardCampaignFilters): { where: string; params: unknown[] } {
  // Cancelled/expired campaigns stay visible; only 'Deleted' is hidden.
  const clauses: string[] = ["rc.eStatus <> 'Deleted'"];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("rc.eStatus = ?");
    params.push(f.status);
  }
  if (f.currentOnly) {
    clauses.push("rc.eCurrentActive = 'Yes'");
  }
  if (f.search) {
    clauses.push("rc.vTitle LIKE ?");
    params.push(likePattern(f.search));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** Campaigns, newest start first; cancelled rows remain listed (legacy panel). */
export async function listCampaigns(
  f: RewardCampaignFilters,
): Promise<RewardCampaignRow[]> {
  const { where, params } = buildFilters(f);
  const rows = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN} ${where}
      ORDER BY rc.dStart_date DESC, rc.iCampaignId DESC`,
    params,
  );
  return rows.map(mapRow);
}

/** One campaign by id, 'Deleted' rows excluded. */
export async function findCampaign(id: number): Promise<RewardCampaignRow | null> {
  const rows = await query<RawRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
      WHERE rc.iCampaignId = ? AND rc.eStatus <> 'Deleted'`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** `iCampaignId` has no AUTO_INCREMENT, so ids go MAX+1. */
export async function nextCampaignId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iCampaignId) AS max FROM reward_campaign",
  );
  return (rows[0]?.max ?? 0) + 1;
}

/** New campaign; every NOT NULL column is supplied (status starts Inactive). */
export async function createCampaign(input: RewardCampaignInput): Promise<number> {
  const id = await nextCampaignId();
  await execute(
    `INSERT INTO reward_campaign
       (iCampaignId, vTitle, dStart_date, dEnd_date, eStatus, eCurrentActive)
     VALUES (?, ?, ?, ?, 'Inactive', ?)`,
    [
      id,
      input.title,
      input.startDate,
      input.endDate,
      input.currentActive ? "Yes" : "No",
    ],
  );
  return id;
}

/** Edit title/date/current flag; the lifecycle status goes through setStatus. */
export async function updateCampaign(
  id: number,
  input: RewardCampaignInput,
): Promise<void> {
  await execute(
    `UPDATE reward_campaign
        SET vTitle = ?, dStart_date = ?, dEnd_date = ?, eCurrentActive = ?
      WHERE iCampaignId = ? AND eStatus <> 'Deleted'`,
    [
      input.title,
      input.startDate,
      input.endDate,
      input.currentActive ? "Yes" : "No",
      id,
    ],
  );
}

/** Lifecycle status; 'Deleted' is deliberately unreachable (no delete permission). */
export async function setStatus(
  id: number,
  status: RewardCampaignStatus,
): Promise<void> {
  await execute(
    "UPDATE reward_campaign SET eStatus = ? WHERE iCampaignId = ? AND eStatus <> 'Deleted'",
    [status, id],
  );
}

/**
 * Make one campaign the current one. MyISAM has no transactions, so this is two
 * statements (demote all, then promote); the window between them is acceptable
 * because the flag only steers which campaign the apps show.
 */
export async function setCurrent(id: number): Promise<void> {
  await execute(
    "UPDATE reward_campaign SET eCurrentActive = 'No' WHERE eCurrentActive = 'Yes'",
  );
  await execute(
    "UPDATE reward_campaign SET eCurrentActive = 'Yes' WHERE iCampaignId = ? AND eStatus <> 'Deleted'",
    [id],
  );
}
