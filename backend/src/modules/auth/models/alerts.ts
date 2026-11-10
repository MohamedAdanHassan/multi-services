import { query, execute } from "../../../db/mysql";
import type { AdminAlertRow } from "../../../types/models";

/** `admin_alerts` — system alerts / notifications (legacy MyISAM). */

export async function list(opts: { companyId?: number; status?: "Read" | "Unread"; limit?: number } = {}): Promise<AdminAlertRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.companyId !== undefined) {
    where.push("iCompanyId = ?");
    params.push(opts.companyId);
  }
  if (opts.status) {
    where.push("eStatus = ?");
    params.push(opts.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.trunc(opts.limit ?? 100);
  return query<AdminAlertRow>(
    `SELECT * FROM admin_alerts ${whereSql} ORDER BY dDate DESC LIMIT ?`,
    [...params, limit],
  );
}

export async function countUnread(companyId?: number): Promise<number> {
  const sql = companyId
    ? "SELECT COUNT(*) AS c FROM admin_alerts WHERE eStatus = 'Unread' AND iCompanyId = ?"
    : "SELECT COUNT(*) AS c FROM admin_alerts WHERE eStatus = 'Unread'";
  const rows = await query<{ c: number }>(sql, companyId ? [companyId] : []);
  return rows[0]?.c ?? 0;
}

export async function markRead(alertId: number): Promise<void> {
  await execute("UPDATE admin_alerts SET eStatus = 'Read' WHERE iAlertId = ?", [alertId]);
}

export async function create(text: string, companyId: number, driverId: number): Promise<number> {
  const rows = await query<{ max: number }>(
    "SELECT COALESCE(MAX(iAlertId), 0) AS max FROM admin_alerts",
  );
  const nextId = Number(rows[0]?.max ?? 0) + 1;
  await execute(
    `INSERT INTO admin_alerts (iAlertId, tAlertText, iCompanyId, iDriverId, dDate, eStatus)
     VALUES (?, ?, ?, ?, NOW(), 'Unread')`,
    [nextId, text, companyId, driverId],
  );
  return nextId;
}
