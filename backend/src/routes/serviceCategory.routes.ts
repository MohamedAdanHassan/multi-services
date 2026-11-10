import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/service-category/controllers/serviceCategory.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Taxi Service → Manage Service Category (#sub-13). The three permissions are the
 * ones seeded for that sub-group. There is no delete route — soft-deleted rows stay
 * hidden — but there is a create route (the legacy "Add New Taxi Service" screen):
 * `vehicle_category` has no auto-increment, so the model assigns `MAX(+1)`, and the
 * insert reuses the `update` permission because no `create-...` one was ever seeded.
 */
const idParam = z.object({ id: fields.positiveInt });

/** Legacy column and `<base>_<LANG>` key names; the service owns the whitelist. */
const NAME = z.string().min(1).max(64);
/** Nine JSON copy columns, at most 26 keys each today. */
const MAX_BLOCKS = 9;
const MAX_FIELDS_PER_BLOCK = 100;
const MAX_FIELDS_TOTAL = 600;

// Values are app-rendered copy, file names and settings, so the content rules live
// in the sanitizer and the service; the route only bounds the payload size.
const settingValue = z.union([z.string().max(64), z.number(), z.null()]);

const updateSchema = z
  .object({
    texts: z.record(NAME, z.record(NAME, z.string())).optional(),
    media: z.record(NAME, z.string()).optional(),
    settings: z.record(NAME, settingValue).optional(),
    blocks: z.record(NAME, z.record(NAME, z.string())).optional(),
  })
  .superRefine((payload, ctx) => {
    const tooMany = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // zod's record builder assigns parsed values by key, so a `__proto__` key (the
    // only dangerous one) never survives as an own property: such a group arrives
    // empty. Rejecting it turns "your save changed nothing" into a real 400
    // instead of a misleading 200.
    const requireKeys = (map: object, label: string) => {
      if (!Object.keys(map).length) tooMany(`${label} must name at least one value that changed.`);
    };

    if (payload.texts) {
      requireKeys(payload.texts, "The texts group");
      for (const [family, changed] of Object.entries(payload.texts)) {
        requireKeys(changed, `Text family “${family}”`);
      }
    }
    if (payload.media) requireKeys(payload.media, "The images group");
    if (payload.settings) requireKeys(payload.settings, "The settings group");

    const blocks = payload.blocks ?? {};
    const keys = Object.keys(blocks);
    if (keys.length > MAX_BLOCKS) {
      tooMany(`A save may touch at most ${MAX_BLOCKS} text blocks.`);
    }
    let total = 0;
    for (const [block, changed] of Object.entries(blocks)) {
      requireKeys(changed, `Block “${block}”`);
      const count = Object.keys(changed).length;
      total += count;
      if (count > MAX_FIELDS_PER_BLOCK) {
        tooMany(`Block “${block}” may send at most ${MAX_FIELDS_PER_BLOCK} fields.`);
      }
    }
    if (payload.blocks) requireKeys(blocks, "The blocks group");
    if (total > MAX_FIELDS_TOTAL) {
      tooMany(`A save may change at most ${MAX_FIELDS_TOTAL} text fields.`);
    }
    const empty =
      !payload.texts && !payload.media && !payload.settings && !keys.length;
    if (empty) tooMany("Send at least the texts, images, settings or blocks that changed.");
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A new category is created with only its English name; the content rules live in the service. */
const createSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["Active", "Inactive"]),
});

export const serviceCategoryRouter = Router();

serviceCategoryRouter.use(requireAuth());

/** GET /api/service-category/list — live Ride categories. */
serviceCategoryRouter.get(
  "/list",
  requirePermission("view-service-category-taxi-service"),
  asyncHandler(ctrl.list),
);

/** POST /api/service-category/create — add a new Ride category (name + status). */
serviceCategoryRouter.post(
  "/create",
  requirePermission("update-service-category-taxi-service"),
  validate({ body: createSchema }),
  asyncHandler(ctrl.create),
);

/** GET /api/service-category/:id — one category with every editable column. */
serviceCategoryRouter.get(
  "/:id",
  requirePermission("view-service-category-taxi-service"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** GET /api/service-category/:id/image — stream the stored icon (cookie auth). */
serviceCategoryRouter.get(
  "/:id/image",
  requirePermission("view-service-category-taxi-service"),
  validate({ params: idParam }),
  asyncHandler(ctrl.image),
);

/** POST /api/service-category/:id/image — multipart attach/replace the icon. */
serviceCategoryRouter.post(
  "/:id/image",
  requirePermission("update-service-category-taxi-service"),
  validate({ params: idParam }),
  ctrl.iconUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/** PUT /api/service-category/:id — write what changed in one UPDATE. */
serviceCategoryRouter.put(
  "/:id",
  requirePermission("update-service-category-taxi-service"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/service-category/:id/status — activate / deactivate a category. */
serviceCategoryRouter.patch(
  "/:id/status",
  requirePermission("update-status-service-category-taxi-service"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);
