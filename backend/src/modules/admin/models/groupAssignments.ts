import { query, withTransaction } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";

/**
 * Extra role assignments (NEW additive InnoDB table `admin_admin_group`).
 * `administrators` only stores one primary group via iGroupId; this side table
 * grants additional roles so the effective role set is [primary, ...extras].
 */

export async function extraGroupIdsForAdmin(adminId: number): Promise<number[]> {
  const rows = await query<{ group_id: number }>(
    "SELECT group_id FROM admin_admin_group WHERE admin_id = ?",
    [adminId],
  );
  return rows.map((r) => r.group_id);
}

export async function setExtraGroups(adminId: number, groupIds: number[]): Promise<void> {
  const unique = [...new Set(groupIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
  await withTransaction(async (conn) => {
    await conn.execute("DELETE FROM admin_admin_group WHERE admin_id = ?", [adminId]);
    if (unique.length === 0) return;
    const [maxRows] = await conn.query<RowDataPacket[]>(
      "SELECT COALESCE(MAX(id), 0) AS max FROM admin_admin_group",
    );
    let nextId = Number((maxRows[0] as { max: number }).max ?? 0);
    for (const gid of unique) {
      nextId += 1;
      await conn.execute(
        "INSERT INTO admin_admin_group (id, admin_id, group_id) VALUES (?, ?, ?)",
        [nextId, adminId, gid],
      );
    }
  });
}
