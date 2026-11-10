import type { Request } from "express";
import { env } from "../../../config/env";
import * as admins from "../models/administrators";
import * as loginState from "../models/loginState";
import * as refreshStore from "../models/refreshTokens";
import * as resets from "../models/passwordResets";
import * as pwd from "./passwordService";
import * as token from "./tokenService";
import * as rbac from "../../permissions/services/rbacService";
import * as audit from "../../audit/services/auditService";
import { sha256, timingSafeEqualHex } from "../../../utils/crypto";
import { clientIp, userAgent } from "../../../utils/http";
import { AppError } from "../../../errors/AppError";
import type { AuthPrincipal } from "../../../types/models";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export type PublicAdmin = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  groupId: number;
};

function toPublicAdmin(a: admins.AdminSummary): PublicAdmin {
  return {
    id: a.iAdminId,
    firstName: a.vFirstName,
    lastName: a.vLastName,
    email: a.vEmail,
    groupId: a.iGroupId,
  };
}

async function buildPrincipal(a: admins.AdminSummary): Promise<AuthPrincipal> {
  return rbac.buildPrincipal({
    adminId: a.iAdminId,
    groupId: a.iGroupId,
    email: a.vEmail,
    name: `${a.vFirstName} ${a.vLastName}`.trim(),
  });
}

/** Issue an access token and a freshly-stored refresh token (same family). */
async function issueTokens(
  req: Request,
  adminId: number,
  groupId: number,
  familyId?: string,
): Promise<TokenPair> {
  const accessToken = token.signAccessToken(adminId, groupId);
  const rt = token.signRefreshToken(adminId, familyId);
  await refreshStore.create({
    adminId,
    tokenHash: rt.tokenHash,
    familyId: rt.familyId,
    ip: clientIp(req),
    userAgent: userAgent(req),
    expiresAt: rt.expiresAt,
  });
  return {
    accessToken,
    refreshToken: rt.token,
    accessExpiresIn: env.jwt.accessTtlSeconds,
  };
}

export type LoginOutcome =
  | { status: "ok"; tokens: TokenPair; admin: PublicAdmin; principal: AuthPrincipal }
  | { status: "invalid" }
  | { status: "locked"; lockedUntil: Date };

export async function login(
  req: Request,
  input: { email: string; password: string },
): Promise<LoginOutcome> {
  const admin = await admins.findByEmail(input.email);
  if (!admin || admin.eStatus !== "Active") {
    // Enumeration-safe: identical response for unknown/inactive email and bad password.
    await audit.log(req, audit.Events.LoginFailed, { email: input.email });
    return { status: "invalid" };
  }

  const state = await loginState.get(admin.iAdminId);
  if (state?.locked_until && state.locked_until.getTime() > Date.now()) {
    await audit.log(req, audit.Events.AccountLocked, {
      adminId: admin.iAdminId,
      email: admin.vEmail,
    });
    return { status: "locked", lockedUntil: state.locked_until };
  }

  const passwordOk = await pwd.verifyPassword(input.password, admin.vPassword);
  if (!passwordOk) {
    const after = await loginState.recordFailure(
      admin.iAdminId,
      env.lockout.maxFailedAttempts,
      env.lockout.lockMinutes,
    );
    await audit.log(req, audit.Events.LoginFailed, {
      adminId: admin.iAdminId,
      email: admin.vEmail,
    });
    if (after.locked_until && after.locked_until.getTime() > Date.now()) {
      return { status: "locked", lockedUntil: after.locked_until };
    }
    return { status: "invalid" };
  }

  // Transparently upgrade legacy / lower-cost hashes on successful login.
  if (pwd.shouldRehash(admin.vPassword)) {
    await admins.updatePasswordHash(admin.iAdminId, await pwd.hashPassword(input.password));
  }
  await loginState.recordSuccess(admin.iAdminId);

  const principal = await buildPrincipal(admin);
  const tokens = await issueTokens(req, admin.iAdminId, admin.iGroupId);
  await audit.log(req, audit.Events.LoginSuccess, {
    adminId: admin.iAdminId,
    email: admin.vEmail,
  });
  return { status: "ok", tokens, admin: toPublicAdmin(admin), principal };
}

