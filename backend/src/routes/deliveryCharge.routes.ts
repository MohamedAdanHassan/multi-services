import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/delivery-charge/controllers/deliveryCharge.controller";
import {
  CHARGE_FIELDS,
  DISTANCE_RANGE_FIELDS,
  requireDeliveryChargeApp,
} from "../modules/delivery-charge/models/deliveryChargeModel";
import type { DeliveryChargeAppKey } from "../modules/delivery-charge/models/deliveryChargeModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Delivery Charges, the screen the `:app` segment gates. Unlike Vehicle Type, the
 * legacy `delivery_charges.php` had no service-line column to scope rows by: `?eType=genie`
 * changed only the permission keys the screen demanded, so Delivery Genie (#sub-154),
 * Delivery Runner (#sub-157) and the un-suffixed menu (group 9) all list and edit the
 * very same rows of one table. The `:app` segment therefore decides *which keys guard
 * the call* here, and only incidentally which zones the location dropdown offers —
 * which is exactly why the rows a Genie admin prices are the rows the Store app charges.
 *
 * Which fields exist at all is decided by two `configurations` switches (distance-wise
 * bands, Buy Any Service), so the route cannot enumerate them. It bounds the payload
 * — at most the columns this table owns, no empty map — and the service validates each
 * value against the column's own spec and against the switches.
 */
const appParam = z.object({ app: z.enum(["genie", "runner"]) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The permission keys each app's sub-group seeds, by action. */
const PERMISSION_KEYS: Record<
  DeliveryChargeAppKey,
  { view: string; create: string; edit: string; status: string; delete: string }
> = {
  genie: {
    view: "view-delivery-charges-genie-delivery",
    create: "create-delivery-charges-genie-delivery",
    edit: "edit-delivery-charges-genie-delivery",
    status: "update-status-delivery-charges-genie-delivery",
    delete: "delete-delivery-charges-genie-delivery",
  },
  // Delivery Runner's own five keys (sub-group 157, ids 838–841 with edit seeded last
  // as 847) over the same rows genie prices — the legacy screen asked for the
  // runner-suffixed keys while listing every row of `delivery_charges`, so the guard
  // differs and the data does not.
  runner: {
    view: "view-delivery-charges-runner-delivery",
    create: "create-delivery-charges-runner-delivery",
    edit: "edit-delivery-charges-runner-delivery",
    status: "update-status-delivery-charges-runner-delivery",
    delete: "delete-delivery-charges-runner-delivery",
  },
};

/** Demand the permission the `:app` segment maps to, so one path never uses another's key. */
function guard(action: "view" | "create" | "edit" | "status" | "delete") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireDeliveryChargeApp(req.params.app).key][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/** Legacy column names; the service owns the ranges and the switch checks. */
const NAME = z.string().min(1).max(64);
const MAX_VALUES = CHARGE_FIELDS.length + DISTANCE_RANGE_FIELDS.length;
// Amounts and distance bands. A blank string means "not set" and is stored as 0; the
// open-ended band may arrive as the sentinel, or as the ∞ the legacy list showed.
const chargeValue = z.union([z.string().max(24), z.number(), z.null()]);
// A zone id, or 0 for every location. An HTML select may send either as text.
const locationId = z.union([z.string().max(12), z.number().int()]);

const settingsMap = z.record(NAME, chargeValue);

const createSchema = z
  .object({
    locationId,
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

// A save may change the amounts, the zone, or both; the service refuses a scope change
// the switches do not allow, so the route only insists the call decided something.
const updateSchema = z
  .object({
    locationId: locationId.optional(),
    settings: settingsMap.optional(),
  })
  .refine(
    (body) => body.locationId !== undefined || (body.settings && Object.keys(body.settings).length > 0),
    { message: "Send the location, or the values that changed." },
  )
  .refine((body) => !body.settings || Object.keys(body.settings).length <= MAX_VALUES, {
    message: `A save may change at most ${MAX_VALUES} values.`,
    path: ["settings"],
  });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete hides a whole location's pricing, so the location label must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(120) });

export const deliveryChargeRouter = Router();

deliveryChargeRouter.use(requireAuth());

/** GET /api/delivery-charge/:app/list — the pricing schemes, paged or whole. */
deliveryChargeRouter.get(
  "/:app/list",
  guard("view"),
  validate({ params: appParam }),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/delivery-charge/:app/defaults — specs, zone choices and switches for the
 * add form. Declared before `/:app/:id`, which would otherwise read "defaults" as an id.
 */
deliveryChargeRouter.get(
  "/:app/defaults",
  guard("create"),
  validate({ params: appParam }),
  asyncHandler(ctrl.defaults),
);

/** GET /api/delivery-charge/:app/:id — one scheme with its specs and choices. */
deliveryChargeRouter.get(
  "/:app/:id",
  guard("view"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/delivery-charge/:app — price a location. */
deliveryChargeRouter.post(
  "/:app",
  guard("create"),
  validate({ params: appParam, body: createSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/delivery-charge/:app/:id — write the changed amounts. */
deliveryChargeRouter.put(
  "/:app/:id",
  guard("edit"),
  validate({ params: idParam, body: updateSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/delivery-charge/:app/:id/status — activate / deactivate a scheme. */
deliveryChargeRouter.patch(
  "/:app/:id/status",
  guard("status"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/delivery-charge/:app/:id — guarded soft delete. */
deliveryChargeRouter.delete(
  "/:app/:id",
  guard("delete"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);
