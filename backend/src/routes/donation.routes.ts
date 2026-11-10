import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/donation/controllers/donation.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; text rules (required/lengths) live in donationService.
const writeSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  link: z.string().optional(),
  displayOrder: z.coerce.number().optional(),
});

const createSchema = writeSchema.extend({
  status: z.enum(["Active", "Inactive"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

// Translation batch: maps of language code → text (codes validated in service).
const translationsSchema = z.object({
  titles: z.record(z.string()).optional(),
  descriptions: z.record(z.string()).optional(),
});

export const donationRouter = Router();

donationRouter.use(requireAuth());

/** GET /api/donations/list — live donations in display order. */
donationRouter.get(
  "/list",
  requirePermission("view-donation"),
  asyncHandler(ctrl.list),
);

/** GET /api/donations/:id/image — stream the stored image (cookie auth). */
donationRouter.get(
  "/:id/image",
  requirePermission("view-donation"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** GET /api/donations/:id/translations — per-language texts for the editor. */
donationRouter.get(
  "/:id/translations",
  requirePermission("view-donation"),
  validate({ params: idParam }),
  asyncHandler(ctrl.translations),
);

/** GET /api/donations/:id — single donation (edit-page loader). */
donationRouter.get(
  "/:id",
  requirePermission("view-donation"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/donations — create a donation. */
donationRouter.post(
  "/",
  requirePermission("create-donation"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/donations/:id — edit English texts / link / display order. */
donationRouter.put(
  "/:id",
  requirePermission("edit-donation"),
  validate({ body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** PUT /api/donations/:id/translations — merge a per-language batch. */
donationRouter.put(
  "/:id/translations",
  requirePermission("edit-donation"),
  validate({ params: idParam, body: translationsSchema }),
  asyncHandler(ctrl.updateTranslations),
);

/** POST /api/donations/:id/image — multipart attach/replace (creators may upload right after creating). */
donationRouter.post(
  "/:id/image",
  requireAnyPermission(["edit-donation", "create-donation"]),
  validate({ params: idParam }),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PATCH /api/donations/:id/status — activate / deactivate. */
donationRouter.patch(
  "/:id/status",
  requirePermission("update-status-donation"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/donations/:id — soft delete. */
donationRouter.delete(
  "/:id",
  requirePermission("delete-donation"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
