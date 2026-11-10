import type { Request, Response } from "express";
import * as model from "../models/adminsModel";
import type { AdminStatus } from "../models/adminsModel";
import * as pwd from "../../auth/services/passwordService";
import * as groups from "../models/adminGroups";
import * as rbac from "../../permissions/services/rbacService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit event names for administrator lifecycle operations (extendable strings). */
export const AdminEvents = {
  Created: "admin_created",
  Updated: "admin_updated",
  StatusChanged: "admin_status_changed",
  Deleted: "admin_deleted",
} as const;

/** The public shape consumed by the admin-management UI. */
function toDto(r: model.AdminRow) {
  const first = r.vFirstName ?? "";
  const last = r.vLastName ?? "";
  return {
    id: r.iAdminId,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    email: r.vEmail,
    groupId: r.iGroupId,
    groupName: r.groupName ?? `Group #${r.iGroupId}`,
    status: r.eStatus,
    // Legacy `administrators` has no created-date column — surfaced honestly as null.
    createdAt: null as string | null,
  };
}

function currentAdminId(req: Request): number {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.adminId;
}

function isSuperAdmin(req: Request): boolean {
  return !!req.auth?.roleIds.includes(rbac.SUPER_ADMIN_GROUP_ID);
}

interface WriteBody {
  firstName: string;
  lastName: string;
  email: string;
  groupId: number;
  status: AdminStatus;
}

export async function list(_req: Request, res: Response) {
  const rows = await model.listManageable();
  res.json({ admins: rows.map(toDto) });
}

export async function create(req: Request, res: Response) {
  const b = req.body as WriteBody & { password: string };

  if (await model.emailTaken(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "An administrator with this email already exists");
  }
  const group = await groups.findById(b.groupId);
  if (!group) throw AppError.badRequest("Unknown role/group id");
  // Only a super administrator may mint another super administrator.
  if (b.groupId === rbac.SUPER_ADMIN_GROUP_ID && !isSuperAdmin(req)) {
    throw AppError.forbidden(
      "Only a super administrator can create a super administrator",
      "FORBIDDEN_ROLE",
    );
  }

  const id = await model.createAdmin({
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    passwordHash: await pwd.hashPassword(b.password),
    groupId: b.groupId,
    status: b.status,
  });
  audit.logQuiet(req, AdminEvents.Created, { adminId: id, email: b.email });

  const row = await model.findRow(id);
  res.status(201).json({ admin: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Administrator not found");
  }
  const b = req.body as WriteBody;

  if (b.email !== existing.vEmail && (await model.emailTaken(b.email, id))) {
    throw new AppError(409, "EMAIL_TAKEN", "That email is already used by another administrator");
  }
  const group = await groups.findById(b.groupId);
  if (!group) throw AppError.badRequest("Unknown role/group id");

  const selfId = currentAdminId(req);
  const editingSelf = id === selfId;
  if (editingSelf && b.status !== "Active") {
    throw AppError.badRequest("You cannot deactivate your own account");
  }
  if (
    editingSelf &&
    existing.iGroupId === rbac.SUPER_ADMIN_GROUP_ID &&
    b.groupId !== rbac.SUPER_ADMIN_GROUP_ID
  ) {
    throw AppError.badRequest("You cannot remove your own super-administrator role");
  }
  if (b.groupId === rbac.SUPER_ADMIN_GROUP_ID && !isSuperAdmin(req)) {
    throw AppError.forbidden(
      "Only a super administrator can grant the super-administrator role",
      "FORBIDDEN_ROLE",
    );
  }

  await model.updateAdmin(id, {
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    groupId: b.groupId,
    status: b.status,
  });
  audit.logQuiet(req, AdminEvents.Updated, { adminId: id, email: b.email });

  const row = await model.findRow(id);
  res.json({ admin: row ? toDto(row) : null });
}

export async function toggleStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Administrator not found");
  }
  const { status } = req.body as { status: AdminStatus };
  if (status === "Deleted") {
    throw AppError.badRequest("Use the delete action to remove an account");
  }
  if (id === currentAdminId(req) && status !== "Active") {
    throw AppError.badRequest("You cannot deactivate your own account");
  }

  await model.setStatus(id, status);
  audit.logQuiet(req, AdminEvents.StatusChanged, { adminId: id, email: existing.vEmail });

  const row = await model.findRow(id);
  res.json({ admin: row ? toDto(row) : null });
}

export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findRow(id);
  if (!existing || existing.eStatus === "Deleted") {
    throw AppError.notFound("Administrator not found");
  }
  if (id === currentAdminId(req)) {
    throw AppError.badRequest("You cannot delete your own account");
  }

  await model.softDelete(id);
  audit.logQuiet(req, AdminEvents.Deleted, { adminId: id, email: existing.vEmail });
  res.json({ id, deleted: true });
}

