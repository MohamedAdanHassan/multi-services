import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/vehicle/controllers/vehicleMake.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; semantic rules (required/length) live in
// vehicleMakeService so response messages stay domain-focused.
const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const vehicleMakeRouter = Router();

vehicleMakeRouter.use(requireAuth());

/** GET /api/vehicle-makes/list — every live make with model counts. */
vehicleMakeRouter.get(
  "/list",
  requirePermission("view-vehicle-make"),
  asyncHandler(ctrl.list),
);

/** GET /api/vehicle-makes/:id — one make (edit page loader). */
vehicleMakeRouter.get(
  "/:id",
  requirePermission("view-vehicle-make"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/vehicle-makes — create a make. */
vehicleMakeRouter.post(
  "/",
  requirePermission("create-vehicle-make"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/vehicle-makes/:id — rename a make. */
vehicleMakeRouter.put(
  "/:id",
  requirePermission("edit-vehicle-make"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/vehicle-makes/:id/status — activate / deactivate. */
vehicleMakeRouter.patch(
  "/:id/status",
  requirePermission("update-status-vehicle-make"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/vehicle-makes/:id — guarded soft delete. */
vehicleMakeRouter.delete(
  "/:id",
  requirePermission("delete-vehicle-make"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
