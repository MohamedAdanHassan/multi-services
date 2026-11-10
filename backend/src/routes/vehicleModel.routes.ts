import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/vehicle/controllers/vehicleModel.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// The model catalog is ~10k rows, so the list is filtered/paginated
// server-side; the service clamps limit/page defensively afterwards.
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  makeId: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Structural checks only; title length / make existence are validated in
// vehicleModelService.
const createSchema = z.object({
  makeId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1).max(100),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const updateSchema = z.object({
  makeId: z.coerce.number().int().positive(),
  title: z.string().trim().min(1).max(100),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const vehicleModelRouter = Router();

vehicleModelRouter.use(requireAuth());

/** GET /api/vehicle-models/list — one filtered page of models. */
vehicleModelRouter.get(
  "/list",
  requirePermission("view-vehicle-model"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.list),
);

/** GET /api/vehicle-models/:id — one model (edit page loader). */
vehicleModelRouter.get(
  "/:id",
  requirePermission("view-vehicle-model"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/vehicle-models — create a model under a make. */
vehicleModelRouter.post(
  "/",
  requirePermission("create-vehicle-model"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/vehicle-models/:id — retitle and/or re-parent. */
vehicleModelRouter.put(
  "/:id",
  requirePermission("edit-vehicle-model"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/vehicle-models/:id/status — activate / deactivate. */
vehicleModelRouter.patch(
  "/:id/status",
  requirePermission("update-status-vehicle-model"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/vehicle-models/:id — guarded soft delete. */
vehicleModelRouter.delete(
  "/:id",
  requirePermission("delete-vehicle-model"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
