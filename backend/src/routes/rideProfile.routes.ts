import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/ride-profile/controllers/rideProfile.controller";
import {
  MEDIA_COLUMNS,
  PROFILE_LANGUAGES,
  TEXT_BLOBS,
} from "../modules/ride-profile/models/rideProfileModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireAnyPermission, requirePermission } from "../middleware/rbac";

/**
 * Taxi Service → Manage Ride Profiles → Profiles (#sub-17-p91). The five permissions
 * are the ones seeded for that sub-group page.
 *
 * A profile is eight translated columns plus two bare file names, so the route only
 * bounds the payload: which field keys and language codes may appear, how many of
 * each, and that no group arrives empty. Column resolution, the content rules and
 * the blob merge all live in the service.
 */
const idParam = z.object({ id: fields.positiveInt });

const fieldKey = z.enum(TEXT_BLOBS.map((b) => b.key) as [string, ...string[]]);
const fileKey = z.enum(MEDIA_COLUMNS.map((m) => m.key) as [string, ...string[]]);
const langCode = z.enum(PROFILE_LANGUAGES.map((l) => l.code) as [string, ...string[]]);

/** Which artwork column a stream or upload concerns: `?field=image|welcomeImage`. */
const mediaQuery = z.object({ field: fileKey });

/** `<field> → <language> → text`; lengths are checked per column in the service. */
const texts = z
  .record(fieldKey, z.record(langCode, z.string().max(2_000)))
  .refine((t) => Object.keys(t).length > 0, { message: "The copy group must name at least one field." })
  .refine((t) => Object.keys(t).length <= TEXT_BLOBS.length, {
    message: `A save may touch at most ${TEXT_BLOBS.length} text fields.`,
  })
  .refine(
    (t) =>
      Object.values(t).every((byLang) => {
        const n = Object.keys(byLang).length;
        return n > 0 && n <= PROFILE_LANGUAGES.length;
      }),
    { message: `Each field must name between 1 and ${PROFILE_LANGUAGES.length} languages.` },
  );

const files = z
  .record(fileKey, z.string().max(255))
  .refine((f) => Object.keys(f).length > 0, { message: "The images group must name a field." })
  .refine((f) => Object.keys(f).length <= MEDIA_COLUMNS.length, {
    message: `A save may touch at most ${MEDIA_COLUMNS.length} images.`,
  });

const createSchema = z.object({
  // `texts` is required here: a refined schema has no `.required()`, and a record
  // named directly in an object is required anyway.
  texts,
  files: files.optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const updateSchema = z
  .object({
    texts: texts.optional(),
    files: files.optional(),
  })
  .refine((v) => v.texts !== undefined || v.files !== undefined, {
    message: "Send the copy or the images that changed.",
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete has no undo on this screen, so the profile's own name must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(120) });

export const rideProfileRouter = Router();

rideProfileRouter.use(requireAuth());

/** GET /api/ride-profile/list — live profiles. */
rideProfileRouter.get(
  "/list",
  requirePermission("view-profile-taxi-service"),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/ride-profile/defaults — the field and language specs an empty profile
 * would start from. Registered before the `:id` routes, which would otherwise
 * swallow “defaults” as an id.
 */
rideProfileRouter.get(
  "/defaults",
  requirePermission("create-profile-taxi-service"),
  asyncHandler(ctrl.defaults),
);

/** GET /api/ride-profile/:id — one profile with every stored language. */
rideProfileRouter.get(
  "/:id",
  requirePermission("view-profile-taxi-service"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/**
 * GET /api/ride-profile/:id/image?field=… — stream one artwork column (cookie auth).
 * The name comes from the column, the bytes from this app's upload dir or, for a
 * legacy row, the read-only directory the old panel wrote to.
 */
rideProfileRouter.get(
  "/:id/image",
  requirePermission("view-profile-taxi-service"),
  validate({ params: idParam, query: mediaQuery }),
  asyncHandler(ctrl.image),
);

/**
 * POST /api/ride-profile/:id/image?field=… — multipart attach or replace. Create is
 * accepted as well as edit: the add form has no row to upload to until the profile
 * exists, so it creates first and uploads the picked file straight after.
 */
rideProfileRouter.post(
  "/:id/image",
  requireAnyPermission(["edit-profile-taxi-service", "create-profile-taxi-service"]),
  validate({ params: idParam, query: mediaQuery }),
  ctrl.mediaUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** POST /api/ride-profile — add a profile. */
rideProfileRouter.post(
  "/",
  requirePermission("create-profile-taxi-service"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/ride-profile/:id — merge the changed copy and artwork. */
rideProfileRouter.put(
  "/:id",
  requirePermission("edit-profile-taxi-service"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/ride-profile/:id/status — activate / deactivate a profile. */
rideProfileRouter.patch(
  "/:id/status",
  requirePermission("update-status-profile-taxi-service"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/ride-profile/:id — guarded soft delete. */
rideProfileRouter.delete(
  "/:id",
  requirePermission("delete-profile-taxi-service"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
