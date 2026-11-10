import type { Request, Response } from "express";
import * as auth from "../services/authService";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "../../../utils/http";
import { AppError } from "../../../errors/AppError";

function setTokenCookies(res: Response, tokens: auth.TokenPair) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, accessCookieOptions());
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions());
}

function clearTokenCookies(res: Response) {
  const opts = { httpOnly: true, secure: accessCookieOptions().secure, sameSite: accessCookieOptions().sameSite };
  res.clearCookie(ACCESS_COOKIE, { ...opts, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...opts, path: "/api/auth" });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };
  const outcome = await auth.login(req, { email, password });

  if (outcome.status === "invalid") {
    throw AppError.unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
  }
  if (outcome.status === "locked") {
    return res.status(423).json({
      error: {
        code: "ACCOUNT_LOCKED",
        message: "Account temporarily locked after too many failed attempts",
        lockedUntil: outcome.lockedUntil.toISOString(),
      },
    });
  }

  setTokenCookies(res, outcome.tokens);
  res.status(200).json({
    admin: outcome.admin,
    roles: outcome.principal.roleIds,
    permissions: outcome.principal.permissions,
    accessTokenExpiresIn: outcome.tokens.accessExpiresIn,
  });
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw AppError.unauthorized("Missing refresh token", "NO_REFRESH_TOKEN");
  const result = await auth.refresh(req, token);
  setTokenCookies(res, result.tokens);
  res.status(200).json({
    admin: result.admin,
    roles: result.principal.roleIds,
    permissions: result.principal.permissions,
    accessTokenExpiresIn: result.tokens.accessExpiresIn,
  });
}

export async function logout(req: Request, res: Response) {
  await auth.logout(req, req.cookies?.[REFRESH_COOKIE]);
  clearTokenCookies(res);
  res.status(200).json({ ok: true });
}

export async function me(req: Request, res: Response) {
  const principal = await auth.currentPrincipal(req);
  res.json({
    admin: {
      id: principal.adminId,
      email: principal.email,
      name: principal.name,
      groupId: principal.groupId,
    },
    roles: principal.roleIds,
    permissions: principal.permissions,
  });
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body as { email: string };
  const result = await auth.forgotPassword(req, email);
  // Always 200 to prevent account enumeration; token only surfaced outside prod.
  res.status(200).json({
    ok: true,
    ...(result.resetToken ? { resetToken: result.resetToken } : {}),
  });
}

export async function resetPassword(req: Request, res: Response) {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  await auth.resetPassword(req, { token, newPassword });
  clearTokenCookies(res);
  res.status(200).json({ ok: true, message: "Password has been reset. Please log in." });
}
