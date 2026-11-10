import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE } from "../utils/http";
import { AppError } from "../errors/AppError";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for cookie-authenticated requests. Because the access token can
 * live in an httpOnly cookie, browsers attach it automatically; we require a
 * custom header on state-changing requests. Cross-site form posts cannot set
 * custom headers, and any cross-origin fetch attempt triggers a CORS preflight.
 * Bearer-token requests (no cookie) are inherently CSRF-immune and are skipped.
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  const usingCookie = Boolean(req.cookies && req.cookies[ACCESS_COOKIE]);
  const isMutation = !SAFE_METHODS.has(req.method.toUpperCase());
  if (usingCookie && isMutation) {
    const header = req.headers["x-requested-with"];
    if (!header || (Array.isArray(header) && header.length === 0)) {
      next(AppError.forbidden("Missing CSRF header", "CSRF"));
      return;
    }
  }
  next();
}
