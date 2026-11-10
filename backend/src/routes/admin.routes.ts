import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/admin/controllers/admin.controller";
import * as manage from "../modules/admin/controllers/admins.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });
const groupIdsSchema = z.object({ groupIds: z.array(z.number().int().positive()).max(50) });
const locationIdsSchema = z.object({
  locationIds: z.array(z.number().int().positive()).max(200),
});
const createSchema = z.object({
  firstName: z.string().trim().min(1).max(255),
  lastName: z.string().trim().min(1).max(255),
  email: fields.email,
  contactNo: z.string().trim().max(100).optional(),
  code: z.string().trim().max(50).optional(),
  groupId: fields.positiveInt,
  password: fields.password,
});

// --- Administrator management (full CRUD) payloads ---
const adminStatusEnum = z.enum(["Active", "Inactive"]);
const manageCreateSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(255),
  lastName: z.string().trim().max(255).default(""),
  email: fields.email,
  password: fields.password,
  groupId: fields.positiveInt,
  status: adminStatusEnum,
});
const manageUpdateSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(255),
  lastName: z.string().trim().max(255).default(""),
  email: fields.email,
  groupId: fields.positiveInt,
  status: adminStatusEnum,
});
const manageStatusSchema = z.object({ status: adminStatusEnum });

export const adminRouter = Router();

// All admin routes require an authenticated session.
adminRouter.use(requireAuth());

adminRouter.get("/groups", requirePermission("view-admin"), asyncHandler(ctrl.listGroups));

// Management routes. `/list` is declared BEFORE the `/:id` capture below so the
// literal path is never swallowed by the id param validation.
adminRouter.get("/list", requirePermission("view-admin"), asyncHandler(manage.list));

adminRouter.post(
  "/create",
  validate({ body: manageCreateSchema }),
  requirePermission("create-admin"),
  asyncHandler(manage.create),
);

adminRouter.put(
  "/:id/update",
  validate({ params: idParam, body: manageUpdateSchema }),
  requirePermission("edit-admin"),
  asyncHandler(manage.update),
);

adminRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: manageStatusSchema }),
  requirePermission("update-status-admin"),
  asyncHandler(manage.toggleStatus),
);

adminRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-admin"),
  asyncHandler(manage.remove),
);

adminRouter.get("/", requirePermission("view-admin"), asyncHandler(ctrl.list));

adminRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-admin"),
  asyncHandler(ctrl.get),
);

adminRouter.post(
  "/",
  validate({ body: createSchema }),
  requirePermission("create-admin"),
  asyncHandler(ctrl.create),
);

adminRouter.put(
  "/:id/roles",
  validate({ params: idParam, body: groupIdsSchema }),
  requirePermission("edit-admin"),
  asyncHandler(ctrl.assignRoles),
);

adminRouter.get(
  "/:id/locations",
  validate({ params: idParam }),
  requirePermission("view-admin"),
  asyncHandler(ctrl.getLocations),
);

adminRouter.put(
  "/:id/locations",
  validate({ params: idParam, body: locationIdsSchema }),
  requirePermission("edit-admin"),
  asyncHandler(ctrl.assignLocations),
);

adminRouter.post(
  "/:id/unlock",
  validate({ params: idParam }),
  requirePermission("update-status-admin"),
  asyncHandler(ctrl.unlockAccount),
);
