/** Typed HTTP error carrying a status code and a stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(msg = "Bad request", details?: unknown) {
    return new AppError(400, "BAD_REQUEST", msg, details);
  }
  static unauthorized(msg = "Unauthorized", code = "UNAUTHORIZED") {
    return new AppError(401, code, msg);
  }
  static forbidden(msg = "Forbidden", code = "FORBIDDEN") {
    return new AppError(403, code, msg);
  }
  static notFound(msg = "Not found") {
    return new AppError(404, "NOT_FOUND", msg);
  }
  static tooMany(msg = "Too many requests", code = "RATE_LIMITED") {
    return new AppError(429, code, msg);
  }
}
