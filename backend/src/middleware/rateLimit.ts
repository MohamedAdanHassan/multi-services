import rateLimit, { type Options } from "express-rate-limit";
import type { Request, Response } from "express";
import { env } from "../config/env";
import { clientIp } from "../utils/http";
import * as audit from "../modules/audit/services/auditService";

function jsonHandler(code: string, message: string) {
  return (req: Request, res: Response, _next: unknown, _options: Options) => {
    void _options;
    void req;
    res.status(429).json({ error: { code, message } });
  };
}

/** General API limiter. */
export const standardLimiter = rateLimit({
  windowMs: env.rateLimit.standardWindowMs,
  limit: env.rateLimit.standardMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler: jsonHandler("RATE_LIMITED", "Too many requests"),
});

/**
 * Strict limiter for credential endpoints (login, refresh, reset). Also records
 * a `login_rate_limited` audit event so abuse is visible in the audit trail.
 */
export const authLimiter = rateLimit({
  windowMs: env.rateLimit.authWindowMs,
  limit: env.rateLimit.authMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  handler: (req: Request, res: Response) => {
    void audit.log(req, audit.Events.LoginRateLimited, {
      email: typeof req.body?.email === "string" ? req.body.email : null,
    });
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many authentication attempts. Try again later." },
    });
  },
});
