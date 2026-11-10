import type { NextFunction, Request, Response } from "express";
import * as rbac from "../modules/permissions/services/rbacService";
import * as locations from "../modules/admin/models/locations";
import { AppError } from "../errors/AppError";

function guard(req: Request): asserts req is Request & { auth: NonNullable<Request["auth"]> } {
  if (!req.auth) throw AppError.unauthorized();
}

/** Require a single permission (supports wildcard hierarchy). */
export function requirePermission(required: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      guard(req);
      if (!rbac.hasPermission(req.auth.permissions, required)) {
        throw AppError.forbidden(`Missing permission: ${required}`, "FORBIDDEN_PERMISSION");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require at least one of the given permissions. */
export function requireAnyPermission(required: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      guard(req);
      if (!rbac.hasAnyPermission(req.auth.permissions, required)) {
        throw AppError.forbidden("Insufficient permissions", "FORBIDDEN_PERMISSION");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require all of the given permissions. */
export function requireAllPermissions(required: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      guard(req);
      if (!rbac.hasAllPermissions(req.auth.permissions, required)) {
        throw AppError.forbidden("Insufficient permissions", "FORBIDDEN_PERMISSION");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require membership in one of the given role (group) ids. */
export function requireRoles(groupIds: number[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      guard(req);
      if (rbac.SUPER_ADMIN_GROUP_ID && req.auth.roleIds.includes(rbac.SUPER_ADMIN_GROUP_ID)) {
        return next(); // super admin passes role checks
      }
      if (!req.auth.roleIds.some((g) => groupIds.includes(g))) {
        throw AppError.forbidden("Insufficient role", "FORBIDDEN_ROLE");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Location-scoped access control: the request must reference a location id
 * (via `paramName`, default `locationId`) that the admin is assigned to.
 * Super administrators bypass.
 */
export function requireLocation(paramName = "locationId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      guard(req);
      const raw = (req.params as Record<string, string>)[paramName];
      const locationId = Number(raw);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        throw AppError.badRequest("Invalid location id");
      }
      const isSuper = req.auth.roleIds.includes(rbac.SUPER_ADMIN_GROUP_ID);
      if (isSuper) return next();
      if (!(await locations.hasLocationAccess(req.auth.adminId, locationId))) {
        throw AppError.forbidden("No access to this location", "FORBIDDEN_LOCATION");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
