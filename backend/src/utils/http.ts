import type { CookieOptions, Request } from "express";
import { env } from "../config/env";

export const ACCESS_COOKIE = "at";
export const REFRESH_COOKIE = "rt";
export const REFRESH_COOKIE_PATH = "/api/auth";

/** Best-effort client IP, honouring X-Forwarded-For only behind a trusted proxy. */
export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (env.trustProxy && typeof fwd === "string" && fwd.length) {
    return fwd.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function userAgent(req: Request): string | null {
  return req.headers["user-agent"]?.slice(0, 255) ?? null;
}

export function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    domain: env.cookies.domain,
  };
}

export function accessCookieOptions(): CookieOptions {
  return { ...baseCookie(), path: "/", maxAge: env.jwt.accessTtlSeconds * 1000 };
}

export function refreshCookieOptions(): CookieOptions {
  return {
    ...baseCookie(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.jwt.refreshTtlSeconds * 1000,
  };
}
