import { query, execute } from "../../../db/mysql";

/**
 * Blocked account listing for the Reports → "Decline/Cancelled Alerts" page
 * (display sub-group 101). The legacy panel tracks block state directly on the
 * account rows via `eIsBlocked` ('Yes'/'No') + `tBlockeddate`, rather than a
 * dedicated table, so the two legs (drivers / riders) read the same two
 * register_* tables the rest of the admin uses.
 */
export type BlockedKind = "driver" | "rider";

export interface BlockedFilters {
  search: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export interface BlockedUserRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  accountStatus: string;
  blockedAt: string;
}

type KindConfig = {
  table: string;
  idCol: string;
  /** Driver rows have no country-code column; riders concatenate vPhoneCode. */
  phoneSql: string;
};

const KINDS: Record<BlockedKind, KindConfig> = {
  driver: {
    table: "register_driver",
    idCol: "iDriverId",
    phoneSql: "IFNULL(vPhone, '')",
  },
  rider: {
    table: "register_user",
    idCol: "iUserId",
    phoneSql: "CONCAT(IFNULL(vPhoneCode, ''), IFNULL(vPhone, ''))",
  },
};

/**
 * Format the block timestamp as a string. The column is a TIMESTAMP that legacy
 * rows leave at the zero value, and `DATE_FORMAT` renders that as the literal
 * string '0000-00-00 00:00' (NOT NULL) — mapRow blanks it out. Writing a
 * zero-date literal into the query instead would be rejected by the server's
 * strict sql_mode.
 */
function blockedAtSql(): string {
  return "DATE_FORMAT(tBlockeddate, '%Y-%m-%d %H:%i') AS blockedAt";
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Build the shared `WHERE … ?` fragment for a listing/count. Ordering of the
 * returned params must match the SQL fragment exactly.
 */
function buildWhere(kind: BlockedKind, f: BlockedFilters): { where: string; params: unknown[] } {
  const cfg = KINDS[kind];
  const clauses = [`eIsBlocked = 'Yes'`, `eStatus <> 'Deleted'`];
  const params: unknown[] = [];

  if (f.search) {
    clauses.push(
      `(CONCAT_WS(' ', vName, vLastName) LIKE ? OR vEmail LIKE ? OR ${cfg.phoneSql} LIKE ?)`,
    );
    const p = escapeLike(f.search);
    params.push(p, p, p);
  }
  if (f.from) {
    clauses.push(`tBlockeddate >= ?`);
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    clauses.push(`tBlockeddate <= ?`);
    params.push(`${f.to} 23:59:59`);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function selectColumns(kind: BlockedKind): string {
  const cfg = KINDS[kind];
  return [
    `${cfg.idCol} AS id`,
    `CONCAT_WS(' ', vName, vLastName) AS name`,
    `IFNULL(vEmail, '') AS email`,
    `${cfg.phoneSql} AS phone`,
    `IFNULL(eStatus, '') AS accountStatus`,
    blockedAtSql(),
  ].join(", ");
}

function mapRow(r: Record<string, unknown>): BlockedUserRow {
  // A legacy zero-date formats to '0000-00-00 …' rather than NULL, so blank it
  // here (the same guard the other report models apply) and let the UI show "—".
  const blockedAt = String(r.blockedAt ?? "");
  return {
    id: Number(r.id),
    name: String(r.name ?? "").trim(),
    email: String(r.email ?? ""),
    phone: String(r.phone ?? ""),
    accountStatus: String(r.accountStatus ?? ""),
    blockedAt: blockedAt.startsWith("0000") ? "" : blockedAt,
  };
}

export async function listBlocked(
  kind: BlockedKind,
  f: BlockedFilters,
): Promise<BlockedUserRow[]> {
  const cfg = KINDS[kind];
  const { where, params } = buildWhere(kind, f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(kind)} FROM ${cfg.table} ${where} ` +
      `ORDER BY tBlockeddate DESC, ${cfg.idCol} DESC LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

export async function countBlocked(kind: BlockedKind, f: BlockedFilters): Promise<number> {
  const cfg = KINDS[kind];
  const { where, params } = buildWhere(kind, f);
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${cfg.table} ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Cap for a CSV export so a broad filter can't stream an unbounded result. */
const EXPORT_CAP = 20000;

/** All blocked accounts matching the filters (no paging) for CSV export. */
export async function exportBlocked(kind: BlockedKind, f: BlockedFilters): Promise<BlockedUserRow[]> {
  const cfg = KINDS[kind];
  const { where, params } = buildWhere(kind, f);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(kind)} FROM ${cfg.table} ${where} ` +
      `ORDER BY tBlockeddate DESC, ${cfg.idCol} DESC LIMIT ?`,
    [...params, EXPORT_CAP],
  );
  return rows.map(mapRow);
}

/** Fetch a single account row (blocked or not) so unblock can distinguish 404 vs not-blocked. */
export async function getAccountById(kind: BlockedKind, id: number): Promise<BlockedUserRow | null> {
  const cfg = KINDS[kind];
  const rows = await query<Record<string, unknown>>(
    `SELECT ${selectColumns(kind)} FROM ${cfg.table} WHERE ${cfg.idCol} = ? LIMIT 1`,
    [id],
  );
  return rows.length === 0 ? null : mapRow(rows[0]);
}

/** Flip the account back to un-blocked. Returns affectedRows. */
export async function unblockById(kind: BlockedKind, id: number): Promise<number> {
  const cfg = KINDS[kind];
  const res = await execute(
    `UPDATE ${cfg.table} SET eIsBlocked = 'No' WHERE ${cfg.idCol} = ?`,
    [id],
  );
  return res.affectedRows;
}

/** Whether the account is currently blocked (raw eIsBlocked value). */
export async function isBlocked(kind: BlockedKind, id: number): Promise<boolean> {
  const cfg = KINDS[kind];
  const rows = await query<{ eIsBlocked: string }>(
    `SELECT eIsBlocked FROM ${cfg.table} WHERE ${cfg.idCol} = ? LIMIT 1`,
    [id],
  );
  return rows[0]?.eIsBlocked === "Yes";
}
