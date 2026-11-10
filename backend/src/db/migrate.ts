import { execute, closePool } from "./mysql";

/**
 * Additive migration — creates the NEW InnoDB side-tables that the auth/RBAC
 * system needs. It does NOT modify any legacy MyISAM tables. Foreign keys to
 * legacy parents (administrators / admin_groups) cannot be enforced because
 * those tables are MyISAM, so integrity for those references is handled in the
 * application layer, with indexes added here for query performance.
 */

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_login_state (
     admin_id        INT NOT NULL,
     failed_attempts INT NOT NULL DEFAULT 0,
     locked_until    DATETIME NULL,
     last_login_at   DATETIME NULL,
     last_failed_at  DATETIME NULL,
     updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (admin_id),
     KEY idx_locked_until (locked_until)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
     id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     admin_id    INT NOT NULL,
     token_hash  CHAR(64) NOT NULL,
     family_id   CHAR(36) NOT NULL,
     ip          VARCHAR(64) NULL,
     user_agent  VARCHAR(255) NULL,
     expires_at  DATETIME NOT NULL,
     revoked_at  DATETIME NULL,
     replaced_by CHAR(64) NULL,
     created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_token_hash (token_hash),
     KEY idx_admin_id (admin_id),
     KEY idx_family_id (family_id),
     KEY idx_expires_at (expires_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS admin_admin_group (
     id         INT NOT NULL AUTO_INCREMENT,
     admin_id   INT NOT NULL,
     group_id   INT NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_admin_group (admin_id, group_id),
     KEY idx_group_id (group_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Side-table for admin group metadata. The legacy MyISAM `admin_groups` table
  // only has (iGroupId, vGroup, eStatus), so description + created-date live here.
  `CREATE TABLE IF NOT EXISTS admin_group_meta (
     group_id     INT NOT NULL,
     vDescription TEXT NULL,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (group_id),
     KEY idx_created_at (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Additive link table for "Manage Provider Services": which service categories
  // (legacy `service_categories`) a driver/provider (legacy `register_driver`) offers.
  // No FK to the legacy parents (integrity enforced in the application layer).
  `CREATE TABLE IF NOT EXISTS provider_service (
     iDriverId  INT NOT NULL,
     iServiceId INT NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (iDriverId, iServiceId),
     KEY idx_service_id (iServiceId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Performance indexes on legacy InnoDB tables (non-unique to tolerate any
  // pre-existing duplicate rows; no type/data change).
  `ALTER TABLE admin_pro_group_permission
     ADD INDEX idx_group_permission (group_id, permission_id)`,

  `ALTER TABLE admin_locations
     ADD INDEX idx_admin_location (admin_id, location_id)`,
];

async function migrate() {
  for (const sql of STATEMENTS) {
    const table = /TABLE(?: IF NOT EXISTS)? (`?\w+`?)/.exec(sql)?.[1] ?? "?";
    try {
      await execute(sql);
      console.log(`ok: ${sql.startsWith("CREATE") ? "created" : "indexed"} ${table}`);
    } catch (err) {
      // 1061 = duplicate key name (index already exists) — idempotent skip.
      const code = (err as { errno?: number }).errno;
      if (code === 1061) {
        console.log(`skip: index already present on ${table}`);
      } else {
        console.error(`failed on ${table}:`, (err as Error).message);
        throw err;
      }
    }
  }
  console.log("Migration complete.");
}

// Run directly: `npm run db:migrate`
if (require.main === module) {
  migrate()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

export { migrate };
