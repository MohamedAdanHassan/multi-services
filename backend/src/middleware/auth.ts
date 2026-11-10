import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/services/tokenService";
import * as rbac from "../modules/permissions/services/rbacService";
import * as admins from "../modules/auth/models/administrators";
import { ACCESS_COOKIE } from "../utils/http";
import { AppError } from "../errors/AppError";

/** Extract a bearer token from the Authorization header, if present. */
function fromHeader(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

/** Resolve the current admin's principal from the access token, or throw. */
async function resolve(req: Request): Promise<void> {
  const raw = (req.cookies && req.cookies[ACCESS_COOKIE]) || fromHeader(req);
  if (!raw) throw AppError.unauthorized("Missing access token", "NO_TOKEN");

  let claims;
  try {
    claims = verifyAccessToken(raw);
  } catch {
    throw AppError.unauthorized("Invalid or expired access token", "INVALID_TOKEN");
  }

  const admin = await admins.findById(Number(claims.sub));
  if (!admin || admin.eStatus !== "Active") {
    throw AppError.unauthorized("Account is not eligible", "ACCOUNT_INVALID");
  }
  req.auth = await rbac.buildPrincipal({
    adminId: admin.iAdminId,
    groupId: admin.iGroupId,
    email: admin.vEmail,
    name: `${admin.vFirstName} ${admin.vLastName}`.trim(),
  });
}

/** Require a valid authenticated admin. */
export function requireAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await resolve(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attach req.auth when a token is present, but never reject. */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await resolve(req);
    } catch {
      /* anonymous */
    }
    next();
  };
}
