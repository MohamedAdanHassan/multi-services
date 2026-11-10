import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/mapsApi/controllers/mapsApi.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

// Same structural shape as the general-settings batch update: an id + raw
// string value. Per-field semantic validation lives in settingsService
// (validateValue), which the Maps service reuses after loading each row's
// definition — and it only ever accepts ids from the curated Maps allowlist.
const updateSchema = z.object({
  settings: z
    .array(
      z.object({
        id: z.coerce.number().int().positive(),
        value: z.string().max(65_536),
      }),
    )
    .min(1, "At least one setting must be provided")
    .max(50, "Batch too large for Maps settings"),
});

export const mapsApiRouter = Router();

mapsApiRouter.use(requireAuth());

/** GET /api/maps-api/list — active Maps API settings. */
mapsApiRouter.get(
  "/list",
  requirePermission("view-map-api-service-account"),
  asyncHandler(ctrl.list),
);

/** PUT /api/maps-api/update — validate and persist a batch of Maps values. */
mapsApiRouter.put(
  "/update",
  requirePermission("edit-map-api-service-account"),
  validate({ body: updateSchema }),
  asyncHandler(ctrl.update),
);
