import type { Request, Response } from "express";
import * as perms from "../models/permissions";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

export async function listPermissions(_req: Request, res: Response) {
  res.json(await perms.listPermissions());
}

export async function permissionTree(_req: Request, res: Response) {
  // Hierarchical: display group -> sub group -> permissions.
  res.json(await perms.getPermissionTree());
}

export async function listDisplayGroups(_req: Request, res: Response) {
  res.json(await perms.listDisplayGroups());
}

export async function listDisplaySubGroups(_req: Request, res: Response) {
  res.json(await perms.listDisplaySubGroups());
}

export async function getGroupPermissions(req: Request, res: Response) {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) throw AppError.badRequest("Invalid group id");
  res.json({ groupId, permissionIds: await perms.permissionIdsForGroup(groupId) });
}

export async function setGroupPermissions(req: Request, res: Response) {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) throw AppError.badRequest("Invalid group id");
  const { permissionIds } = req.body as { permissionIds: number[] };

  const before = new Set(await perms.permissionIdsForGroup(groupId));
  const after = new Set(permissionIds as number[]);
  const granted = [...after].filter((id) => !before.has(id));
  const revoked = [...before].filter((id) => !after.has(id));

  await perms.setGroupPermissions(groupId, permissionIds);
  if (granted.length) {
    audit.logQuiet(req, audit.Events.PermissionGranted, {
      adminId: req.auth?.adminId ?? null,
    });
  }
  if (revoked.length) {
    audit.logQuiet(req, audit.Events.PermissionRevoked, {
      adminId: req.auth?.adminId ?? null,
    });
  }
  res.json({ groupId, permissionIds: await perms.permissionIdsForGroup(groupId) });
}
