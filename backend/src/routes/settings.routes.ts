import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/settings/controllers/settings.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

// Zod pre-validation: id must be positive, value is a string (max 64KB).
// Per-field semantic validation (input type, select membership, numeric
// constraints) is handled by settingsService.validateValue after loading the
// setting definition from the DB.
const updateSchema = z.object({
  settings: z
    .array(
      z.object({
        id: z.coerce.number().int().positive(),
        value: z.string().max(65_536),
      }),
    )
    .min(1, "At least one setting must be provided")
    .max(500, "Batch too large — reduce to 500 settings per request"),
});

export const settingsRouter = Router();

settingsRouter.use(requireAuth());

/** GET /api/settings/list — all admin-editable settings grouped by category. */
settingsRouter.get(
  "/list",
  requirePermission("manage-general-settings"),
  asyncHandler(ctrl.list),
);

/** PUT /api/settings/update — validate and persist a batch of value changes. */
settingsRouter.put(
  "/update",
  requirePermission("manage-general-settings"),
  validate({ body: updateSchema }),
  asyncHandler(ctrl.update),
);
