import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/service-content/controllers/serviceContent.controller";
import type { ContentAppKey } from "../modules/service-content/models/serviceContentModel";
import { requireScope } from "../modules/service-content/models/serviceContentModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * "Manage Service/Content", serving two display groups out of one legacy table:
 * Taxi Service → #sub-12 edits the `eFor='Ride'` rows (six today, eleven blocks each)
 * and Parcel Delivery → #sub-135 edits the `eFor='Delivery'` row (one today, eight
 * blocks). The `:app` URL segment therefore decides BOTH which rows are visible and
 * which permission is demanded, so an admin holding only the parcel keys can browse
 * and save delivery copy and is refused on every `/ride/…` path.
 *
 * The permission names are the ones seeded for each sub-group — view, update and
 * update-status. There is deliberately no create/delete route: content rows are seeded
 * by the legacy app and only ever edited.
 */
const appParam = z.object({ app: z.enum(["ride", "delivery"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The three permission keys of each app's sub-group, by action. */
const PERMISSION_KEYS: Record<ContentAppKey, { view: string; update: string; status: string }> = {
  ride: {
    view: "view-service-content-taxi-service",
    update: "update-service-content-taxi-service",
    status: "update-status-service-content-taxi-service",
  },
  delivery: {
    view: "view-service-content-parcel-delivery",
    update: "update-service-content-parcel-delivery",
    status: "update-status-service-content-parcel-delivery",
  },
};

/**
 * Demand the permission of the app in the URL. `validate` has already accepted the enum,
 * but the key is resolved through {@link requireScope} rather than indexing the param
 * directly, so no path can silently be guarded by the other app's keys.
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

/** Field names are legacy `<field>_<LANG>` keys; the service re-checks the shape. */
const FIELD_NAME = z.string().min(1).max(64);
/** At most ~150 such keys per block in the legacy rows; eleven blocks is the larger app. */
const MAX_SECTIONS = 11;
const MAX_FIELDS_PER_SECTION = 200;
const MAX_FIELDS_TOTAL = 1_000;

// Content values are HTML fragments and file names, so length/type rules live in
// the sanitizer (one section blob has dozens of legacy keys).
const updateSchema = z
  .object({
    meta: z
      .object({
        title: z.string(),
        keyword: z.string(),
        description: z.string(),
      })
      .partial()
      .optional(),
    sections: z.record(FIELD_NAME, z.record(FIELD_NAME, z.string())).optional(),
  })
  .superRefine((payload, ctx) => {
    const tooMany = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // A `__proto__` key is dropped by zod's record builder (it sets the prototype
    // instead of adding an own property), so such a group reaches the service
    // empty and would write nothing. Refuse it so the client gets a 400, not a
    // successful-looking no-op.
    const requireKeys = (map: object, label: string) => {
      if (!Object.keys(map).length) tooMany(`${label} must name at least one value that changed.`);
    };

    if (payload.meta) requireKeys(payload.meta, "The page meta group");

    const sections = payload.sections ?? {};
    const keys = Object.keys(sections);
    if (keys.length > MAX_SECTIONS) {
      tooMany(`A save may touch at most ${MAX_SECTIONS} content sections.`);
    }
    let total = 0;
    for (const [section, changed] of Object.entries(sections)) {
      requireKeys(changed, `Section “${section}”`);
      const count = Object.keys(changed).length;
      total += count;
      if (count > MAX_FIELDS_PER_SECTION) {
        tooMany(`Section “${section}” may send at most ${MAX_FIELDS_PER_SECTION} fields.`);
      }
    }
    if (payload.sections) requireKeys(sections, "The sections group");
    if (total > MAX_FIELDS_TOTAL) {
      tooMany(`A save may change at most ${MAX_FIELDS_TOTAL} fields.`);
    }
    if (!payload.meta && !keys.length) {
      tooMany("Send the meta fields or the section fields that changed.");
    }
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

export const serviceContentRouter = Router();

serviceContentRouter.use(requireAuth());

/** GET /api/service-content/:app/list — this app's content rows. */
serviceContentRouter.get(
  "/:app/list",
  validate({ params: appParam }),
  guard("view"),
  asyncHandler(ctrl.list),
);

/** GET /api/service-content/:app/:id — one row with all of this app's section blobs. */
serviceContentRouter.get(
  "/:app/:id",
  validate({ params: idParam }),
  guard("view"),
  asyncHandler(ctrl.getOne),
);

/** PUT /api/service-content/:app/:id — merge changed fields, keep every other key. */
serviceContentRouter.put(
  "/:app/:id",
  validate({ params: idParam, body: updateSchema }),
  guard("update"),
  asyncHandler(ctrl.update),
);

/** PATCH /api/service-content/:app/:id/status — activate / deactivate a page. */
serviceContentRouter.patch(
  "/:app/:id/status",
  validate({ params: idParam, body: statusSchema }),
  guard("status"),
  asyncHandler(ctrl.setStatus),
);
