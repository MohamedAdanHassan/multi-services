import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/master-service-category/controllers/masterServiceCategory.controller";
import type { MasterCategoryAppKey } from "../modules/master-service-category/models/masterServiceCategoryModel";
import { requireScope } from "../modules/master-service-category/models/masterServiceCategoryModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Parcel Delivery → Manage Service Category (#sub-136). Edits the app's master
 * `master_service_category_pro` row (`eType='Deliver'`): the icon, the category name in
 * every installed language, and the status switch — exactly what the pasted legacy form
 * writes. The `:app` URL segment decides BOTH which `eType` row is touched and which
 * permission is demanded, so an admin holding only the parcel keys is refused on every
 * other app's path.
 *
 * The permission names are the ones seeded for sub-group 136 — view, update and
 * update-status (`*-service-category-parcel-delivery`). There is deliberately no
 * create or delete route: the master rows are seeded by the legacy app and only ever
 * edited, and the user scoped this screen to edit + status.
 */
const appParam = z.object({ app: z.enum(["delivery"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The three permission keys of each app's sub-group, by action. */
const PERMISSION_KEYS: Record<MasterCategoryAppKey, { view: string; update: string; status: string }> =
  {
    delivery: {
      view: "view-service-category-parcel-delivery",
      update: "update-service-category-parcel-delivery",
      status: "update-status-service-category-parcel-delivery",
    },
  };

/**
 * Demand the permission of the app in the URL. `validate` has already accepted the enum,
 * but the key is resolved through {@link requireScope} rather than indexing the param
 * directly, so no path can silently be guarded by another app's keys.
 */
function guard(action: "view" | "update" | "status") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireScope(req.params.app).app][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** Language codes are `vCategoryName_<CODE>` suffixes; the service re-checks the shape. */
const LANG_CODE = z.string().min(1).max(10);
// 26 installed languages plus a handful of legacy-only codes; each name is one short
// label, so the byte cap lives in the service.
const MAX_NAMES = 40;

const updateSchema = z
  .object({
    names: z.record(LANG_CODE, z.string()),
  })
  .superRefine((payload, ctx) => {
    const keys = Object.keys(payload.names);
    const tooMany = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // A `__proto__` key is dropped by zod's record builder (it sets the prototype
    // instead of adding an own property), so a payload of only such keys reaches the
    // service empty and would write nothing. Refuse it so the client gets a 400, not a
    // successful-looking no-op.
    if (!keys.length) tooMany("Send at least the language names that changed.");
    if (keys.length > MAX_NAMES) tooMany(`A save may change at most ${MAX_NAMES} languages.`);
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const masterServiceCategoryRouter = Router();

masterServiceCategoryRouter.use(requireAuth());

/** GET /api/master-service-category/:app/list — this app's master rows. */
masterServiceCategoryRouter.get(
  "/:app/list",
  validate({ params: appParam }),
  guard("view"),
  asyncHandler(ctrl.list),
);

/** GET /api/master-service-category/:app/:id — one row with names, icon, status, cascade. */
masterServiceCategoryRouter.get(
  "/:app/:id",
  validate({ params: idParam }),
  guard("view"),
  asyncHandler(ctrl.getOne),
);

/**
 * GET /api/master-service-category/:app/:id/image — stream the stored icon (cookie auth).
 * The name comes from the column, the bytes from this app's upload dir or, for a legacy
 * row, the read-only directory the old panel wrote to.
 */
masterServiceCategoryRouter.get(
  "/:app/:id/image",
  validate({ params: idParam }),
  guard("view"),
  asyncHandler(ctrl.image),
);

/**
 * POST /api/master-service-category/:app/:id/image — multipart attach or replace the icon.
 */
masterServiceCategoryRouter.post(
  "/:app/:id/image",
  validate({ params: idParam }),
  guard("update"),
  ctrl.iconUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PUT /api/master-service-category/:app/:id — merge changed names, keep every other key. */
masterServiceCategoryRouter.put(
  "/:app/:id",
  validate({ params: idParam, body: updateSchema }),
  guard("update"),
  asyncHandler(ctrl.update),
);

/** PATCH /api/master-service-category/:app/:id/status — activate / deactivate the row. */
masterServiceCategoryRouter.patch(
  "/:app/:id/status",
  validate({ params: idParam, body: statusSchema }),
  guard("status"),
  asyncHandler(ctrl.setStatus),
);
