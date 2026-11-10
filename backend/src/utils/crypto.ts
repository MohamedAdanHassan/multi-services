import crypto from "node:crypto";

/** URL-safe random token (returns raw string; store/hash as needed). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Lowercase hex SHA-256 — used for reset-token and refresh-token storage. */
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Constant-time equality on hex strings to avoid timing leaks. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Mask an email for audit logs: "john@doe.com" -> "j***@doe.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0] ?? ""}***${domain}`;
}
