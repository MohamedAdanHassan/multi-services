import bcrypt from "bcryptjs";
import { env } from "../../../config/env";

/** Hash a plaintext password with bcrypt (cost from env, default 12). */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.password.bcryptRounds);
}

/**
 * Verify a password against a stored hash. Handles the legacy `$2y$` prefix
 * already present in `administrators.vPassword` as well as newly-generated `$2b$`.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await bcrypt.compare(plain, stored);
  } catch {
    return false;
  }
}

/** True if the stored hash used a different (lower) cost than policy — used to rehash on login. */
export function shouldRehash(stored: string): boolean {
  const m = /^\$2[aby]\$(\d{2})\$/.exec(stored);
  if (!m) return true; // not a recognizable bcrypt hash
  return Number(m[1]) < env.password.bcryptRounds;
}
