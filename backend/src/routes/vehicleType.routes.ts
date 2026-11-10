import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/vehicle-type/controllers/vehicleType.controller";
import {
  BLOB_COLUMNS,
  MEDIA_COLUMNS,
  SETTINGS,
  SURGE_KEYS,
  TEXT_FAMILIES,
  TYPE_LANGUAGES,
  requireVehicleTypeApp,
} from "../modules/vehicle-type/models/vehicleTypeModel";
import type { VehicleTypeAppKey } from "../modules/vehicle-type/models/vehicleTypeModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Vehicle Type, the screen the `:app` segment scopes. Taxi Service (#sub-15) owns
 * the `eType='Ride'` rows of the legacy `vehicle_type` table, Parcel Delivery
 * (#sub-138) the `eType='Deliver'` rows and Delivery Genie (#sub-153) the
 * `eType='DeliverAll'` rows the legacy `store_vehicle_type.php` screen served to
 * Genie, Runner and Store alike; Delivery Runner (#sub-156) is a fourth entry on the
 * very same `DeliverAll` rows, differing only in the keys that guard it. All four
 * drive this same lifecycle (list, create, edit, activate / deactivate, soft delete)
 * because `vehicle_type` is the
 * table the apps read to decide what can be booked. The `:app` segment decides both
 * the row scope (resolved in the controller) and which permission is demanded, so
 * no path is guarded by another app's keys — though genie and runner paths do reach
 * the same rows, exactly as the one legacy PHP file did.
 *
 * Column names, legal enum values and numeric ranges all live in the model and the
 * service, so the route only bounds the payload: which groups may appear, how many
 * keys each may carry, and that none of them arrives empty.
 */
const appParam = z.object({ app: z.enum(["ride", "delivery", "genie", "runner"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The permission keys each app's sub-group seeds, by action. */
const PERMISSION_KEYS: Record<
  VehicleTypeAppKey,
  { view: string; create: string; edit: string; status: string; delete: string }
> = {
  ride: {
    view: "view-vehicle-type-taxi-service",
    create: "create-vehicle-type-taxi-service",
    edit: "edit-vehicle-type-taxi-service",
    status: "update-status-vehicle-type-taxi-service",
    delete: "delete-vehicle-type-taxi-service",
  },
  delivery: {
    view: "view-vehicle-type-parcel-delivery",
    create: "create-vehicle-type-parcel-delivery",
    edit: "edit-vehicle-type-parcel-delivery",
    status: "update-status-vehicle-type-parcel-delivery",
    delete: "delete-vehicle-type-parcel-delivery",
  },
  genie: {
    view: "view-vehicle-type-genie-delivery",
    create: "create-vehicle-type-genie-delivery",
    edit: "edit-vehicle-type-genie-delivery",
    status: "update-status-vehicle-type-genie-delivery",
    delete: "delete-vehicle-type-genie-delivery",
  },
  // Delivery Runner's own five keys (sub-group 156, ids 833–837) over the same
  // `DeliverAll` rows genie edits — the legacy screen checked the runner-suffixed
  // keys while filtering rows by `eType = 'DeliverAll'`, so the guard differs and the
  // data does not.
  runner: {
    view: "view-vehicle-type-runner-delivery",
    create: "create-vehicle-type-runner-delivery",
    edit: "edit-vehicle-type-runner-delivery",
    status: "update-status-vehicle-type-runner-delivery",
    delete: "delete-vehicle-type-runner-delivery",
  },
};

/** Demand the permission the `:app` segment maps to, so one path never uses another's key. */
function guard(action: "view" | "create" | "edit" | "status" | "delete") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireVehicleTypeApp(req.params.app).key][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** Legacy column and `<base>_<LANG>` key names; the service owns the whitelist. */
const NAME = z.string().min(1).max(64);
const LANGS_PER_FAMILY = TYPE_LANGUAGES.length;
const MAX_TEXT_FAMILIES = TEXT_FAMILIES.length;
const MAX_MEDIA = MEDIA_COLUMNS.length;
const MAX_SETTINGS = SETTINGS.length;
/** The 4 global windows plus the 14 weekday ones. */
const MAX_TIMES = 4 + 14;
const MAX_SURGE_KEYS = SURGE_KEYS.length;
const MAX_BLOBS = BLOB_COLUMNS.length;
const MAX_FIELDS_PER_BLOB = LANGS_PER_FAMILY;
/** One save can at most touch every column this screen owns. */
const MAX_FIELDS_TOTAL = 300;

// Values are fare numbers, clock times, file names and app-rendered copy, so the
// content rules live in the sanitizer and the service; the route sizes the payload.
const settingValue = z.union([z.string().max(64), z.number(), z.null()]);
const timeValue = z.union([z.string().max(8), z.null()]);
// Zone / category ids: a sentinel (-1 / 0) or a referenced row's id, which the
// service checks exists. An HTML select may send either as text.
const scopeId = z.union([z.string().max(12), z.number().int()]);
const scopeSchema = z
  .object({ locationId: scopeId.optional(), categoryId: scopeId.optional() })
  .refine((s) => s.locationId !== undefined || s.categoryId !== undefined, {
    message: "The scope group must change a location or a category.",
  });

// What a create may carry: the name every app insists on, the artwork column the
// form keeps outside the settings groups, and the settings the app's own add form
// asks about (fares and seats for Taxi, delivery charges for Genie). Each key is
// looked up against the model's specs by the service, so the route only bounds size.
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    status: z.enum(["Active", "Inactive"]).optional(),
    logo: z.string().max(255).optional(),
    settings: z.record(NAME, settingValue).optional(),
    scope: scopeSchema.optional(),
  })
  .refine((body) => !body.settings || Object.keys(body.settings).length > 0, {
    message: "The settings group must name at least one column, or be left out.",
    path: ["settings"],
  })
  .refine((body) => !body.settings || Object.keys(body.settings).length <= MAX_SETTINGS, {
    message: `A create may set at most ${MAX_SETTINGS} columns.`,
    path: ["settings"],
  });

const updateSchema = z
  .object({
    texts: z.record(NAME, z.record(NAME, z.string())).optional(),
    media: z.record(NAME, z.string()).optional(),
    settings: z.record(NAME, settingValue).optional(),
    times: z.record(NAME, timeValue).optional(),
    surge: z.record(NAME, z.union([z.string().max(64), z.null()])).optional(),
    blobs: z.record(NAME, z.record(NAME, z.string())).optional(),
    scope: scopeSchema.optional(),
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
      const families = Object.keys(payload.texts);
      if (families.length > MAX_TEXT_FAMILIES) {
        tooMany(`A save may touch at most ${MAX_TEXT_FAMILIES} text groups.`);
      }
      for (const [family, changed] of Object.entries(payload.texts)) {
        requireKeys(changed, `Text group “${family}”`);
        if (Object.keys(changed).length > LANGS_PER_FAMILY) {
          tooMany(`Text group “${family}” may send at most ${LANGS_PER_FAMILY} languages.`);
        }
      }
    }
    if (payload.media) {
      requireKeys(payload.media, "The images group");
      if (Object.keys(payload.media).length > MAX_MEDIA) {
        tooMany(`A save may touch at most ${MAX_MEDIA} images.`);
      }
    }
    if (payload.settings) {
      requireKeys(payload.settings, "The settings group");
      if (Object.keys(payload.settings).length > MAX_SETTINGS) {
        tooMany(`A save may touch at most ${MAX_SETTINGS} settings.`);
      }
    }
    if (payload.times) {
      requireKeys(payload.times, "The schedule group");
      if (Object.keys(payload.times).length > MAX_TIMES) {
        tooMany(`A save may touch at most ${MAX_TIMES} schedule times.`);
      }
    }
    if (payload.surge) {
      requireKeys(payload.surge, "The night surcharge group");
      if (Object.keys(payload.surge).length > MAX_SURGE_KEYS) {
        tooMany(`A save may touch at most ${MAX_SURGE_KEYS} night surcharge values.`);
      }
    }

    const blobs = payload.blobs ?? {};
    const blobKeys = Object.keys(blobs);
    if (blobKeys.length > MAX_BLOBS) {
      tooMany(`A save may touch at most ${MAX_BLOBS} text blocks.`);
    }
    let total = 0;
    for (const [block, changed] of Object.entries(blobs)) {
      requireKeys(changed, `Block “${block}”`);
      const count = Object.keys(changed).length;
      total += count;
      if (count > MAX_FIELDS_PER_BLOB) {
        tooMany(`Block “${block}” may send at most ${MAX_FIELDS_PER_BLOB} fields.`);
      }
    }
    if (payload.blobs) requireKeys(blobs, "The blocks group");

    total += Object.keys(payload.texts ?? {}).length
      ? Object.values(payload.texts ?? {}).reduce((n, byLang) => n + Object.keys(byLang).length, 0)
      : 0;
    total += Object.keys(payload.media ?? {}).length;
    total += Object.keys(payload.settings ?? {}).length;
    total += Object.keys(payload.times ?? {}).length;
    total += Object.keys(payload.surge ?? {}).length;
    if (payload.scope) total += Object.keys(payload.scope).length;
    if (total > MAX_FIELDS_TOTAL) {
      tooMany(`A save may change at most ${MAX_FIELDS_TOTAL} values.`);
    }

    const empty =
      !payload.texts &&
      !payload.media &&
      !payload.settings &&
      !payload.times &&
      !payload.surge &&
      !payload.scope &&
      !blobKeys.length;
    if (empty) {
      tooMany("Send at least the texts, images, settings, schedule, scope or blocks that changed.");
    }
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete has no undo on this screen, so the row's own name must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(120) });

export const vehicleTypeRouter = Router();

vehicleTypeRouter.use(requireAuth());

/** GET /api/vehicle-type/:app/list — live types of one app. */
vehicleTypeRouter.get(
  "/:app/list",
  guard("view"),
  validate({ params: appParam }),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/vehicle-type/:app/defaults — specs for the add form. Registered before
 * the `/:app/:id` routes, which would otherwise swallow “defaults” as an id.
 */
vehicleTypeRouter.get(
  "/:app/defaults",
  guard("create"),
  validate({ params: appParam }),
  asyncHandler(ctrl.defaults),
);

/** GET /api/vehicle-type/:app/:id — one type with every editable column. */
vehicleTypeRouter.get(
  "/:app/:id",
  guard("view"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/vehicle-type/:app — add a type to this app's scope. */
vehicleTypeRouter.post(
  "/:app",
  guard("create"),
  validate({ params: appParam, body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/vehicle-type/:app/:id — write what changed in one UPDATE. */
vehicleTypeRouter.put(
  "/:app/:id",
  guard("edit"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/vehicle-type/:app/:id/status — activate / deactivate a type. */
vehicleTypeRouter.patch(
  "/:app/:id/status",
  guard("status"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/vehicle-type/:app/:id — guarded soft delete. */
vehicleTypeRouter.delete(
  "/:app/:id",
  guard("delete"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
