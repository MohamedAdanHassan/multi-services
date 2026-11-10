import type { Request } from "express";
import * as audit from "../models/auditLog";
import { maskEmail } from "../../../utils/crypto";
import { clientIp, userAgent } from "../../../utils/http";

/** Canonical audit event names (matching the pre-seeded vocabulary). */
export const Events = {
  LoginSuccess: "login_success",
  LoginFailed: "login_failed",
  LoginInvalidInput: "login_invalid_input",
  LoginRateLimited: "login_rate_limited",
  AccountLocked: "account_locked",
  Logout: "logout",
  TokenRefresh: "token_refresh",
  TokenReuseDetected: "token_reuse_detected",
  PasswordResetRequested: "password_reset_requested",
  PasswordResetSuccess: "password_reset_success",
  PasswordResetFailed: "password_reset_failed",
  PasswordResetInvalidInput: "password_reset_invalid_input",
  PasswordResetNotFound: "password_reset_not_found",
  AccessDenied: "access_denied",
  PermissionGranted: "permission_granted",
  PermissionRevoked: "permission_revoked",
  RoleAssigned: "role_assigned",
  LocationAssigned: "location_assigned",
} as const;

/** Record an audit entry enriched with the request's IP / user-agent. */
export async function log(
  req: Request,
  event: string,
  opts: { adminId?: number | null; email?: string | null } = {},
): Promise<void> {
  await audit.record(event, {
    adminId: opts.adminId ?? null,
    emailMasked: opts.email ? maskEmail(opts.email) : null,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });
}

/**
 * Non-blocking audit for CRUD mutations: the response should not wait on the
 * audit INSERT. Snapshots the request fields synchronously (Express reuses
 * `req` internally), then writes in the background; failures are logged, never
 * thrown back into the request. Security-critical events (login, lockout,
 * token reuse) must keep using awaited `log()`.
 */
export function logQuiet(
  req: Request,
  event: string,
  opts: { adminId?: number | null; email?: string | null } = {},
): void {
  const entry = {
    adminId: opts.adminId ?? null,
    emailMasked: opts.email ? maskEmail(opts.email) : null,
    ip: clientIp(req),
    userAgent: userAgent(req),
  };
  audit.record(event, entry).catch((err: unknown) => {
    console.error(`audit write failed (${event}):`, err);
  });
}
