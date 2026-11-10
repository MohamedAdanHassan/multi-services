import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/language/controllers/language.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; field limits and required names live in
// languageService so the response messages stay domain-focused.
const updateSchema = z.object({
  title: z.string(),
  titleEn: z.string(),
  gmapLangCode: z.string(),
  langCode: z.string(),
  currencyCode: z.string(),
  currencySymbol: z.string(),
  displayOrder: z.coerce.number(),
  direction: z.enum(["rtl", "ltr"]),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const languageRouter = Router();

languageRouter.use(requireAuth());

/** GET /api/languages/list — full language catalog. */
languageRouter.get(
  "/list",
  requirePermission("manage-language"),
  asyncHandler(ctrl.list),
);

/** PUT /api/languages/:id — edit a language. */
languageRouter.put(
  "/:id",
  requirePermission("manage-language"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/languages/:id/status — activate / deactivate. */
languageRouter.patch(
  "/:id/status",
  requirePermission("update-status-manage-language"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** PATCH /api/languages/:id/default — set as the app default language. */
languageRouter.patch(
  "/:id/default",
  requirePermission("manage-language"),
  validate({ params: idParam }),
  asyncHandler(ctrl.setDefault),
);
