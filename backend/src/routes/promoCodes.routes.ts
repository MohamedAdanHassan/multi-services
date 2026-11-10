import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/promoCodes.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

/** Non-negative integer ids the legacy scope columns accept (0 = unset). */
const scopeId = z.coerce.number().int().min(0).max(1_000_000_000);

// Structural checks only; the coupling of validity/discount/store scope lives
// in promoCodesService, where a bad combination becomes a 400 with a readable
// message. Every key the service reads must be declared — validate() replaces
// the body with the parsed object, so undeclared fields would be dropped.
const writeSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
  discount: z.coerce.number(),
  discountType: z.enum(["percentage", "cash"]).optional(),
  validity: z.enum(["Permanent", "Defined"]).optional(),
  activeDate: z.string().optional(),
  expiryDate: z.string().optional(),
  usageLimit: z.coerce.number().optional(),
  systemType: z.enum(["Ride", "Delivery", "UberX", "DeliverAll", "General"]).optional(),
  fly: z.boolean().optional(),
  promoType: z.enum(["Public", "Private"]).optional(),
  storeScope: z.enum(["", "All", "StoreSpecific"]).optional(),
  companyId: scopeId.optional(),
  serviceId: scopeId.optional(),
  freeDelivery: z.boolean().optional(),
  locationId: scopeId.optional(),
});

const createSchema = writeSchema.extend({
  status: z.enum(["Active", "Inactive"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** The export reuses the listing's filters so the CSV matches the screen. */
const exportQuery = z.object({
  status: z.enum(["all", "Active", "Inactive"]).optional(),
  search: z.string().max(100).optional(),
});

export const promoCodeRouter = Router();

promoCodeRouter.use(requireAuth());

/** GET /api/promocodes/list — every promo code that has not been deleted. */
promoCodeRouter.get("/list", requirePermission("view-promocode"), asyncHandler(ctrl.list));

/** GET /api/promocodes/options — reference lists for the form's selects. */
promoCodeRouter.get("/options", requirePermission("view-promocode"), asyncHandler(ctrl.options));

/** GET /api/promocodes/export — CSV of the filtered listing (declared before /:id). */
promoCodeRouter.get(
  "/export",
  requirePermission("export-promocode"),
  validate({ query: exportQuery }),
  asyncHandler(ctrl.exportCsv),
);

/** GET /api/promocodes/:id — single promo code (edit-page loader). */
promoCodeRouter.get(
  "/:id",
  requirePermission("view-promocode"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/promocodes — create a promo code. */
promoCodeRouter.post(
  "/",
  requirePermission("create-promocode"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/promocodes/:id — edit code, discount, validity, scope. */
promoCodeRouter.put(
  "/:id",
  requirePermission("edit-promocode"),
  validate({ params: idParam, body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/promocodes/:id/status — activate / deactivate. */
promoCodeRouter.patch(
  "/:id/status",
  requirePermission("update-status-promocode"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/promocodes/:id — soft delete (`eStatus` = 'Deleted'). */
promoCodeRouter.delete(
  "/:id",
  requirePermission("delete-promocode"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
