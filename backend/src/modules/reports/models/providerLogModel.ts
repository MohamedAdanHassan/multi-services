import { query } from "../../../db/mysql";

/**
 * Other Reports (#sub-100) — Provider (Driver) Log Report.
 *
 * Lists driver app sessions from `driver_log_report`: one row per login, with
 * the matching logout, the session duration and the IP the driver used.
 * `dLogoutDateTime` is a zero-date while a session is still open, so the
 * logout time flattens to "" (shown as "online") and duration guards against
 * it — no zero-date literals reach mysql2 (see the DATE_FORMAT pattern).
 */

export interface ProviderLogFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface ProviderLogRow {
  id: number;
  driverId: number;
  driver: string;
  loginTime: string;
  logoutTime: string;
  durationSeconds: number;
  ip: string;
}

const DRIVER_JOIN = "LEFT JOIN register_driver dr ON dr.iDriverId = dl.iDriverId";
const DRIVER_EXPR = "CONCAT_WS(' ', dr.vName, dr.vLastName)";
const FROM = `driver_log_report dl ${DRIVER_JOIN}`;

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(f: ProviderLogFilters): { where: string; params: unknown[] } {
  const clauses = ["1=1"];
  const params: unknown[] = [];

  if (f.search) {
    const p = escapeLike(f.search);
    clauses.push(`(${DRIVER_EXPR} LIKE ? OR IFNULL(dl.vIP,'') LIKE ?)`);
    params.push(p, p);
  }
  if (f.from) {
    clauses.push("dl.dLoginDateTime >= ?");
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push("dl.dLoginDateTime <= ?");
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const SELECT_COLUMNS = `
  dl.iDriverLogId AS id,
  dl.iDriverId AS driverId,
  ${DRIVER_EXPR} AS driver,
  DATE_FORMAT(dl.dLoginDateTime, '%Y-%m-%d %H:%i:%s') AS loginTime,
  DATE_FORMAT(dl.dLogoutDateTime, '%Y-%m-%d %H:%i:%s') AS logoutTime,
  IF(dl.dLogoutDateTime < '1970-01-01', 0, TIMESTAMPDIFF(SECOND, dl.dLoginDateTime, dl.dLogoutDateTime)) AS durationSeconds,
  IFNULL(dl.vIP, '') AS ip
`;

/** Zero-dates come back from DATE_FORMAT as NULL (or a '0000…' string); flatten to "". */
function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return !v || v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, unknown>): ProviderLogRow {
  return {
    id: Number(r.id),
    driverId: Number(r.driverId ?? 0),
    driver: String(r.driver ?? ""),
    loginTime: cleanDate(r.loginTime),
    logoutTime: cleanDate(r.logoutTime),
    durationSeconds: Number(r.durationSeconds ?? 0),
    ip: String(r.ip ?? ""),
  };
}

export async function listProviderLogSessions(f: ProviderLogFilters): Promise<ProviderLogRow[]> {
  const { where, params } = buildWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM} ${where} ORDER BY dl.dLoginDateTime DESC, dl.iDriverLogId DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countProviderLogSessions(f: ProviderLogFilters): Promise<number> {
  const { where, params } = buildWhere(f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
