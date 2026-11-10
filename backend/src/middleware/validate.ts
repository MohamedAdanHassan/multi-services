import type { NextFunction, Request, Response } from "express";
import { z, ZodError, type ZodTypeAny } from "zod";
import { AppError } from "../errors/AppError";

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatIssues(err: ZodError) {
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
    code: i.code,
  }));
}

/**
 * Validate & sanitize request parts against Zod schemas. Parsed (coerced,
 * trimmed) values replace the originals so downstream code gets clean data.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Request["params"];
      }
      if (schemas.query) {
        (req as { query: unknown }).query = schemas.query.parse(req.query);
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(AppError.badRequest("Validation failed", formatIssues(err)));
      } else {
        next(err);
      }
    }
  };
}

/** Reusable field schemas. */
export const fields = {
  email: z.string().trim().toLowerCase().email("Invalid email"),
  // 10–72 chars keeps within bcrypt's 72-byte input limit.
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(72, "Password must be at most 72 characters"),
  positiveInt: z.coerce.number().int().positive(),
};
