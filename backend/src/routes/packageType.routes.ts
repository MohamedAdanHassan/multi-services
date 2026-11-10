import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/package-type/controllers/packageType.controller";
import { PACKAGE_LANGUAGES } from "../modules/package-type/models/packageTypeModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Parcel Delivery → Package Type (#sub-139, display group 32). The five permissions
 * are the ones seeded for that sub-group: `*-package-type-parcel-delivery`.
 *
 * One row is a name in 26 per-language columns plus the delivery field it belongs
 * to, so the route only bounds the payload: which language codes may appear, how
 * long each may be, that a create carries English, and that a save changes
 * something. The content checks and the merge rules live in the service.
 */
const idParam = z.object({ id: fields.positiveInt });

/** A `texts` map: known language codes only, each a short label the app lists. */
const langCode = z.enum(PACKAGE_LANGUAGES.map((l) => l.code) as [string, ...string[]]);
const texts = z
  .record(langCode, z.string().max(200))
  .refine((t) => Object.keys(t).length > 0, { message: "Send at least one language." })
  .refine((t) => Object.keys(t).length <= PACKAGE_LANGUAGES.length, {
    message: `A save may touch at most ${PACKAGE_LANGUAGES.length} languages.`,
  });

const createSchema = z.object({
  // `texts` is required here: a refined schema has no `.required()`, and a record
  // named directly in an object is required anyway.
  texts,
  fieldId: z.union([z.string().max(12), z.number().int()]).optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const updateSchema = z
  .object({
    texts: texts.optional(),
    fieldId: z.union([z.string().max(12), z.number().int()]).optional(),
  })
  .refine((v) => v.texts !== undefined || v.fieldId !== undefined, {
    message: "Send the languages that changed, or a new delivery field.",
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete has no undo on this screen, so the row's own name must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(200) });

export const packageTypeRouter = Router();

packageTypeRouter.use(requireAuth());

/** GET /api/package-type/list — live package types. */
packageTypeRouter.get(
  "/list",
  requirePermission("view-package-type-parcel-delivery"),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/package-type/defaults — language columns and field choices for the add
 * form. Registered before the `:id` routes, which would otherwise swallow
 * “defaults” as an id.
 */
packageTypeRouter.get(
  "/defaults",
  requirePermission("create-package-type-parcel-delivery"),
  asyncHandler(ctrl.defaults),
);

/** GET /api/package-type/fields — delivery fields a package type can belong to. */
packageTypeRouter.get(
  "/fields",
  requirePermission("view-package-type-parcel-delivery"),
  asyncHandler(ctrl.fields),
);

/** GET /api/package-type/:id — one package type with every stored language. */
packageTypeRouter.get(
  "/:id",
  requirePermission("view-package-type-parcel-delivery"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/package-type — add a package type. */
packageTypeRouter.post(
  "/",
  requirePermission("create-package-type-parcel-delivery"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/package-type/:id — write the changed languages. */
packageTypeRouter.put(
  "/:id",
  requirePermission("edit-package-type-parcel-delivery"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/package-type/:id/status — activate / deactivate a package type. */
packageTypeRouter.patch(
  "/:id/status",
  requirePermission("update-status-package-type-parcel-delivery"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/package-type/:id — guarded soft delete. */
packageTypeRouter.delete(
  "/:id",
  requirePermission("delete-package-type-parcel-delivery"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
