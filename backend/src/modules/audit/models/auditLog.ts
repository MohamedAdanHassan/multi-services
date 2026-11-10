import { execute, query } from "../../../db/mysql";
import type { AuditLogRow } from "../../../types/models";

export interface AuditContext {
  adminId?: number | null;
  emailMasked?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Append an audit entry. Fire-and-forget safe: never throws to the caller path. */
export async function record(event: string, ctx: AuditContext = {}): Promise<void> {
  try {
    await execute(
      `INSERT INTO admin_audit_log (event, admin_id, email_masked, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [
        event.slice(0, 50),
        ctx.adminId ?? null,
        ctx.emailMasked ?? null,
        ctx.ip ? ctx.ip.slice(0, 64) : null,
        ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
      ],
    );
  } catch (err) {
    // Audit failures must not break the request, but should be visible in logs.
    console.error("[audit] failed to record event:", event, err);
  }
}

export async function recent(limit = 100): Promise<AuditLogRow[]> {
  return query<AuditLogRow>(
    "SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ?",
    [Math.trunc(limit)],
  );
}
