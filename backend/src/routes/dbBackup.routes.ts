import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/dbBackup/controllers/dbBackup.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParams = z.object({ id: fields.positiveInt });

export const dbBackupRouter = Router();

dbBackupRouter.use(requireAuth());

/** GET /api/db-backups/list — recorded backups (#sub-133). */
dbBackupRouter.get(
  "/list",
  requirePermission("view-db-backup"),
  asyncHandler(ctrl.list),
);

/** POST /api/db-backups — run a manual mysqldump and record it. */
dbBackupRouter.post(
  "/",
  requirePermission("create-db-backup"),
  asyncHandler(ctrl.create),
);

/** GET /api/db-backups/:id/download — stream a stored dump as an attachment. */
dbBackupRouter.get(
  "/:id/download",
  requirePermission("download-db-backup"),
  validate({ params: idParams }),
  asyncHandler(ctrl.download),
);

/** DELETE /api/db-backups/:id — remove a dump file and its row. */
dbBackupRouter.delete(
  "/:id",
  requirePermission("delete-db-backup"),
  validate({ params: idParams }),
  asyncHandler(ctrl.remove),
);
