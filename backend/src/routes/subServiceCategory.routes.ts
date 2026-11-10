import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/sub-service-category/controllers/subServiceCategory.controller";
import type { SubCategoryAppKey } from "../modules/sub-service-category/models/subServiceCategoryModel";
import { requireScope } from "../modules/sub-service-category/models/subServiceCategoryModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Parcel Delivery → Manage Service Category sub-screen (#sub-136): the legacy
 * "Sub Service Category (Parcel)" list — the CHILD rows of one parent `vehicle_category`.
 * Scope is list + status + soft-delete plus a DRILL-DOWN (a row's "View" re-lists that
 * row's own children), so every endpoint also honours an OPTIONAL `?parent=<id>` locator:
 * the id of the parent whose children are in play. Absent means the app's ROOT (Parcel =
 * 178); when present the service proves it is the root or a descendant before touching
 * data, so this route can never reach another app's tree. The locator is a QUERY value on
 * reads AND writes alike, so bulk POSTs carry it the same way the list does.
 *
 * The `:app` URL segment decides which permission is demanded, resolved through
 * {@link requireScope} so no path is guarded by another app's keys.
 *
 * The permission names are the ones seeded for sub-group 136 that this screen uses:
 * view, update, update-status and delete (`*-service-category-parcel-delivery`).
 */
const appParam = z.object({ app: z.enum(["delivery"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** Optional drill-down locator; the service bounds it to the app's subtree. */
const parentQuery = z.object({ parent: z.string().regex(/^\d{1,9}$/).optional() });

const PERMISSION_KEYS: Record<
  SubCategoryAppKey,
  { view: string; update: string; status: string; delete: string }
> = {
  delivery: {
    view: "view-service-category-parcel-delivery",
    update: "update-service-category-parcel-delivery",
    status: "update-status-service-category-parcel-delivery",
    delete: "delete-service-category-parcel-delivery",
  },
};

function guard(action: "view" | "update" | "status" | "delete") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireScope(req.params.app).app][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

const listQuery = parentQuery.extend({
  keyword: z.string().trim().max(100).optional(),
  status: z.enum(["Active", "Inactive", "Deleted"]).optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/**
 * Rename / reorder body. Both halves are OPTIONAL — a save from the edit page posts only
 * what actually changed, so an order-only edit sends no names and a name-only edit no
 * order (the service writes nothing for the absent half). The service owns the real rules
 * — only ACTIVE installed language codes, trimmed text bounded to 200 chars, the default
 * language non-empty — so zod just keeps the shape sane before it gets there.
 */
const updateSchema = z.object({
  // Keys are language codes (the table column suffixes run up to 4 chars); the service
  // rejects any code that is not an active installed language.
  names: z.record(z.string().min(1).max(10), z.string().trim().max(300)).optional(),
  displayOrder: z.coerce.number().int().min(0).max(9_999).optional(),
});

/** One bulk action names at most this many ids; the service re-checks and de-duplicates. */
const bulkStatusSchema = z.object({
  ids: z.array(fields.positiveInt).min(1).max(200),
  status: z.enum(["Active", "Inactive"]),
});

const bulkDeleteSchema = z.object({
  ids: z.array(fields.positiveInt).min(1).max(200),
});

export const subServiceCategoryRouter = Router();

subServiceCategoryRouter.use(requireAuth());

/** GET /api/sub-service-category/:app/list — the parent's live children (searchable). */
subServiceCategoryRouter.get(
  "/:app/list",
  validate({ params: appParam, query: listQuery }),
  guard("view"),
  asyncHandler(ctrl.list),
);

/** GET /api/sub-service-category/:app/:id — one child's edit detail (names per language). */
subServiceCategoryRouter.get(
  "/:app/:id",
  validate({ params: idParam, query: parentQuery }),
  guard("view"),
  asyncHandler(ctrl.getOne),
);

/** PATCH /api/sub-service-category/:app/:id — rename a child / set its display order. */
subServiceCategoryRouter.patch(
  "/:app/:id",
  validate({ params: idParam, query: parentQuery, body: updateSchema }),
  guard("update"),
  asyncHandler(ctrl.update),
);

/** PATCH /api/sub-service-category/:app/:id/status — activate / deactivate one child. */
subServiceCategoryRouter.patch(
  "/:app/:id/status",
  validate({ params: idParam, query: parentQuery, body: statusSchema }),
  guard("status"),
  asyncHandler(ctrl.setStatus),
);

/** POST /api/sub-service-category/:app/bulk-status — activate / deactivate many children. */
subServiceCategoryRouter.post(
  "/:app/bulk-status",
  validate({ params: appParam, query: parentQuery, body: bulkStatusSchema }),
  guard("status"),
  asyncHandler(ctrl.bulkStatus),
);

/** DELETE /api/sub-service-category/:app/:id — soft-delete one child. */
subServiceCategoryRouter.delete(
  "/:app/:id",
  validate({ params: idParam, query: parentQuery }),
  guard("delete"),
  asyncHandler(ctrl.removeOne),
);

/** POST /api/sub-service-category/:app/bulk-delete — soft-delete many children. */
subServiceCategoryRouter.post(
  "/:app/bulk-delete",
  validate({ params: appParam, query: parentQuery, body: bulkDeleteSchema }),
  guard("delete"),
  asyncHandler(ctrl.bulkDelete),
);
