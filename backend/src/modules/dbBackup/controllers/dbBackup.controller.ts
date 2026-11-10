import type { Request, Response } from "express";
import * as service from "../services/dbBackupService";
import * as audit from "../../audit/services/auditService";

/**
 * Controllers for Utility → DB Backup (#sub-133). Listing and creating are
 * JSON; download streams the stored `.sql` file as an attachment; delete
 * removes both the file and its row. Create and delete are audited.
 */

/** Audit events emitted by this module. */
export const DbBackupEvents = {
  Created: "db_backup_created",
  Deleted: "db_backup_deleted",
} as const;

/** GET /api/db-backups/list */
export async function list(_req: Request, res: Response) {
  const backups = await service.listBackups();
  res.json({ backups, total: backups.length });
}

/** POST /api/db-backups — run a fresh mysqldump and record it. */
export async function create(req: Request, res: Response) {
  const backup = await service.createBackup();
  if (req.auth) {
    audit.logQuiet(req, DbBackupEvents.Created, {
      adminId: req.auth.adminId,
      email: req.auth.email,
    });
  }
  res.status(201).json(backup);
}

/** GET /api/db-backups/:id/download — stream the dump file as an attachment. */
export async function download(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { absPath, filename } = await service.resolveForDownload(id);
  res.download(absPath, filename);
}

/** DELETE /api/db-backups/:id — remove the file and its row. */
export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  const deleted = await service.removeBackup(id);
  if (deleted > 0 && req.auth) {
    audit.logQuiet(req, DbBackupEvents.Deleted, {
      adminId: req.auth.adminId,
      email: req.auth.email,
    });
  }
  res.status(204).send();
}

