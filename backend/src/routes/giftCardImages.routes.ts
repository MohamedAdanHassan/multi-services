import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/giftCardImages.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only: whether a `vCode` is a language this installation
// knows, and how big a display slot may be, is giftCardImagesService's call —
// it can answer with a message the admin can act on. The order is not coerced
// so a blank field is refused instead of quietly becoming slot 0.
const writeSchema = z.object({
  code: z.string().max(10),
  displayOrder: z.union([z.string(), z.number()]),
});

const createSchema = writeSchema.extend({
  status: z.enum(["Active", "Inactive"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** Which slice of the design × language matrix to look at. */
const listQuery = z.object({
  code: z.string().max(10).optional(),
});

export const giftCardImageRouter = Router();

giftCardImageRouter.use(requireAuth());

/** GET /api/gift-card-images — one language's designs + the language picker. */
giftCardImageRouter.get(
  "/",
  requirePermission("view-giftcard-image"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.list),
);

/** GET /api/gift-card-images/:id/image — stream the stored artwork (cookie auth). */
giftCardImageRouter.get(
  "/:id/image",
  requirePermission("view-giftcard-image"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** GET /api/gift-card-images/:id — single design row (edit-page loader). */
giftCardImageRouter.get(
  "/:id",
  requirePermission("view-giftcard-image"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/gift-card-images — add a design slot (the file attaches separately). */
giftCardImageRouter.post(
  "/",
  requirePermission("create-giftcard-image"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/gift-card-images/:id — edit language / slot. */
giftCardImageRouter.put(
  "/:id",
  requirePermission("edit-giftcard-image"),
  validate({ params: idParam, body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** POST /api/gift-card-images/:id/image — multipart attach or replace artwork. */
giftCardImageRouter.post(
  "/:id/image",
  requireAnyPermission(["create-giftcard-image", "edit-giftcard-image"]),
  validate({ params: idParam }),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PATCH /api/gift-card-images/:id/status — activate / deactivate a design. */
giftCardImageRouter.patch(
  "/:id/status",
  requirePermission("update-status-giftcard-image"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/gift-card-images/:id — soft delete; the shared file stays on disk. */
giftCardImageRouter.delete(
  "/:id",
  requirePermission("delete-giftcard-image"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
