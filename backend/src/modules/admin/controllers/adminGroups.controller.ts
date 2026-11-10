import type { Request, Response } from "express";
import * as model from "../models/adminGroups";
import type { AdminGroupStatus } from "../models/adminGroups";
import * as rbac from "../../permissions/services/rbacService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for admin-group lifecycle operations. */
export const GroupEvents = {
  Created: "admin_group_created",
  Updated: "admin_group_updated",
  StatusChanged: "admin_group_status_changed",
  Deleted: "admin_group_deleted",
} as const;

/** The public shape consumed by the admin-group management UI. */
function toDto(r: model.AdminGroupDetail) {
  return {
    id: r.iGroupId,
    name: r.vGroup,
    description: r.vDescription ?? "",
    status: r.eStatus,
    createdAt: r.createdAt,
  };
}

export async function list(_req: Request, res: Response) {
  const rows = await model.listManageable();
  res.json({ groups: rows.map(toDto) });
}

export async function create(req: Request, res: Response) {
  const b = req.body as { name: string; description?: string; status: AdminGroupStatus };
  if (await model.nameTaken(b.name)) {
    throw new AppError(409, "NAME_TAKEN", "An admin group with this name already exists");
  }
  const id = await model.createGroup({
    name: b.name,
    description: b.description ?? null,
    status: b.status,
  });
  audit.logQuiet(req, GroupEvents.Created, {});
  const row = await model.findDetail(id);
  res.status(201).json({ group: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findDetail(id);
  if (!existing) {
    throw AppError.notFound("Admin group not found");
  }
  const b = req.body as { name: string; description?: string; status: AdminGroupStatus };

  if (
    b.name.toLowerCase() !== existing.vGroup.toLowerCase() &&
    (await model.nameTaken(b.name, id))
  ) {
    throw new AppError(409, "NAME_TAKEN", "Another admin group already uses this name");
  }
  // The Super Administrator group must always remain Active.
  if (id === rbac.SUPER_ADMIN_GROUP_ID && b.status !== "Active") {
    throw AppError.badRequest("The Super Administrator group must stay Active");
  }

  await model.updateGroup(id, {
    name: b.name,
    description: b.description ?? null,
    status: b.status,
  });
  audit.logQuiet(req, GroupEvents.Updated, {});
  const row = await model.findDetail(id);
  res.json({ group: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findDetail(id);
  if (!existing) {
    throw AppError.notFound("Admin group not found");
  }
  const { status } = req.body as { status: AdminGroupStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove a group");
  }
  if (id === rbac.SUPER_ADMIN_GROUP_ID && status !== "Active") {
    throw AppError.badRequest("The Super Administrator group must stay Active");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, GroupEvents.StatusChanged, {});
  const row = await model.findDetail(id);
  res.json({ group: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findDetail(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Admin group not found");
  }
  if (id === rbac.SUPER_ADMIN_GROUP_ID) {
    throw AppError.badRequest("The Super Administrator group cannot be deleted");
  }
  const assigned = await model.assignedAdminCount(id);
  if (assigned > 0) {
    throw AppError.badRequest(
      `Cannot delete: ${assigned} administrator(s) still use this group`,
    );
  }

  await model.softDelete(id);
  audit.logQuiet(req, GroupEvents.Deleted, {});
  res.json({ id, deleted: true });
}

