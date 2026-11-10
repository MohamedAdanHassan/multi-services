import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/documents/controllers/documents.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const idParam = z.object({ id: fields.positiveInt });

const userTypeEnum = z.enum(["company", "driver", "car", "store", "user", "trackcompany"]);
const docStatusEnum = z.enum(["Active", "Inactive"]);
const exStatusEnum = z.enum(["yes", "no"]);
const docServiceTypeEnum = z.enum(["General", "ServiceSpecific", "BiddingSpecific"]);

// One geographic scope: 0 means "all" at that level. Existence + hierarchy are
// validated in the service layer (documentsService.validateScopes).
const geoScopeSchema = z.object({
  countryId: z.coerce.number().int().min(0).max(100000),
  stateId: z.coerce.number().int().min(0).max(1000000),
  cityId: z.coerce.number().int().min(0).max(10000000),
});
const geoScopesSchema = z.array(geoScopeSchema).max(100).default([]);

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
  userType: userTypeEnum,
  docServiceType: docServiceTypeEnum.default("General"),
  exStatus: exStatusEnum.default("no"),
  status: docStatusEnum.default("Active"),
  displayOrder: z.coerce.number().int().min(0).max(9999).default(1),
  geoScopes: geoScopesSchema,
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
  userType: userTypeEnum,
  docServiceType: docServiceTypeEnum,
  exStatus: exStatusEnum,
  status: docStatusEnum,
  displayOrder: z.coerce.number().int().min(0).max(9999),
  geoScopes: geoScopesSchema,
});

const statusSchema = z.object({ status: docStatusEnum });

const listQuerySchema = z.object({ userType: userTypeEnum.optional() });

// Language codes are validated against the known set; text is capped at the
// column width (255). Unknown keys are stripped so junk can never reach SQL.
const KNOWN_LANG_CODES = ["EN", "PTBR", "ZHCN", "CS", "FR", "HI", "PL", "RU", "SK", "SL", "UK", "KO", "JA", "RO", "SW", "HU", "BG", "EL", "NL", "AR", "IT", "SV", "ES", "LV", "DE", "ID"] as const;
const translationsSchema = z.object({
  languages: z
    .record(z.enum(KNOWN_LANG_CODES), z.string().trim().max(255))
    .refine((rec) => Object.keys(rec).length > 0, "Provide at least one language"),
});

export const documentRouter = Router();

documentRouter.use(requireAuth());

// `/list` before the `/:id` captures so the literal is never swallowed.
documentRouter.get(
  "/list",
  validate({ query: listQuerySchema }),
  requirePermission("view-documents"),
  asyncHandler(ctrl.list),
);

documentRouter.post(
  "/create",
  validate({ body: createSchema }),
  requirePermission("create-documents"),
  asyncHandler(ctrl.create),
);

documentRouter.get(
  "/:id",
  validate({ params: idParam }),
  requirePermission("view-documents"),
  asyncHandler(ctrl.getOne),
);

documentRouter.get(
  "/:id/translations",
  validate({ params: idParam }),
  requirePermission("view-documents"),
  asyncHandler(ctrl.translations),
);

documentRouter.put(
  "/:id/translations",
  validate({ params: idParam, body: translationsSchema }),
  requirePermission("edit-documents"),
  asyncHandler(ctrl.updateTranslations),
);

documentRouter.put(
  "/:id/update",
  validate({ params: idParam, body: updateSchema }),
  requirePermission("edit-documents"),
  asyncHandler(ctrl.update),
);

documentRouter.patch(
  "/:id/status",
  validate({ params: idParam, body: statusSchema }),
  requirePermission("update-status-documents"),
  asyncHandler(ctrl.toggleStatus),
);

documentRouter.delete(
  "/:id",
  validate({ params: idParam }),
  requirePermission("delete-documents"),
  asyncHandler(ctrl.remove),
);
