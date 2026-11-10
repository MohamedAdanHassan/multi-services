import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/news.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

// Structural checks only; text rules and enum membership live in newsService.
const writeSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["News", "Notification"]).optional(),
  audience: z.enum(["driver", "rider", "company", "all"]).optional(),
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

export const newsRouter = Router();

newsRouter.use(requireAuth());

/** GET /api/news/list — live articles in publish order. */
newsRouter.get("/list", requirePermission("view-news"), asyncHandler(ctrl.list));

/** GET /api/news/:id/image — stream the stored image (cookie auth). */
newsRouter.get(
  "/:id/image",
  requirePermission("view-news"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** GET /api/news/:id/translations — per-language texts for the editor. */
newsRouter.get(
  "/:id/translations",
  requirePermission("view-news"),
  validate({ params: idParam }),
  asyncHandler(ctrl.translations),
);

/** GET /api/news/:id — single article (edit-page loader). */
newsRouter.get(
  "/:id",
  requirePermission("view-news"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/news — create an article. */
newsRouter.post(
  "/",
  requirePermission("create-news"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/news/:id — edit English texts, type and audience. */
newsRouter.put(
  "/:id",
  requirePermission("edit-news"),
  validate({ body: writeSchema }),
  asyncHandler(ctrl.update),
);

/** PUT /api/news/:id/translations — merge a per-language batch. */
newsRouter.put(
  "/:id/translations",
  requirePermission("edit-news"),
  validate({ params: idParam, body: translationsSchema }),
  asyncHandler(ctrl.updateTranslations),
);

/** POST /api/news/:id/image — multipart attach/replace (creators upload right after creating). */
newsRouter.post(
  "/:id/image",
  requireAnyPermission(["edit-news", "create-news"]),
  validate({ params: idParam }),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PATCH /api/news/:id/status — activate / deactivate. */
newsRouter.patch(
  "/:id/status",
  requirePermission("update-status-news"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/news/:id — soft delete. */
newsRouter.delete(
  "/:id",
  requirePermission("delete-news"),
  validate({ params: idParam }),
  asyncHandler(ctrl.remove),
);
