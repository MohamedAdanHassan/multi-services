import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/admin/controllers/adminGroups.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });
const statusEnum = z.enum(["Active", "Inactive", "Deleted"]);
const toggleEnum = z.enum(["Active", "Inactive"]);
const nameField = z.string().trim().min(1, "Group name is required").max(255);
const descriptionField = z.string().trim().max(2000).optional();

const createSchema = z.object({
  name: nameField,
  description: descriptionField,
  status: statusEnum,
});
const updateSchema = createSchema;
const statusSchema = z.object({ status: toggleEnum });

export const adminGroupRouter = Router();

// All admin-group routes require an authenticated session.
adminGroupRouter.use(requireAuth());

adminGroupRouter.get("/list", requirePermission("view-admin-group"), asyncHandler(ctrl.list));

adminGroupRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-admin-group"),
  asyncHandler(ctrl.create),
);

adminGroupRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-admin-group"),
  asyncHandler(ctrl.update),
);

adminGroupRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-admin-group"),
  asyncHandler(ctrl.toggleStatus),
);

adminGroupRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-admin-group"),
  asyncHandler(ctrl.remove),
);
