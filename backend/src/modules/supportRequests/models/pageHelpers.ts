import { query } from "../../../db/mysql";

/**
 * Shared helpers for the Support Requests report modules (#sub-103/104/107).
 * All three are read-only, server-side paginated listings over legacy tables,
 * so they share the LIKE escaping, page clamping and zero-date-safe date
 * projection conventions used elsewhere in the codebase.
 */

/** Partial type over the row/query shapes (columns not selected in COUNT). */
export type ListFilters = {
  search: string;
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
  page: number;
  limit: number;
  // SOS-only refinements (ignored by the other reports).
  userId?: number; // exact iUserId
  driverId?: number; // exact iDriverId ("Service Provider")
  tripNumber?: string; // partial trips.vRideNo ("Trip/Job Number")
  // Contact Us only: exact eUserType ('Passenger' | 'Driver' | 'Company' | 'Guest').
  userType?: string;
  // Payment Requests only: exact eMarkAsDone ('Yes' = Done | 'No' = Pending).
  status?: string;
};

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** Defensive clamp applied in the service layer after zod. */
export function clampFilters(f: ListFilters): ListFilters {
  return {
    ...f,
    page: Math.max(1, Math.trunc(f.page || 1)),
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.trunc(f.limit || DEFAULT_LIMIT))),
  };
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** ISO date (YYYY-MM-DD) or null; anything else is rejected upstream. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: string | undefined): boolean {
  return !v || DATE_RE.test(v);
}

/**
 * Zero-date-safe formatted timestamp projection. NULLIF must never be used on
 * legacy date columns — it makes the mysql2 text parser throw; DATE_FORMAT
 * yields "0000-00-00 00:00" which mapRow functions turn into null instead.
 */
export function dateCol(expr: string): string {
  return `DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i')`;
}

/** Read a formatted date field back, mapping zero-dates to null. */
export function readDate(v: string | number | null): string | null {
  const s = v == null ? "" : String(v);
  return !s || s.startsWith("0000") ? null : s;
}

/** Build the shared WHERE fragment + params for one searchable date column. */
export function buildWhere(
  f: ListFilters,
  searchSql: string | null, // e.g. "(a.vEmail LIKE ? OR a.vPhone LIKE ?)"
  dateExpr: string, // e.g. "c.tRequestDate"
): { where: string; params: unknown[] } {
  const clauses: string[] = ["1=1"];
  const params: unknown[] = [];
  if (f.search && searchSql) {
    // Replace the `?` placeholders of the caller's fragment with one param each.
    const parts = searchSql.split("?").length - 1;
    clauses.push(searchSql);
    for (let i = 0; i < parts; i++) params.push(likePattern(f.search));
  }
  if (f.from) {
    clauses.push(`DATE(${dateExpr}) >= ?`);
    params.push(f.from);
  }
  if (f.to) {
    clauses.push(`DATE(${dateExpr}) <= ?`);
    params.push(f.to);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** Total rows for a FROM/JOIN + WHERE fragment (same filters as the page). */
export async function countRows(fromJoin: string, where: string, params: unknown[]): Promise<number> {
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM ${fromJoin} ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}
