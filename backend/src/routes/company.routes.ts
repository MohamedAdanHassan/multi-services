import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/company/controllers/company.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });
const docParam = z.object({ id: fields.positiveInt, docId: fields.positiveInt });
const masterParam = z.object({ id: fields.positiveInt, masterId: fields.positiveInt });

const companyStatusEnum = z.enum(["Active", "Inactive"]);
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email")
  .default("");

const writeFields = {
  company: z.string().trim().min(1, "Company name is required").max(100),
  contactName: z.string().trim().max(100).default(""),
  firstName: z.string().trim().max(100).default(""),
  lastName: z.string().trim().max(100).default(""),
  email: optionalEmail,
  phone: z.string().trim().min(1, "Phone is required").max(20),
  phoneCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\+?[0-9]{1,7}$/.test(v), "Invalid phone code")
    .default(""),
  address: z.string().trim().max(500).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().max(100).default(""),
  country: z.string().trim().max(100).default(""),
  zip: z.string().trim().max(50).default(""),
};

const createSchema = z.object({
  ...writeFields,
  status: companyStatusEnum.default("Active"),
  password: z
    .string()
    .max(72)
    .refine((v) => v === "" || v.length >= 10, "Password must be at least 10 characters")
    .optional(),
});

const updateSchema = z.object(writeFields);

const statusSchema = z.object({ status: companyStatusEnum });

const docStatusSchema = z
  .object({
    status: z.enum(["Active", "Inactive"]),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((d) => d.status !== "Inactive" || d.reason.length > 0, {
    message: "A rejection reason is required",
    path: ["reason"],
  });

export const companyRouter = Router();

companyRouter.use(requireAuth());

// `/list` is declared before the `/:id` captures so the literal is never swallowed.
companyRouter.get("/list", requirePermission("view-company"), asyncHandler(ctrl.list));

companyRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-company"),
  asyncHandler(ctrl.create),
);

companyRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-company"),
  asyncHandler(ctrl.getOne),
);

companyRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-company"),
  asyncHandler(ctrl.update),
);

companyRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-company"),
  asyncHandler(ctrl.toggleStatus),
);

companyRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-company"),
  asyncHandler(ctrl.remove),
);

// --- Company documents ---

companyRouter.get(
  "/:id/documents",
  validate({ params: idParam }),
  requirePermission("manage-company-document"),
  asyncHandler(ctrl.documents),
);

companyRouter.get(
  "/:id/documents/:docId/file",
  validate({ params: docParam }),
  requirePermission("manage-company-document"),
  asyncHandler(ctrl.documentFile),
);

companyRouter.patch(
  "/:id/documents/:docId/status",
  validate({ params: docParam, body: docStatusSchema }),
  requirePermission("manage-company-document"),
  asyncHandler(ctrl.updateDocumentStatus),
);

companyRouter.post(
  "/:id/documents/:masterId/upload",
  validate({ params: masterParam }),
  requirePermission("manage-company-document"),
  ctrl.docUploadMiddleware,
  asyncHandler(ctrl.uploadDocument),
);
