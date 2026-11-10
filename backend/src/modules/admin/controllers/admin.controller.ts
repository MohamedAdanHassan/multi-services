import type { Request, Response } from "express";
import * as admins from "../../auth/models/administrators";
import * as groups from "../models/adminGroups";
import * as assignments from "../models/groupAssignments";
import * as locations from "../models/locations";
import * as loginState from "../../auth/models/loginState";
import * as pwd from "../../auth/services/passwordService";
import * as rbac from "../../permissions/services/rbacService";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

export async function list(_req: Request, res: Response) {
  res.json(await admins.list());
}

export async function listGroups(_req: Request, res: Response) {
  res.json(await groups.findAll());
}

export async function get(req: Request, res: Response) {
  const id = Number(req.params.id);
  const admin = await admins.findById(id);
  if (!admin) throw AppError.notFound("Administrator not found");
  const auth = await rbac.resolveAuthorization(admin.iAdminId, admin.iGroupId);
  res.json({
    id: admin.iAdminId,
    firstName: admin.vFirstName,
    lastName: admin.vLastName,
    email: admin.vEmail,
    status: admin.eStatus,
    roles: auth.roleIds,
    permissions: auth.permissions,
  });
}

export async function create(req: Request, res: Response) {
  const b = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    contactNo?: string;
    code?: string;
    groupId: number;
    password: string;
  };
  if (await admins.findByEmail(b.email)) {
    throw new AppError(409, "EMAIL_TAKEN", "A administrator with this email already exists");
  }
  const group = await groups.findById(b.groupId);
  if (!group) throw AppError.badRequest("Unknown group/role id");

  const id = await admins.create({
    firstName: b.firstName,
    lastName: b.lastName,
    email: b.email,
    contactNo: b.contactNo ?? "",
    code: b.code ?? "",
    groupId: b.groupId,
    passwordHash: await pwd.hashPassword(b.password),
  });
  res.status(201).json({ id });
}

/** Assign additional roles (multi-role support) via the side table. */
export async function assignRoles(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await admins.findById(id))) throw AppError.notFound("Administrator not found");
  const { groupIds } = req.body as { groupIds: number[] };

  // Validate each referenced group exists.
  const all = await groups.findAll();
  const valid = new Set(all.map((g) => g.iGroupId));
  for (const gid of groupIds) {
    if (!valid.has(gid)) throw AppError.badRequest(`Unknown group id: ${gid}`);
  }

  await assignments.setExtraGroups(id, groupIds);
  audit.logQuiet(req, audit.Events.RoleAssigned, { adminId: id });
  const updated = await rbac.resolveAuthorization(id, (await admins.findById(id))!.iGroupId);
  res.json({ adminId: id, roles: updated.roleIds, permissions: updated.permissions });
}

/** Assign location-based access control. */
export async function assignLocations(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await admins.findById(id))) throw AppError.notFound("Administrator not found");
  const { locationIds } = req.body as { locationIds: number[] };
  await locations.assignLocations(id, locationIds);
  audit.logQuiet(req, audit.Events.LocationAssigned, { adminId: id });
  res.json({ adminId: id, locationIds: await locations.locationIdsForAdmin(id) });
}

export async function getLocations(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await admins.findById(id))) throw AppError.notFound("Administrator not found");
  res.json({ adminId: id, locationIds: await locations.locationIdsForAdmin(id) });
}

/** Manually clear an account lock. */
export async function unlockAccount(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!(await admins.findById(id))) throw AppError.notFound("Administrator not found");
  await loginState.clearLock(id);
  res.json({ adminId: id, unlocked: true });
}
