import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — User Referral Report.
 *
 * Lists referral records from `user_referrer_transaction`: which member
 * (rider or driver) was referred and the stored referrer info. The table has
 * no date column, so this report intentionally supports no date-range filter.
 * List only — the legacy panel defines no export permission for it.
 */

export interface ReferralFilters {
  search: string;
  page: number;
  limit: number;
  /** eUserType classification (Rider | Driver). */
  status?: string;
}

export interface ReferralRow {
  id: number;
  memberId: number;
  member: string;
  memberType: string;
  referrerInfo: string;
}

// The referred member is a rider or a driver depending on eUserType; each
// join is gated so a numeric id in one table never resolves against the
// other. CONCAT_WS over a non-matching join yields '' (not NULL), so every
// branch is NULLIF-wrapped before COALESCE.
const FROM = `user_referrer_transaction r
  LEFT JOIN register_user ru ON ru.iUserId = r.iMemberId AND r.eUserType = 'Rider'
  LEFT JOIN register_driver rd ON rd.iDriverId = r.iMemberId AND r.eUserType = 'Driver'`;
const MEMBER_EXPR = `COALESCE(NULLIF(CONCAT_WS(' ', ru.vName, ru.vLastName), ''), NULLIF(CONCAT_WS(' ', rd.vName, rd.vLastName), ''), '')`;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: ReferralFilters): { where: string; params: unknown[] } {
  const clauses = ["1=1"];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(${MEMBER_EXPR} LIKE ? OR IFNULL(r.tReferrerInfo,'') LIKE ?)`);
    params.push(p, p);
  }
  if (f.status) {
    clauses.push("r.eUserType = ?");
    params.push(f.status);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const SELECT_COLUMNS = `
  r.iRefTransactionId AS id,
  r.iMemberId AS memberId,
  ${MEMBER_EXPR} AS member,
  r.eUserType AS memberType,
  IFNULL(r.tReferrerInfo, '') AS referrerInfo
`;

function mapRow(r: Record<string, unknown>): ReferralRow {
  return {
    id: Number(r.id),
    memberId: Number(r.memberId ?? 0),
    member: String(r.member ?? ""),
    memberType: String(r.memberType ?? ""),
    referrerInfo: String(r.referrerInfo ?? ""),
  };
}

export async function listReferrals(f: ReferralFilters): Promise<ReferralRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY r.iRefTransactionId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countReferrals(f: ReferralFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
