import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/users/controllers/users.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

const userStatusEnum = z.enum(["Active", "Inactive"]);
const userTypeEnum = z.enum(["Driver", "Rider"]);
const genderEnum = z.enum(["", "Male", "Female"]);
const dateStr = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
  .or(z.literal(""))
  .default("");
// Email is optional (many legacy users have none) but must be valid when present.
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email")
  .default("");
const walletForEnum = z.enum([
  "Deposit",
  "Booking",
  "Refund",
  "Withdrawl",
  "Charges",
  "Referrer",
  "Transfer",
  "Subscription",
  "Outstanding",
  "Donation",
]);

const createSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(255),
  lastName: z.string().trim().max(255).default(""),
  email: optionalEmail,
  phone: z.string().trim().min(1, "Phone is required").max(50),
  phoneCode: z.string().trim().max(20).default(""),
  gender: genderEnum.default(""),
  birthDate: dateStr,
  userType: userTypeEnum.default("Rider"),
  status: userStatusEnum.default("Active"),
  password: z
    .string()
    .max(72)
    .refine((v) => v === "" || v.length >= 10, "Password must be at least 10 characters")
    .optional(),
});

const updateSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(255),
  lastName: z.string().trim().max(255).default(""),
  email: optionalEmail,
  phone: z.string().trim().min(1, "Phone is required").max(50),
  phoneCode: z.string().trim().max(20).default(""),
  gender: genderEnum.default(""),
  birthDate: dateStr,
});

const statusSchema = z.object({ status: userStatusEnum });

const walletSchema = z.object({
  amount: z.coerce.number().positive("Amount must be positive").max(1_000_000),
  eFor: walletForEnum.default("Deposit"),
  description: z.string().trim().max(255).default(""),
});

const docStatusSchema = z
  .object({
    status: z.enum(["Active", "Inactive"]),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((d) => d.status !== "Inactive" || d.reason.length > 0, {
    message: "A rejection reason is required",
    path: ["reason"],
  });

export const userRouter = Router();

userRouter.use(requireAuth());

// `/list` is declared before the `/:id` captures so the literal is never swallowed.
userRouter.get("/list", requirePermission("view-users"), asyncHandler(ctrl.list));

userRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-users"),
  asyncHandler(ctrl.create),
);

userRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-users"),
  asyncHandler(ctrl.getOne),
);

userRouter.get(
  "/:id/wallet",
  validate({ params: idParam }),
  requirePermission("view-users"),
  asyncHandler(ctrl.getWallet),
);

userRouter.post(
  "/:id/wallet",
  validate({ params: idParam, body: walletSchema }),
  requirePermission("add-wallet-balance"),
  asyncHandler(ctrl.addWallet),
);

userRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-users"),
  asyncHandler(ctrl.update),
);

userRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-users"),
  asyncHandler(ctrl.toggleStatus),
);

userRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-users"),
  asyncHandler(ctrl.remove),
);

// --- User documents ---

userRouter.get(
  "/:id/documents",
  validate({ params: idParam }),
  requirePermission("edit-user-document"),
  asyncHandler(ctrl.documents),
);

userRouter.get(
  "/:id/documents/:docId/file",
  validate({ params: z.object({ id: fields.positiveInt, docId: fields.positiveInt }) }),
  requirePermission("edit-user-document"),
  asyncHandler(ctrl.documentFile),
);

userRouter.patch(
  "/:id/documents/:docId/status",
  validate({
    params: z.object({ id: fields.positiveInt, docId: fields.positiveInt }),
    body: docStatusSchema,
  }),
  requirePermission("edit-user-document"),
  asyncHandler(ctrl.updateDocumentStatus),
);

userRouter.post(
  "/:id/documents/:masterId/upload",
  validate({ params: z.object({ id: fields.positiveInt, masterId: fields.positiveInt }) }),
  requirePermission("edit-user-document"),
  ctrl.docUploadMiddleware,
  asyncHandler(ctrl.uploadDocument),
);
