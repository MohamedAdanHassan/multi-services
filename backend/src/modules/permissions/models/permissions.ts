import { query, withTransaction } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";
import type {
  PermissionRow,
  PermissionDisplayGroupRow,
  PermissionDisplaySubGroupRow,
} from "../../../types/models";

/**
 * Resolve the set of active permission names granted to any of the given role
 * (group) ids. This unions the legacy `admin_pro_group_permission` mapping across
 * a set of groups, which lets an admin combine its primary role with extra roles.
 */
export async function permissionNamesForGroups(groupIds: number[]): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const placeholders = groupIds.map(() => "?").join(",");
  const rows = await query<{ permission_name: string }>(
    `SELECT DISTINCT p.permission_name
       FROM admin_pro_permissions p
       JOIN admin_pro_group_permission gp ON gp.permission_id = p.id
      WHERE gp.group_id IN (${placeholders})
        AND p.status = 'Active'`,
    groupIds,
  );
  return rows.map((r) => r.permission_name);
}

export async function permissionIdsForGroup(groupId: number): Promise<number[]> {
  const rows = await query<{ permission_id: number }>(
    "SELECT permission_id FROM admin_pro_group_permission WHERE group_id = ?",
    [groupId],
  );
  return rows.map((r) => r.permission_id);
}

/** Replace a group's permission set (idempotent, wrapped in a transaction). */
export async function setGroupPermissions(groupId: number, permissionIds: number[]): Promise<void> {
  const unique = [...new Set(permissionIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
  await withTransaction(async (conn) => {
    await conn.execute("DELETE FROM admin_pro_group_permission WHERE group_id = ?", [groupId]);
    if (unique.length === 0) return;
    // `id` has no AUTO_INCREMENT in the legacy table; derive fresh ids in one pass.
    const [maxRows] = await conn.query<RowDataPacket[]>(
      "SELECT COALESCE(MAX(id), 0) AS max FROM admin_pro_group_permission",
    );
    let nextId = Number((maxRows[0] as { max: number }).max ?? 0);
    for (const pid of unique) {
      nextId += 1;
      await conn.execute(
        "INSERT INTO admin_pro_group_permission (id, group_id, permission_id) VALUES (?, ?, ?)",
        [nextId, groupId, pid],
      );
    }
  });
}

export async function listPermissions(): Promise<PermissionRow[]> {
  return query<PermissionRow>(
    `SELECT id, permission_name, name, status, display_group_id, display_sub_group_id,
            display_order, vDispalyAppType, eFor, eType
       FROM admin_pro_permissions
      WHERE status = 'Active'
      ORDER BY display_group_id, display_sub_group_id, display_order`,
  );
}

/** Hierarchical structure: display groups -> sub groups -> permissions. */
export async function listDisplayGroups(): Promise<PermissionDisplayGroupRow[]> {
  return query<PermissionDisplayGroupRow>(
    `SELECT id, name, eStatus, vDispalyAppType, eFor, display_order
       FROM admin_pro_permission_display_groups
      WHERE eStatus = 'Active'
      ORDER BY display_order`,
  );
}

export async function listDisplaySubGroups(): Promise<PermissionDisplaySubGroupRow[]> {
  return query<PermissionDisplaySubGroupRow>(
    `SELECT id, name, eStatus, vDispalyAppType, eFor, iGroupsId, display_order
       FROM admin_pro_permission_display_sub_groups
      WHERE eStatus = 'Active'
      ORDER BY iGroupsId, display_order`,
  );
}

/**
 * Build the full permission tree grouped by display group and sub-group.
 * Useful for rendering an admin permission matrix in the UI.
 *
 * Permissions are attached either to a sub-group (display_sub_group_id = <id>)
 * or directly to the display group (display_sub_group_id = 0, or a sub-group
 * that is inactive/deleted). Group-level permissions are surfaced on the
 * group's own `permissions` array so modules like "Dashboard" (id 35), which
 * have no sub-groups, still render their contents.
 */
export async function getPermissionTree() {
  const [perms, groups, subGroups] = await Promise.all([
    listPermissions(),
    listDisplayGroups(),
    listDisplaySubGroups(),
  ]);
  return groups.map((g) => {
    const groupSubs = subGroups.filter((s) => s.iGroupsId === g.id);
    const activeSubIds = new Set(groupSubs.map((s) => s.id));
    const groupPerms = perms.filter((p) => p.display_group_id === g.id);
    const shape = (p: PermissionRow) => ({
      id: p.id,
      name: p.name,
      permission_name: p.permission_name,
    });
    return {
      ...g,
      // Permissions that belong to the group but not to any active sub-group.
      permissions: groupPerms
        .filter((p) => !activeSubIds.has(p.display_sub_group_id))
        .map(shape),
      subGroups: groupSubs.map((s) => ({
        ...s,
        permissions: groupPerms
          .filter((p) => p.display_sub_group_id === s.id)
          .map(shape),
      })),
    };
  });
}

