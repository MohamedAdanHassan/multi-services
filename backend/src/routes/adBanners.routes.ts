import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/adBanners.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; the coupling of impression/validity pairs lives in
// adBannersService, where a bad combination becomes a 400 with a readable message.
const writeSchema = z.object({
  title: z.string().min(1),
  redirectUrl: z.string().optional(),
  impressionMode: z.enum(["Unlimited", "Limited"]).optional(),
  impressionCap: z.coerce.number().optional(),
  validityMode: z.enum(["Permanent", "Custom"]).optional(),
  startDate: z.string().optional(),
  expiryDate: z.string().optional(),
  displayOrder: z.coerce.number().optional(),
});

const createSchema = writeSchema.extend({
  status: z.enum(["Active", "Inactive"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const adBannerRouter = Router();

adBannerRouter.use(requireAuth());

/** GET /api/advertise-banners/list — every banner in display order. */
adBannerRouter.get(
  "/list",
  requirePermission("view-advertise-banner"),
  asyncHandler(ctrl.list),
);

/** GET /api/advertise-banners/:id/image — stream the stored image (cookie auth). */
adBannerRouter.get(
  "/:id/image",
  requirePermission("view-advertise-banner"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** GET /api/advertise-banners/:id — single banner (edit-page loader). */
adBannerRouter.get(
  "/:id",
  requirePermission("view-advertise-banner"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/advertise-banners — create a banner. */
adBannerRouter.post(
  "/",
  requirePermission("create-advertise-banner"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/advertise-banners/:id — edit texts / caps / validity / order. */
adBannerRouter.put(
  "/:id",
  requirePermission("edit-advertise-banner"),
  validate({ params: idParam, body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** POST /api/advertise-banners/:id/image — multipart attach or replace. */
adBannerRouter.post(
  "/:id/image",
  requireAnyPermission(["edit-advertise-banner", "create-advertise-banner"]),
  validate({ params: idParam }),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PATCH /api/advertise-banners/:id/status — activate / deactivate. */
adBannerRouter.patch(
  "/:id/status",
  requirePermission("update-status-advertise-banner"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/advertise-banners/:id — hard delete (legacy enum has no 'Deleted'). */
adBannerRouter.delete(
  "/:id",
  requirePermission("delete-advertise-banner"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
