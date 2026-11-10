import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/store/controllers/store.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });
const docParam = z.object({ id: fields.positiveInt, docId: fields.positiveInt });
const masterParam = z.object({ id: fields.positiveInt, masterId: fields.positiveInt });

const storeStatusEnum = z.enum(["Active", "Inactive"]);

// The listing is filtered AND paginated server-side (the shared `company`
// table also holds companies), so the browser never loads the whole catalog.
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: storeStatusEnum.optional(),
  serviceId: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email")
  .default("");
/** Legacy vCode / coordinate slots are short varchar columns; blank is legal. */
const blankOr = (regex: RegExp, message: string, max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => v === "" || regex.test(v), message)
    .default("");

const writeFields = {
  store: z.string().trim().min(1, "Store name is required").max(100),
  serviceId: fields.positiveInt,
  contactName: z.string().trim().max(100).default(""),
  firstName: z.string().trim().max(100).default(""),
  lastName: z.string().trim().max(100).default(""),
  email: optionalEmail,
  phone: z.string().trim().max(20).default(""),
  phoneCode: blankOr(/^[0-9+]{1,7}$/, "Invalid phone code", 20),
  address: z.string().trim().max(500).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().max(100).default(""),
  country: z.string().trim().max(100).default(""),
  zip: z.string().trim().max(50).default(""),
  location: z.string().trim().max(500).default(""),
  locationLat: blankOr(/^-?\d{1,3}(\.\d{1,12})?$/, "Invalid latitude", 50),
  locationLng: blankOr(/^-?\d{1,3}(\.\d{1,12})?$/, "Invalid longitude", 50),
  maxItemQty: z.coerce.number().int().min(0).max(9999).default(0),
  language: z.string().trim().max(10).default(""),
  currency: z.string().trim().max(10).default(""),
};

const createSchema = z.object({
  ...writeFields,
  status: storeStatusEnum.default("Active"),
  password: z
    .string()
    .max(72)
    .refine((v) => v === "" || v.length >= 10, "Password must be at least 10 characters")
    .optional(),
});

const updateSchema = z.object(writeFields);

const statusSchema = z.object({ status: storeStatusEnum });

const docStatusSchema = z
  .object({
    status: z.enum(["Active", "Inactive"]),
    reason: z.string().trim().max(500).default(""),
  })
  .refine((d) => d.status !== "Inactive" || d.reason.length > 0, {
    message: "A rejection reason is required",
    path: ["reason"],
  });

export const storeRouter = Router();

storeRouter.use(requireAuth());

// Literals (`/list`, `/industries`, `/export`) come before the `/:id`
// captures so they are never swallowed by the param route.
storeRouter.get(
  "/list",
  validate({ query: listQuery }),
  requirePermission("view-store"),
  asyncHandler(ctrl.list),
);

storeRouter.get("/industries", requirePermission("view-store"), asyncHandler(ctrl.industries));

storeRouter.get("/export", requirePermission("export-store"), asyncHandler(ctrl.exportCsv));

storeRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-store"),
  asyncHandler(ctrl.create),
);

storeRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-store"),
  asyncHandler(ctrl.getOne),
);

storeRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-store"),
  asyncHandler(ctrl.update),
);

storeRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-store"),
  asyncHandler(ctrl.toggleStatus),
);

storeRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-store"),
  asyncHandler(ctrl.remove),
);

// --- Store logo (streamed from the legacy Company/<id>/ directory) ---

storeRouter.get(
  "/:id/image",
  validate({ params: idParam }),
  requirePermission("view-store"),
  asyncHandler(ctrl.imageFile),
);

storeRouter.post(
  "/:id/image",
  validate({ params: idParam }),
  requirePermission("edit-store"),
  ctrl.imgUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

// --- Store documents ---

storeRouter.get(
  "/:id/documents",
  validate({ params: idParam }),
  requirePermission("edit-store-document"),
  asyncHandler(ctrl.documents),
);

storeRouter.get(
  "/:id/documents/:docId/file",
  validate({ params: docParam }),
  requirePermission("edit-store-document"),
  asyncHandler(ctrl.documentFile),
);

storeRouter.patch(
  "/:id/documents/:docId/status",
  validate({ params: docParam, body: docStatusSchema }),
  requirePermission("edit-store-document"),
  asyncHandler(ctrl.updateDocumentStatus),
);

storeRouter.post(
  "/:id/documents/:masterId/upload",
  validate({ params: masterParam }),
  requirePermission("edit-store-document"),
  ctrl.docUploadMiddleware,
  asyncHandler(ctrl.uploadDocument),
);
