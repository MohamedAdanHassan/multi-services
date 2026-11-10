import { query, execute } from "../../../db/mysql";
import type { AdminGroupRow } from "../../../types/models";

export type AdminGroupStatus = "Active" | "Inactive" | "Deleted";

/** Management view: legacy `admin_groups` joined with its meta side-table. */
export interface AdminGroupDetail {
  iGroupId: number;
  vGroup: string;
  eStatus: AdminGroupStatus;
  vDescription: string | null;
  /** From the side-table; null for legacy rows created before the side-table existed. */
  createdAt: string | null;
}

export interface UpsertGroupInput {
  name: string;
  description: string | null;
  status: AdminGroupStatus;
}

export async function findById(id: number): Promise<AdminGroupRow | null> {
  const rows = await query<AdminGroupRow>(
    "SELECT iGroupId, vGroup, eStatus FROM admin_groups WHERE iGroupId = ? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

export async function findAll(): Promise<AdminGroupRow[]> {
  return query<AdminGroupRow>(
    "SELECT iGroupId, vGroup, eStatus FROM admin_groups WHERE eStatus <> 'Deleted' ORDER BY iGroupId",
  );
}

const DETAIL_SELECT = `
  SELECT g.iGroupId, g.vGroup, g.eStatus, m.vDescription,
         DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS createdAt
    FROM admin_groups g
    LEFT JOIN admin_group_meta m ON m.group_id = g.iGroupId`;

/** Every group (all statuses) with description + created date for the management UI. */
export async function listManageable(): Promise<AdminGroupDetail[]> {
  return query<AdminGroupDetail>(`${DETAIL_SELECT} ORDER BY g.iGroupId`);
}

export async function findDetail(id: number): Promise<AdminGroupDetail | null> {
  const rows = await query<AdminGroupDetail>(`${DETAIL_SELECT} WHERE g.iGroupId = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** Case-insensitive duplicate-name check among non-deleted groups (optionally excluding one id). */
export async function nameTaken(name: string, exceptId?: number): Promise<boolean> {
  const sql = exceptId
    ? `SELECT 1 AS hit FROM admin_groups
        WHERE LCASE(vGroup) = LCASE(?) AND eStatus <> 'Deleted' AND iGroupId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM admin_groups
        WHERE LCASE(vGroup) = LCASE(?) AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [name, exceptId] : [name];
  const rows = await query<{ hit: number }>(sql, params);
  return rows.length > 0;
}

/** Count of non-deleted administrators currently assigned to a group (referential guard). */
export async function assignedAdminCount(groupId: number): Promise<number> {
  const rows = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM administrators WHERE iGroupId = ? AND eStatus <> 'Deleted'`,
    [groupId],
  );
  return Number(rows[0]?.c ?? 0);
}

/** Legacy `admin_groups.iGroupId` has NO AUTO_INCREMENT — derive the next id (MAX + 1). */
export async function nextGroupId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iGroupId) AS max FROM admin_groups",
  );
  return (rows[0]?.max ?? 0) + 1;
}

async function upsertMeta(groupId: number, description: string | null): Promise<void> {
  const desc = description && description.trim() ? description.trim() : null;
  await execute(
    `INSERT INTO admin_group_meta (group_id, vDescription)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE vDescription = VALUES(vDescription)`,
    [groupId, desc],
  );
}

export async function createGroup(input: UpsertGroupInput): Promise<number> {
  const id = await nextGroupId();
  await execute("INSERT INTO admin_groups (iGroupId, vGroup, eStatus) VALUES (?, ?, ?)", [
    id,
    input.name,
    input.status,
  ]);
  await upsertMeta(id, input.description);
  return id;
}

export async function updateGroup(id: number, input: UpsertGroupInput): Promise<void> {
  await execute("UPDATE admin_groups SET vGroup = ?, eStatus = ? WHERE iGroupId = ?", [
    input.name,
    input.status,
    id,
  ]);
  await upsertMeta(id, input.description);
}

export async function setStatus(id: number, status: AdminGroupStatus): Promise<void> {
  await execute("UPDATE admin_groups SET eStatus = ? WHERE iGroupId = ?", [status, id]);
}

/** Soft delete: flag the group 'Deleted' so it leaves the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE admin_groups SET eStatus = 'Deleted' WHERE iGroupId = ?", [id]);
}
