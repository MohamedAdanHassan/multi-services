import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/banner/controllers/banner.controller";
import {
  BANNER_APPS,
  BANNER_LANGUAGES,
  requireBannerApp,
} from "../modules/banner/models/bannerModel";
import type { BannerApp } from "../modules/banner/models/bannerModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission, requireAnyPermission } from "../middleware/rbac";

/**
 * Banners, the screen the `:app` segment scopes. Parcel Delivery (#sub-140, display
 * group 32) owns the `eType='Deliver'` rows of the legacy `banners` table, Delivery
 * Genie (#sub-142, display group 33) the `eType='Genie'` ones and Delivery Runner
 * (#sub-143, display group 34) the `eType='Runner'` ones — the same lifecycle over all
 * three, because all three are what the apps read to decide which picture to slide. The
 * segment decides the row scope (resolved in the controller) and which permission keys
 * guard the path, so no path is ever gated by another app's keys.
 *
 * One banner is 26 rows — a group under `iUniqueId`, one per `vCode` — so the route
 * bounds only the shape of a payload: which language codes may appear, that a create
 * carries English, that a save changes something. The group fan-out, the missing-
 * language inserts and the content checks belong to the service.
 */
const appParam = z.object({ app: z.enum(BANNER_APPS) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The permission keys each app's sub-group seeds, by action. */
const PERMISSION_KEYS: Record<
  BannerApp,
  { view: string; create: string; edit: string; status: string; delete: string }
> = {
  delivery: {
    view: "view-banner-parcel-delivery",
    create: "create-banner-parcel-delivery",
    edit: "edit-banner-parcel-delivery",
    status: "update-status-banner-parcel-delivery",
    delete: "delete-banner-parcel-delivery",
  },
  genie: {
    view: "view-banner-genie-delivery",
    create: "create-banner-genie-delivery",
    edit: "edit-banner-genie-delivery",
    status: "update-status-banner-genie-delivery",
    delete: "delete-banner-genie-delivery",
  },
  runner: {
    view: "view-banner-runner-delivery",
    create: "create-banner-runner-delivery",
    edit: "edit-banner-runner-delivery",
    status: "update-status-banner-runner-delivery",
    delete: "delete-banner-runner-delivery",
  },
};

/** Demand the permission the `:app` segment maps to, so one path never uses another's key. */
function guard(action: "view" | "create" | "edit" | "status" | "delete") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireBannerApp(req.params.app).app][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** The pair the picture upload accepts: editing a banner or giving a new one its image. */
function guardAnyOf(actions: Array<"create" | "edit">) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const keys = PERMISSION_KEYS[requireBannerApp(req.params.app).app];
      return requireAnyPermission(actions.map((a) => keys[a]))(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** A `texts` map: known language codes only, each a caption under the picture. */
const langCode = z.enum(BANNER_LANGUAGES.map((l) => l.code) as [string, ...string[]]);
const texts = z
  .record(langCode, z.string().max(100))
  .refine((t) => Object.keys(t).length > 0, { message: "Send at least one language." })
  .refine((t) => Object.keys(t).length <= BANNER_LANGUAGES.length, {
    message: `A save may touch at most ${BANNER_LANGUAGES.length} languages.`,
  });

/** `vStatusBarColor` is varchar(10): a #RRGGBB hex, or blank for the app's own default. */
const statusBarColor = z.string().max(10).regex(/^(#[0-9a-fA-F]{6})?$/);

const writeFields = {
  displayOrder: z.union([z.string().max(12), z.number().int()]).optional(),
  // Optional on both verbs: omitted means "keep the colour the group already has",
  // while an explicit '' clears it back to the app's own default.
  statusBarColor: statusBarColor.optional(),
};

const createSchema = z.object({
  // `texts` is required here: a refined schema has no `.required()`, and a record
  // named directly in an object is required anyway.
  texts,
  status: z.enum(["Active", "Inactive"]).optional(),
  ...writeFields,
});

const updateSchema = z
  .object({
    texts: texts.optional(),
    ...writeFields,
  })
  .refine((v) => v.texts !== undefined || v.displayOrder !== undefined || v.statusBarColor !== undefined, {
    message: "Send the languages that changed, the display order or the colour.",
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete wipes the whole group with no undo, so its own title must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(100) });

export const bannerRouter = Router();

bannerRouter.use(requireAuth());

/** GET /api/banner/:app/list — banner groups of this app slice. */
bannerRouter.get(
  "/:app/list",
  guard("view"),
  validate({ params: appParam }),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/banner/:app/defaults — the language list and next free slot for the add form.
 * Registered before the `/:app/:id` routes, which would otherwise swallow “defaults”
 * as an id.
 */
bannerRouter.get(
  "/:app/defaults",
  guard("create"),
  validate({ params: appParam }),
  asyncHandler(ctrl.defaults),
);

/** GET /api/banner/:app/:id/image — stream the stored picture (cookie auth). */
bannerRouter.get(
  "/:app/:id/image",
  guard("view"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** GET /api/banner/:app/:id — one banner with every language row. */
bannerRouter.get(
  "/:app/:id",
  guard("view"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/banner/:app — add a banner to this app's slice. */
bannerRouter.post(
  "/:app",
  guard("create"),
  validate({ params: appParam, body: createSchema }),
  asyncHandler(ctrl.create),
);

/** POST /api/banner/:app/:id/image — multipart attach or replace. Create is allowed too,
 * because the add form uploads the picture of the banner it has just inserted. */
bannerRouter.post(
  "/:app/:id/image",
  guardAnyOf(["edit", "create"]),
  validate({ params: idParam }),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PUT /api/banner/:app/:id — write the changed languages, slot and colour. */
bannerRouter.put(
  "/:app/:id",
  guard("edit"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/banner/:app/:id/status — activate / deactivate the whole group. */
bannerRouter.patch(
  "/:app/:id/status",
  guard("status"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/banner/:app/:id — hard delete (`eStatus` has no 'Deleted' member). */
bannerRouter.delete(
  "/:app/:id",
  guard("delete"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
