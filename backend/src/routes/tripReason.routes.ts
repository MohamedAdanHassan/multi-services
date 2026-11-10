import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/trip-reason/controllers/tripReason.controller";
import { REASON_LANGUAGES } from "../modules/trip-reason/models/tripReasonModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Taxi Service → Manage Ride Profiles → Trip Reason (#sub-17-p96). The five
 * permissions are the ones seeded for that sub-group page.
 *
 * A reason is one piece of copy in 26 languages plus the profile it is filed
 * under, so the route only bounds the payload: which language codes may appear,
 * how long each may be, and that a create carries English. The merge rules and
 * the content checks live in the service.
 */
const idParam = z.object({ id: fields.positiveInt });

/** A `texts` map: known language codes only, each a short line of app copy. */
const langCode = z.enum(REASON_LANGUAGES.map((l) => l.code) as [string, ...string[]]);
const texts = z
  .record(langCode, z.string().max(200))
  .refine((t) => Object.keys(t).length > 0, { message: "Send at least one language." })
  .refine((t) => Object.keys(t).length <= REASON_LANGUAGES.length, {
    message: `A save may touch at most ${REASON_LANGUAGES.length} languages.`,
  });

const createSchema = z.object({
  // `texts` is required here: a refined schema has no `.required()`, and a record
  // named directly in an object is required anyway.
  texts,
  profileId: z.union([z.string().max(12), z.number().int()]).optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const updateSchema = z
  .object({
    texts: texts.optional(),
    profileId: z.union([z.string().max(12), z.number().int()]).optional(),
  })
  .refine((v) => v.texts !== undefined || v.profileId !== undefined, {
    message: "Send the languages that changed, or a new ride profile.",
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete has no undo on this screen, so the row's own title must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(200) });

export const tripReasonRouter = Router();

tripReasonRouter.use(requireAuth());

/** GET /api/trip-reason/list — live reasons. */
tripReasonRouter.get(
  "/list",
  requirePermission("view-trip-reason-taxi-service"),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/trip-reason/defaults — language tabs and profile choices for the add
 * form. Registered before the `:id` routes, which would otherwise swallow
 * “defaults” as an id.
 */
tripReasonRouter.get(
  "/defaults",
  requirePermission("create-trip-reason-taxi-service"),
  asyncHandler(ctrl.defaults),
);

/** GET /api/trip-reason/profiles — ride profiles a reason can be filed under. */
tripReasonRouter.get(
  "/profiles",
  requirePermission("view-trip-reason-taxi-service"),
  asyncHandler(ctrl.profiles),
);

/** GET /api/trip-reason/:id — one reason with every stored language. */
tripReasonRouter.get(
  "/:id",
  requirePermission("view-trip-reason-taxi-service"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/trip-reason — add a reason. */
tripReasonRouter.post(
  "/",
  requirePermission("create-trip-reason-taxi-service"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/trip-reason/:id — merge the changed languages. */
tripReasonRouter.put(
  "/:id",
  requirePermission("edit-trip-reason-taxi-service"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/trip-reason/:id/status — activate / deactivate a reason. */
tripReasonRouter.patch(
  "/:id/status",
  requirePermission("update-status-trip-reason-taxi-service"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/trip-reason/:id — guarded soft delete. */
tripReasonRouter.delete(
  "/:id",
  requirePermission("delete-trip-reason-taxi-service"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
