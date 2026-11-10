import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/giftCards.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

/** Optional numeric ids the legacy columns accept (blank / 0 = unset). */
const maybeId = z.union([z.string(), z.number()]).optional();

// Structural checks only, and the numbers deliberately are NOT coerced:
// `z.coerce.number()` turns an empty field into 0, and giftCardsService needs to
// tell "left blank" apart from "issued with no value" (see cleanAmount). Text
// limits are the service's job too, so the admin gets one readable 400 instead
// of a generic validation issue. Every key the service reads must be declared —
// validate() replaces the body with the parsed object.
const writeSchema = z.object({
  code: z.string().max(255),
  amount: z.union([z.string(), z.number()]),
  // Not an enum here: cleanAudience names the three choices the admin may pick,
  // so a wrong value reaches them as a sentence instead of "Validation failed".
  audience: z.string().max(20).optional(),
  memberId: maybeId,
  receiverId: maybeId,
  receiverDetails: z.string().max(65_536).optional(),
  description: z.string().max(65_536).optional(),
  imageId: maybeId,
});

const createSchema = writeSchema.extend({
  status: z.enum(["Active", "Inactive"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

const listQuery = z.object({
  status: z.enum(["all", "Active", "Inactive"]).optional(),
  redeemed: z.enum(["all", "Yes", "No"]).optional(),
  search: z.string().max(100).optional(),
});

/** The design a card being edited already points at stays in the option list. */
const optionsQuery = z.object({
  imageId: z.union([z.string(), z.number()]).optional(),
});

export const giftCardRouter = Router();

giftCardRouter.use(requireAuth());

/** GET /api/gift-cards/list — every live card, newest first, filtered. */
giftCardRouter.get(
  "/list",
  requirePermission("view-giftcard"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.list),
);

/** GET /api/gift-cards/options — artwork designs for the card form. */
giftCardRouter.get(
  "/options",
  requireAnyPermission(["view-giftcard", "create-giftcard", "edit-giftcard"]),
  validate({ query: optionsQuery }),
  asyncHandler(ctrl.options),
);

/** GET /api/gift-cards/:id — single card (edit-page loader). */
giftCardRouter.get(
  "/:id",
  requirePermission("view-giftcard"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/gift-cards — issue a card. */
giftCardRouter.post(
  "/",
  requirePermission("create-giftcard"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/gift-cards/:id — edit code, value, recipient, artwork. */
giftCardRouter.put(
  "/:id",
  requirePermission("edit-giftcard"),
  validate({ params: idParam, body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/gift-cards/:id/status — activate / deactivate. */
giftCardRouter.patch(
  "/:id/status",
  requirePermission("update-status-giftcard"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/gift-cards/:id — soft delete (`eStatus` = 'Deleted'). */
giftCardRouter.delete(
  "/:id",
  requirePermission("delete-giftcard"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
