import { query, execute } from "../../../db/mysql";
import type { RefreshTokenRow } from "../../../types/models";

/** Refresh-token store (NEW additive InnoDB table `admin_refresh_tokens`). */

export async function create(params: {
  adminId: number;
  tokenHash: string;
  familyId: string;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
}): Promise<void> {
  await execute(
    `INSERT INTO admin_refresh_tokens (admin_id, token_hash, family_id, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [params.adminId, params.tokenHash, params.familyId, params.ip, params.userAgent, params.expiresAt],
  );
}

export async function findByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
  const rows = await query<RefreshTokenRow>(
    "SELECT * FROM admin_refresh_tokens WHERE token_hash = ? LIMIT 1",
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeById(id: number, replacedBy: string | null = null): Promise<void> {
  await execute(
    "UPDATE admin_refresh_tokens SET revoked_at = NOW(), replaced_by = ? WHERE id = ?",
    [replacedBy, id],
  );
}

/** Revoke an entire token family (reuse detection / logout everywhere). */
export async function revokeFamily(familyId: string): Promise<void> {
  await execute("UPDATE admin_refresh_tokens SET revoked_at = NOW() WHERE family_id = ?", [
    familyId,
  ]);
}

export async function revokeAllForAdmin(adminId: number): Promise<void> {
  await execute(
    "UPDATE admin_refresh_tokens SET revoked_at = NOW() WHERE admin_id = ? AND revoked_at IS NULL",
    [adminId],
  );
}

/** Periodic cleanup of expired/revoked rows. */
export async function purgeExpired(): Promise<void> {
  await execute(
    "DELETE FROM admin_refresh_tokens WHERE expires_at < NOW() OR revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY)",
  );
}
