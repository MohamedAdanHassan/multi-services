import { query, execute } from "../../../db/mysql";
import type { LoginStateRow } from "../../../types/models";

/** Account-lockout state (NEW additive InnoDB table `admin_login_state`). */

export async function get(adminId: number): Promise<LoginStateRow | null> {
  const rows = await query<LoginStateRow>(
    "SELECT * FROM admin_login_state WHERE admin_id = ? LIMIT 1",
    [adminId],
  );
  return rows[0] ?? null;
}

/** Reset counters and stamp a successful login. */
export async function recordSuccess(adminId: number): Promise<void> {
  await execute(
    `INSERT INTO admin_login_state (admin_id, failed_attempts, locked_until, last_login_at, last_failed_at, updated_at)
     VALUES (?, 0, NULL, NOW(), NULL, NOW())
     ON DUPLICATE KEY UPDATE failed_attempts = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()`,
    [adminId],
  );
}

/**
 * Register a failed attempt. When the threshold is crossed, set `locked_until`.
 * Returns the updated state so callers can compute remaining attempts / lock time.
 */
export async function recordFailure(
  adminId: number,
  maxAttempts: number,
  lockMinutes: number,
): Promise<LoginStateRow> {
  await execute(
    `INSERT INTO admin_login_state (admin_id, failed_attempts, locked_until, last_failed_at, updated_at)
     VALUES (?, 1, NULL, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       failed_attempts = failed_attempts + 1,
       last_failed_at = NOW(),
       updated_at = NOW()`,
    [adminId],
  );
  // Apply the lock if we just reached the threshold.
  await execute(
    `UPDATE admin_login_state
        SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE)
      WHERE admin_id = ? AND failed_attempts >= ? AND locked_until IS NULL`,
    [lockMinutes, adminId, maxAttempts],
  );
  const state = await get(adminId);
  if (!state) throw new Error(`login state missing for admin ${adminId}`);
  return state;
}

export async function clearLock(adminId: number): Promise<void> {
  await execute(
    "UPDATE admin_login_state SET locked_until = NULL, failed_attempts = 0, updated_at = NOW() WHERE admin_id = ?",
    [adminId],
  );
}
