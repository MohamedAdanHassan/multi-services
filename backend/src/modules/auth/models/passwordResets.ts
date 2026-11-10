import { query, execute } from "../../../db/mysql";
import type { PasswordResetRow } from "../../../types/models";

export async function upsert(
  adminId: number,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  // admin_id is UNIQUE: one live reset token per admin, reused/overwritten on re-request.
  await execute(
    `INSERT INTO admin_password_resets (admin_id, token_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash),
                             expires_at = VALUES(expires_at),
                             attempts = 0,
                             created_at = CURRENT_TIMESTAMP`,
    [adminId, tokenHash, expiresAt],
  );
}

export async function findByAdmin(adminId: number): Promise<PasswordResetRow | null> {
  const rows = await query<PasswordResetRow>(
    "SELECT * FROM admin_password_resets WHERE admin_id = ? LIMIT 1",
    [adminId],
  );
  return rows[0] ?? null;
}

export async function incrementAttempts(adminId: number): Promise<void> {
  await execute("UPDATE admin_password_resets SET attempts = attempts + 1 WHERE admin_id = ?", [
    adminId,
  ]);
}

/** Consume the token once the password has been successfully changed. */
export async function deleteForAdmin(adminId: number): Promise<void> {
  await execute("DELETE FROM admin_password_resets WHERE admin_id = ?", [adminId]);
}
