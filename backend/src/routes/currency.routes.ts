import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/currency/controllers/currency.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; semantic rules (non-negative, ranges, symbol length)
// live in currencyService so the response messages stay domain-focused.
const updateSchema = z.object({
  symbol: z.string().trim().min(1).max(20),
  ratio: z.coerce.number(),
  displayOrder: z.coerce.number(),
  threshold: z.coerce.number(),
  reverseFormatting: z.boolean(),
  reverseSymbol: z.boolean(),
  roundingOff: z.boolean(),
  firstRange: z.coerce.number(),
  middleRange: z.coerce.number(),
  secondRange: z.coerce.number(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const currencyRouter = Router();

currencyRouter.use(requireAuth());

/** GET /api/currencies/list — full currency catalog. */
currencyRouter.get(
  "/list",
  requirePermission("manage-currency"),
  asyncHandler(ctrl.list),
);

/** PUT /api/currencies/:id — edit a currency. */
currencyRouter.put(
  "/:id",
  requirePermission("manage-currency"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/currencies/:id/status — activate / deactivate. */
currencyRouter.patch(
  "/:id/status",
  requirePermission("update-status-manage-currency"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** PATCH /api/currencies/:id/default — set as the store default. */
currencyRouter.patch(
  "/:id/default",
  requirePermission("manage-currency"),
  validate({ params: idParam }),
  asyncHandler(ctrl.setDefault),
);
