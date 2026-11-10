import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/permissions/controllers/permission.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const groupParam = z.object({ groupId: fields.positiveInt });
const permissionsBody = z.object({
  permissionIds: z.array(z.number().int().positive()).max(5000),
});

export const permissionRouter = Router();

permissionRouter.use(requireAuth());

permissionRouter.get("/", requirePermission("view-admin"), asyncHandler(ctrl.listPermissions));

permissionRouter.get("/tree", requirePermission("view-admin"), asyncHandler(ctrl.permissionTree));

permissionRouter.get(
  "/display-groups",
  requirePermission("view-admin"),
  asyncHandler(ctrl.listDisplayGroups),
);

permissionRouter.get(
  "/display-subgroups",
  requirePermission("view-admin"),
  asyncHandler(ctrl.listDisplaySubGroups),
);

permissionRouter.get(
  "/groups/:groupId",
  validate({ params: groupParam }),
  requirePermission("view-admin"),
  asyncHandler(ctrl.getGroupPermissions),
);

permissionRouter.put(
  "/groups/:groupId",
  validate({ params: groupParam, body: permissionsBody }),
  requirePermission("edit-admin"),
  asyncHandler(ctrl.setGroupPermissions),
);