export async function refresh(
  req: Request,
  refreshToken: string,
): Promise<{ tokens: TokenPair; principal: AuthPrincipal; admin: PublicAdmin }> {
  let claims;
  try {
    claims = token.verifyRefreshToken(refreshToken);
  } catch {
    throw AppError.unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  const adminId = Number(claims.sub);
  const row = await refreshStore.findByHash(sha256(refreshToken));
  if (!row) {
    throw AppError.unauthorized("Refresh token not recognized", "UNKNOWN_REFRESH_TOKEN");
  }

  // Reuse detection: a token that verifies but is already revoked means the
  // family has been stolen/replayed — revoke the whole family.
  if (row.revoked_at) {
    await refreshStore.revokeFamily(row.family_id);
    await audit.log(req, audit.Events.TokenReuseDetected, { adminId });
    throw AppError.unauthorized("Refresh token reuse detected", "REFRESH_REUSE");
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw AppError.unauthorized("Refresh token expired", "REFRESH_EXPIRED");
  }

  const admin = await admins.findById(adminId);
  if (!admin || admin.eStatus !== "Active") {
    await refreshStore.revokeFamily(row.family_id);
    throw AppError.unauthorized("Account no longer eligible", "ACCOUNT_INVALID");
  }

  // Rotate: revoke the used token, mint a replacement within the same family.
  const fresh = await issueTokens(req, adminId, admin.iGroupId, row.family_id);
  const newHash = sha256(fresh.refreshToken);
  await refreshStore.revokeById(row.id, newHash);
  await audit.log(req, audit.Events.TokenRefresh, { adminId, email: admin.vEmail });

  return { tokens: fresh, principal: await buildPrincipal(admin), admin: toPublicAdmin(admin) };
}

export async function logout(req: Request, refreshToken: string | undefined): Promise<void> {
  const auth = req.auth;
  if (refreshToken) {
    const row = await refreshStore.findByHash(sha256(refreshToken));
    if (row) await refreshStore.revokeById(row.id);
  }
  await audit.log(req, audit.Events.Logout, {
    adminId: auth?.adminId ?? null,
    email: auth?.email ?? null,
  });
}

export async function forgotPassword(
  req: Request,
  email: string,
): Promise<{ resetToken?: string; resetUrl?: string }> {
  const admin = await admins.findByEmail(email);
  if (!admin || admin.eStatus !== "Active") {
    await audit.log(req, audit.Events.PasswordResetNotFound, { email });
    // Return a generic success to avoid account enumeration.
    return {};
  }
  const issued = token.createResetToken(admin.iAdminId);
  await resets.upsert(admin.iAdminId, issued.tokenHash, issued.expiresAt);
  await audit.log(req, audit.Events.PasswordResetRequested, {
    adminId: admin.iAdminId,
    email: admin.vEmail,
  });
  const resetUrl = `${env.publicUrl}/api/auth/reset-password?token=${encodeURIComponent(issued.raw)}`;
  // In non-production we surface the token so the flow is testable without email.
  if (!env.isProd) return { resetToken: issued.raw, resetUrl };
  // Production: `resetToken` is withheld; `resetUrl` would be emailed by a queue.
  return { resetUrl };
}

export async function resetPassword(
  req: Request,
  input: { token: string; newPassword: string },
): Promise<void> {
  const parsed = token.parseResetToken(input.token);
  if (!parsed.ok) {
    await audit.log(req, audit.Events.PasswordResetInvalidInput);
    throw AppError.badRequest("Invalid reset token");
  }
  const row = await resets.findByAdmin(parsed.adminId);
  if (!row) {
    await audit.log(req, audit.Events.PasswordResetNotFound, { adminId: parsed.adminId });
    throw AppError.badRequest("Reset token is not valid");
  }
  if (row.expires_at.getTime() <= Date.now()) {
    await resets.deleteForAdmin(parsed.adminId);
    await audit.log(req, audit.Events.PasswordResetFailed, { adminId: parsed.adminId });
    throw AppError.badRequest("Reset token has expired");
  }
  if (row.attempts >= env.password.resetMaxAttempts) {
    await resets.deleteForAdmin(parsed.adminId);
    await audit.log(req, audit.Events.PasswordResetFailed, { adminId: parsed.adminId });
    throw AppError.tooMany("Too many attempts; request a new reset link", "RESET_ATTEMPTS");
  }
  if (!timingSafeEqualHex(sha256(input.token), row.token_hash)) {
    await resets.incrementAttempts(parsed.adminId);
    await audit.log(req, audit.Events.PasswordResetFailed, { adminId: parsed.adminId });
    throw AppError.badRequest("Reset token is not valid");
  }

  const admin = await admins.findById(parsed.adminId);
  if (!admin || admin.eStatus !== "Active") {
    throw AppError.badRequest("Account is not eligible");
  }

  const hash = await pwd.hashPassword(input.newPassword);
  await admins.updatePasswordHash(admin.iAdminId, hash);
  await resets.deleteForAdmin(admin.iAdminId);
  await refreshStore.revokeAllForAdmin(admin.iAdminId); // force re-login everywhere
  await loginState.clearLock(admin.iAdminId);
  await audit.log(req, audit.Events.PasswordResetSuccess, {
    adminId: admin.iAdminId,
    email: admin.vEmail,
  });
}

export async function currentPrincipal(req: Request): Promise<AuthPrincipal> {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}
