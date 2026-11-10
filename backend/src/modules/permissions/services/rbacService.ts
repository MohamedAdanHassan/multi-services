import * as perms from "../models/permissions";
import * as assignments from "../../admin/models/groupAssignments";
import type { AuthPrincipal } from "../../../types/models";

/** Group id 1 is "Super Administrator" in the seeded data — grants everything. */
export const SUPER_ADMIN_GROUP_ID = 1;

/** Merge the primary role with extra assigned roles (de-duplicated). */
export function effectiveRoleIds(primaryGroupId: number, extraGroupIds: number[]): number[] {
  return [...new Set([primaryGroupId, ...extraGroupIds])];
}

/**
 * Check whether `required` is satisfied by any granted permission, supporting:
 *  - super-admin bypass ("*")
 *  - exact match
 *  - trailing-wildcard hierarchy, e.g. granted "admin.*" satisfies "admin.create"
 */
export function matches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted === required) return true;
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -1); // keep the trailing dot
    return required.startsWith(prefix);
  }
  return false;
}

export function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((p) => matches(p, required));
}

export function hasAnyPermission(permissions: string[], required: string[]): boolean {
  return required.some((r) => hasPermission(permissions, r));
}

export function hasAllPermissions(permissions: string[], required: string[]): boolean {
  return required.every((r) => hasPermission(permissions, r));
}

/** Resolve the full role + permission set for an admin from the database. */
export async function resolveAuthorization(
  adminId: number,
  primaryGroupId: number,
): Promise<{ roleIds: number[]; permissions: string[]; isSuperAdmin: boolean }> {
  const extras = await assignments.extraGroupIdsForAdmin(adminId);
  const roleIds = effectiveRoleIds(primaryGroupId, extras);
  const isSuperAdmin = roleIds.includes(SUPER_ADMIN_GROUP_ID);
  const permissions = isSuperAdmin
    ? ["*"]
    : await perms.permissionNamesForGroups(roleIds);
  return { roleIds, permissions, isSuperAdmin };
}

/** Build the request-scoped principal used by the auth middleware. */
export async function buildPrincipal(
  admin: Pick<AuthPrincipal, "adminId" | "groupId" | "email" | "name">,
): Promise<AuthPrincipal> {
  const { roleIds, permissions } = await resolveAuthorization(admin.adminId, admin.groupId);
  return { ...admin, roleIds, permissions };
}
