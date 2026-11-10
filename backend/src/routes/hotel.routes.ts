import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/hotel/controllers/hotel.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

const hotelStatusEnum = z.enum(["Active", "Inactive"]);
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email")
  .default("");
const short = (max: number) => z.string().trim().max(max).default("");

const writeFields = {
  firstName: z.string().trim().min(1, "Hotel name is required").max(100),
  lastName: short(100),
  email: optionalEmail,
  contactNo: short(20),
  code: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\+?[0-9]{1,7}$/.test(v), "Invalid phone code")
    .default(""),
  currency: short(30),
  language: short(10),
};

const createSchema = z.object({
  ...writeFields,
  status: hotelStatusEnum.default("Active"),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(72),
});

const updateSchema = z.object(writeFields);

const statusSchema = z.object({ status: hotelStatusEnum });

export const hotelRouter = Router();

hotelRouter.use(requireAuth());

// `/list` is declared before the `/:id` captures so the literal is never swallowed.
hotelRouter.get("/list", requirePermission("view-hotel"), asyncHandler(ctrl.list));

hotelRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-hotel"),
  asyncHandler(ctrl.create),
);

hotelRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-hotel"),
  asyncHandler(ctrl.getOne),
);

hotelRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-hotel"),
  asyncHandler(ctrl.update),
);

hotelRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-hotel"),
  asyncHandler(ctrl.toggleStatus),
);

hotelRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-hotel"),
  asyncHandler(ctrl.remove),
);

// --- Hotel logo ---

hotelRouter.get(
  "/:id/image",
  validate({ params: idParam }),
  requirePermission("view-hotel"),
  asyncHandler(ctrl.imageFile),
);

hotelRouter.post(
  "/:id/image",
  validate({ params: idParam }),
  requirePermission("edit-hotel"),
  ctrl.imgUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);
