import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/driver-vehicles/controllers/driverVehicles.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

const statusEnum = z.enum(["Active", "Inactive"]);
// `driver_vehicle`.`eType` enum; the create form defaults to Ride.
const vehicleType = z.enum(["Ride", "Delivery", "UberX", "TrackService"]).default("Ride");
const currentYear = new Date().getFullYear();

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  driverId: z.coerce.number().int().min(0).optional(),
  status: statusEnum.optional(),
});

/** Core create/edit fields (legacy `vehicles.php` add-row identity columns). */
const writeFields = {
  makeId: z.coerce.number().int().positive("Make is required"),
  modelId: z.coerce.number().int().positive("Model is required"),
  year: z.coerce
    .number()
    .int()
    .min(1900, "Year looks too early")
    .max(currentYear + 1, `Year cannot exceed ${currentYear + 1}`),
  licencePlate: z.string().trim().min(1, "Licence plate is required").max(100),
  colour: z.string().trim().max(100).default(""),
  vehicleType,
};

const createSchema = z.object({
  driverId: z.coerce.number().int().positive("Driver is required"),
  ...writeFields,
});

// Editing keeps the vehicle on its driver, so driverId is not part of the body.
const updateSchema = z.object(writeFields);
const statusSchema = z.object({ status: statusEnum });

export const driverVehicleRouter = Router();

driverVehicleRouter.use(requireAuth());

// Literal `/list` and `/drivers` before the `/:id` capture so the param route
// can't swallow them.
driverVehicleRouter.get(
  "/list",
  validate({ query: listQuery }),
  requirePermission("view-provider-vehicles"),
  asyncHandler(ctrl.list),
);

driverVehicleRouter.get(
  "/drivers",
  requirePermission("view-provider-vehicles"),
  asyncHandler(ctrl.drivers),
);

driverVehicleRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-provider-vehicles"),
  asyncHandler(ctrl.create),
);

driverVehicleRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-provider-vehicles"),
  asyncHandler(ctrl.getOne),
);

driverVehicleRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-provider-vehicles"),
  asyncHandler(ctrl.update),
);

driverVehicleRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-provider-vehicles"),
  asyncHandler(ctrl.setStatus),
);

driverVehicleRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-provider-vehicles"),
  asyncHandler(ctrl.remove),
);
