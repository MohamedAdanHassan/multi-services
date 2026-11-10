import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/distance-charge/controllers/distanceCharge.controller";
import {
  DISTANCE_BAND_FIELDS,
  DISTANCE_CHARGE_FIELDS,
  requireDistanceChargeApp,
} from "../modules/distance-charge/models/distanceChargeModel";
import type { DistanceChargeAppKey } from "../modules/distance-charge/models/distanceChargeModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Distance wise Delivery Charges, the child of Delivery Charges (#sub-154): bands of one
 * vehicle type that decide what a delivery pays over a given distance.
 *
 * The `:app` segment gates keys, never rows. The legacy
 * `admin368/custom_delivery_charge_order.php` read `?eType=genie|runner` and used it only
 * to pick which permission suffix to demand: `custom_delivery_charges_order` has no
 * service-line column, so Genie (group 33, sub-group 155), Runner (34/158) and the
 * un-suffixed menu (9/27) all edit the very same bands. What the segment does decide is
 * which `vehicle_type` line the dropdown offers, since the legacy form listed the delivery
 * types of that app (`eType='DeliverAll'` for Genie).
 *
 * The screen owns no status column and no route: rows are priced by distance alone on the
 * app side, so a hidden band would keep charging customers unseen, and the legacy action
 * ran a real `DELETE`.
 */
const appParam = z.object({ app: z.enum(["genie", "runner"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The permission keys each app's sub-group seeds, by action. */
const PERMISSION_KEYS: Record<
  DistanceChargeAppKey,
  { view: string; create: string; edit: string; delete: string }
> = {
  genie: {
    view: "view-custom-delivery-charges-genie-delivery",
    create: "create-custom-delivery-charges-genie-delivery",
    edit: "edit-custom-delivery-charges-genie-delivery",
    delete: "delete-custom-delivery-charges-genie-delivery",
  },
  // Delivery Runner's own four keys (sub-group 158, ids 842–845) over the same bands genie
  // prices — the legacy screen asked for the runner-suffixed keys while listing every row of
  // `custom_delivery_charges_order`, so the guard differs and the data does not. There is no
  // status key here either: 846 update-status was seeded Inactive and this screen owns no
  // status route, because a band the apps match on distance alone cannot be paused, only deleted.
  runner: {
    view: "view-custom-delivery-charges-runner-delivery",
    create: "create-custom-delivery-charges-runner-delivery",
    edit: "edit-custom-delivery-charges-runner-delivery",
    delete: "delete-custom-delivery-charges-runner-delivery",
  },
};

/** Demand the permission the `:app` segment maps to, so one path never uses another's key. */
function guard(action: "view" | "create" | "edit" | "delete") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireDistanceChargeApp(req.params.app).key][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** Legacy column names; the service owns the ranges, the chain rules and the read-only ones. */
const NAME = z.string().min(1).max(64);
const MAX_VALUES = DISTANCE_CHARGE_FIELDS.length + DISTANCE_BAND_FIELDS.length;
// Amounts and distance bounds. A blank string means "not set" and is stored as 0; the
// open-ended band may arrive as the sentinel, or as the ∞ the legacy list showed.
const chargeValue = z.union([z.string().max(24), z.number(), z.null()]);
// A vehicle type id. An HTML select sends its choice as text.
const vehicleTypeId = z.union([z.string().max(12), z.number().int()]);

const settingsMap = z.record(NAME, chargeValue);

const createSchema = z
  .object({
    vehicleTypeId,
    settings: settingsMap.optional(),
  })
  .refine((body) => !body.settings || Object.keys(body.settings).length > 0, {
    message: "The settings group must name at least one value, or be left out.",
    path: ["settings"],
  })
  .refine((body) => !body.settings || Object.keys(body.settings).length <= MAX_VALUES, {
    message: `A create may set at most ${MAX_VALUES} values.`,
    path: ["settings"],
  });

// A save changes the amounts, since the vehicle type and the band are frozen once the row
// exists; the route only insists the call decided something.
const updateSchema = z
  .object({
    vehicleTypeId: vehicleTypeId.optional(),
    settings: settingsMap.optional(),
  })
  .refine(
    (body) => body.vehicleTypeId !== undefined || (body.settings && Object.keys(body.settings).length > 0),
    { message: "Send the vehicle type, or the values that changed." },
  )
  .refine((body) => !body.settings || Object.keys(body.settings).length <= MAX_VALUES, {
    message: `A save may change at most ${MAX_VALUES} values.`,
    path: ["settings"],
  });

/** A delete removes a priced band for good, so the whole row has to be typed back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(120) });

export const distanceChargeRouter = Router();

distanceChargeRouter.use(requireAuth());

/** GET /api/distance-charge/:app/list — the distance bands, paged or whole. */
distanceChargeRouter.get(
  "/:app/list",
  guard("view"),
  validate({ params: appParam }),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/distance-charge/:app/defaults — specs, vehicle types, chains and switches for
 * the add form. Declared before `/:app/:id`, which would otherwise read "defaults" as an id.
 */
distanceChargeRouter.get(
  "/:app/defaults",
  guard("create"),
  validate({ params: appParam }),
  asyncHandler(ctrl.defaults),
);

/** GET /api/distance-charge/:app/:id — one band with its specs and choices. */
distanceChargeRouter.get(
  "/:app/:id",
  guard("view"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/distance-charge/:app — price the next band of a vehicle type. */
distanceChargeRouter.post(
  "/:app",
  guard("create"),
  validate({ params: appParam, body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/distance-charge/:app/:id — write the changed amounts. */
distanceChargeRouter.put(
  "/:app/:id",
  guard("edit"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** DELETE /api/distance-charge/:app/:id — confirmed hard delete. */
distanceChargeRouter.delete(
  "/:app/:id",
  guard("delete"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
