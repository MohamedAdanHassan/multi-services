import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/drivers/controllers/drivers.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

const driverStatusEnum = z.enum(["active", "inactive", "Suspend"]);
const availabilityEnum = z.enum(["Available", "Not Available"]);
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

const genderEnum = z.enum(["", "Male", "Female"]).default("");
const optionalBirthDate = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Invalid date (use YYYY-MM-DD)")
  .default("");
const text = (max = 255) => z.string().trim().max(max).default("");
/** `register_driver.vCountry` keeps the ISO-2 code, not the country id. */
const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Pick a country (2-letter code)");
/** `vLang` / `vCurrencyDriver` keep short codes from the reference tables. */
const refCode = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,10}$/, `Pick a valid ${label}`);

const personalFields = {
  gender: genderEnum,
  birthDate: optionalBirthDate,
  address: text(),
  address2: text(),
  city: text(),
  state: text(),
  zip: text(40),
};

/**
 * Fields the legacy "Add Service Provider" screen marks with a red asterisk
 * (name, last name, phone, country, language, currency, company) plus the
 * supporting columns those pickers auto-fill.
 */
const requiredFields = {
  firstName: z.string().trim().min(1, "First name is required").max(255),
  lastName: z.string().trim().min(1, "Last name is required").max(255),
  phone: z.string().trim().min(1, "Phone is required").max(50),
  country: countryCode,
  language: refCode("language"),
  currency: refCode("currency"),
  companyId: z.coerce.number().int().positive("Company / store is required"),
};

/** Columns shared by create + update that the legacy form leaves optional. */
const optionalWriteFields = {
  phoneCode: text(20),
  paymentEmail: optionalEmail,
  accountHolderName: text(),
  accountNumber: text(100),
  bankName: text(),
  bankLocation: text(),
  swiftCode: text(100),
  description: z.string().trim().max(65000).default(""),
};

const createSchema = z.object({
  email: optionalEmail,
  company: z.string().trim().max(255).default(""),
  carType: z.string().trim().max(255).default(""),
  status: driverStatusEnum.default("inactive"),
  availability: availabilityEnum.default("Not Available"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(72, "Password is too long (max 72 characters)")
    .refine((v) => v.length >= 10, "Password must be at least 10 characters"),
  serviceId: z.coerce.number().int().min(0).max(100000).default(0),
  ...requiredFields,
  ...personalFields,
  ...optionalWriteFields,
});

const updateSchema = z.object({
  email: optionalEmail,
  company: z.string().trim().max(255).default(""),
  carType: z.string().trim().max(255).default(""),
  ...requiredFields,
  ...personalFields,
  ...optionalWriteFields,
});

const statusSchema = z.object({ status: driverStatusEnum });
const availabilitySchema = z.object({ availability: availabilityEnum });
const featuredSchema = z.object({ featured: z.boolean() });

const walletSchema = z.object({
  amount: z.coerce.number().positive("Amount must be positive").max(1_000_000),
  eFor: walletForEnum.default("Deposit"),
  description: z.string().trim().max(255).default(""),
});

const servicesSchema = z.object({
  serviceIds: z.array(z.number().int().positive()).max(200),
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

export const driverRouter = Router();

driverRouter.use(requireAuth());

driverRouter.get("/list", requirePermission("view-providers"), asyncHandler(ctrl.list));

// Reference pickers for the create/edit form. Declared before `/:id` so the
// path param matcher (and its positive-int validation) cannot swallow them.
driverRouter.get(
  "/service-categories",
  requirePermission("view-providers"),
  asyncHandler(ctrl.serviceCategories),
);

driverRouter.get(
  "/company-options",
  requirePermission("view-providers"),
  asyncHandler(ctrl.companyOptions),
);

driverRouter.get(
  "/:id/photo",
  validate({ params: idParam }),
  requirePermission("view-providers"),
  asyncHandler(ctrl.photo),
);

driverRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-providers"),
  asyncHandler(ctrl.getOne),
);

driverRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-providers"),
  asyncHandler(ctrl.create),
);

driverRouter.get(
  "/:id/wallet",
  validate({ params: idParam }),
  requirePermission("view-providers"),
  asyncHandler(ctrl.getWallet),
);

driverRouter.post(
  "/:id/wallet",
  validate({ params: idParam, body: walletSchema }),
  requirePermission("add-wallet-balance-provider"),
  asyncHandler(ctrl.addWallet),
);

driverRouter.get(
  "/:id/documents",
  validate({ params: idParam }),
  requirePermission("edit-provider-document"),
  asyncHandler(ctrl.documents),
);

driverRouter.get(
  "/:id/documents/:docId/file",
  validate({ params: z.object({ id: fields.positiveInt, docId: fields.positiveInt }) }),
  requirePermission("edit-provider-document"),
  asyncHandler(ctrl.documentFile),
);

driverRouter.patch(
  "/:id/documents/:docId/status",
  validate({
    params: z.object({ id: fields.positiveInt, docId: fields.positiveInt }),
    body: docStatusSchema,
  }),
  requirePermission("edit-provider-document"),
  asyncHandler(ctrl.updateDocumentStatus),
);

driverRouter.post(
  "/:id/documents/:masterId/upload",
  validate({ params: z.object({ id: fields.positiveInt, masterId: fields.positiveInt }) }),
  requirePermission("edit-provider-document"),
  ctrl.docUploadMiddleware,
  asyncHandler(ctrl.uploadDocument),
);

driverRouter.get(
  "/:id/services",
  validate({ params: idParam }),
  requirePermission("manage-provider-services"),
  asyncHandler(ctrl.getServices),
);

driverRouter.put(
  "/:id/services",
  validate({ params: idParam, body: servicesSchema }),
  requirePermission("manage-provider-services"),
  asyncHandler(ctrl.setServices),
);

driverRouter.post(
  "/:id/photo",
  validate({ params: idParam }),
  requirePermission("edit-providers"),
  ctrl.photoUploadMiddleware,
  asyncHandler(ctrl.uploadPhoto),
);

driverRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-providers"),
  asyncHandler(ctrl.update),
);

driverRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-providers"),
  asyncHandler(ctrl.toggleStatus),
);

driverRouter.patch(
  "/:id/availability",
  validate({ params: idParam, body: availabilitySchema }),
  requirePermission("edit-availability"),
  asyncHandler(ctrl.setAvailability),
);

driverRouter.patch(
  "/:id/featured",
  validate({ params: idParam, body: featuredSchema }),
  requirePermission("edit-providers"),
  asyncHandler(ctrl.toggleFeatured),
);

driverRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-providers"),
  asyncHandler(ctrl.remove),
);
