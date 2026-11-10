import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/seo/controllers/seo.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; required fields and column length limits are
// enforced by seoService so messages stay domain-focused.
const updateSchema = z.object({
  pageName: z.string(),
  pageTitle: z.string(),
  metaKeywords: z.string(),
  description: z.string(),
});

export const seoRouter = Router();

seoRouter.use(requireAuth());

/** GET /api/seo/list — all SEO sections. */
seoRouter.get(
  "/list",
  requirePermission("view-seo-setting"),
  asyncHandler(ctrl.list),
);

/** PUT /api/seo/:id — edit one section's metadata. */
seoRouter.put(
  "/:id",
  requirePermission("edit-seo-setting"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);
