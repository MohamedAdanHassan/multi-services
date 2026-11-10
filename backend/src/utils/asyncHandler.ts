import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Wrap an async handler so rejected promises are forwarded to the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
