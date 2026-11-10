import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `backup_database` table (Utility → DB Backup,
 * #sub-133). Rows are metadata about `.sql` dump files written to disk: the
 * stored filename, whether the dump was triggered Manually or by an Auto job,
 * and the creation timestamp. The table's `iBackupId` has NO auto-increment,
 * so inserts must supply MAX+1 themselves (same legacy convention as
 * `register_user`).
 */

export interface BackupRow {
  id: number; // iBackupId
  file: string; // vFile (basename stored on disk)
  type: string; // eType: 'Manual' | 'Auto'
  createdAt: string | null; // dDate, formatted
}

const SELECT_COLUMNS = `iBackupId, vFile, eType,
  DATE_FORMAT(dDate, '%Y-%m-%d %H:%i') AS createdAt`;

/** Map a raw row, treating zero-dates as null (legacy defensive convention). */
function mapRow(r: Record<string, string | number | null>): BackupRow {
  const created = r.createdAt == null ? "" : String(r.createdAt);
  return {
    id: Number(r.iBackupId),
    file: String(r.vFile ?? ""),
    type: String(r.eType ?? ""),
    createdAt: !created || created.startsWith("0000") ? null : created,
  };
}

/** All recorded backups, newest first. */
export async function listBackups(): Promise<BackupRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM backup_database
     ORDER BY dDate DESC, iBackupId DESC`,
  );
  return rows.map(mapRow);
}

/** One backup by id, or null when it does not exist. */
export async function getBackup(id: number): Promise<BackupRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM backup_database WHERE iBackupId = ?`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Insert a backup row (MAX+1 id) and return the new id. */
export async function insertBackup(file: string, type: "Manual" | "Auto"): Promise<number> {
  const rows = await query<{ next: number | string }>(
    `SELECT COALESCE(MAX(iBackupId), 0) + 1 AS next FROM backup_database`,
  );
  const next = Number(rows[0]?.next ?? 1);
  await execute(
    `INSERT INTO backup_database (iBackupId, vFile, eType, dDate) VALUES (?, ?, ?, NOW())`,
    [next, file, type],
  );
  return next;
}

/** Delete one backup row; returns affected rows. */
export async function deleteBackup(id: number): Promise<number> {
  return (await execute(`DELETE FROM backup_database WHERE iBackupId = ?`, [id])).affectedRows;
}
