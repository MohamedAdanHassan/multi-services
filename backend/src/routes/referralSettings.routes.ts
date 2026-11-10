import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/referralSettings.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only. "Is this depth free / within the ceiling" needs the
// current REFERRAL_LEVEL setting, so that judgement lives in the service and
// reaches the admin as a readable 400 rather than a generic validation issue.
// The numbers deliberately are NOT coerced here: `z.coerce.number()` would turn
// an empty field into 0, and a blank commission must be refused by the service
// instead of silently saving "0".
const levelSchema = z.object({
  level: z.union([z.string(), z.number()]),
  title: z.string().max(1_000),
  amount: z.union([z.string(), z.number()]),
});

// Same shape as the general / Maps API batch update: id + raw string value.
// Per-field semantics are validated from the row's own `configurations`
// metadata, and only the curated referral allowlist is accepted.
const settingsSchema = z.object({
  settings: z
    .array(
      z.object({
        id: z.coerce.number().int().positive(),
        value: z.string().max(65_536),
      }),
    )
    .min(1, "At least one setting must be provided")
    .max(20, "Batch too large for referral settings"),
});

export const referralSettingsRouter = Router();

referralSettingsRouter.use(requireAuth());

/** GET /api/referral-settings/list — scheme settings, levels and the ceiling. */
referralSettingsRouter.get(
  "/list",
  requirePermission("view-referral-settings"),
  asyncHandler(ctrl.list),
);

/** PUT /api/referral-settings/settings — save the scheme switches. */
referralSettingsRouter.put(
  "/settings",
  requirePermission("edit-referral-settings"),
  validate({ body: settingsSchema }),
  asyncHandler(ctrl.updateSettings),
);

/** GET /api/referral-settings/levels/:id — one level (edit-page loader). */
referralSettingsRouter.get(
  "/levels/:id",
  requirePermission("view-referral-settings"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getLevel),
);

/** POST /api/referral-settings/levels — add a referral depth. */
referralSettingsRouter.post(
  "/levels",
  requirePermission("create-referral-settings"),
  validate({ body: levelSchema }),
  asyncHandler(ctrl.createLevel),
);

/** PUT /api/referral-settings/levels/:id — edit a referral depth. */
referralSettingsRouter.put(
  "/levels/:id",
  requirePermission("edit-referral-settings"),
  validate({ params: idParam, body: levelSchema }),
  asyncHandler(ctrl.updateLevel),
);

// No DELETE and no status route on purpose: `delete-referral-settings` (#702)
// is Inactive in the RBAC table, so a level can be renumbered or renamed but
// never retired from this panel.
