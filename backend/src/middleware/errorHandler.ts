import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { env } from "../config/env";

/** 404 handler for unmatched routes. */
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

/** Central error handler: normalizes AppError/Zod/unknown errors to JSON. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Validation failed" },
    });
  }

  // Unexpected error — log it, return a generic 500.
  const status = (err as { status?: number })?.status ?? 500;
  console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: env.isProd ? "Internal server error" : (err as Error)?.message ?? "Internal server error",
    },
  });
}
