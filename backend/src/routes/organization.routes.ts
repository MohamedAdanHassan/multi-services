import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/organization/controllers/organization.controller";
import { ORGANIZATION_MEDIA_KEYS } from "../modules/organization/services/organizationService";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireAnyPermission, requirePermission } from "../middleware/rbac";

/**
 * Taxi Service → Manage Ride Profiles → Organizations (#sub-17-p90).
 *
 * The seeded keys for this page carry no `-taxi-service` suffix (`view-organization`,
 * `create-organization`, …) while the profile and trip-reason pages in the same
 * sub-group do, so the names below follow the seed rather than the neighbouring
 * module — a route guarded by an invented key would be unreachable for every admin
 * except a super user.
 *
 * The ceilings are the real column widths of the legacy table; the service repeats them
 * with field-named messages and owns the semantic rules (email uniqueness, ride-profile
 * existence, coordinate shape).
 */
const idParam = z.object({ id: fields.positiveInt });

const text = (max: number) => z.string().trim().max(max).optional();
const email = (max: number) => z.string().trim().max(max).email("Invalid email").optional();

const organizationSchema = z
  .object({
    company: text(255),
    email: email(1000),
    phoneCode: text(10),
    // `vPhone` is varchar(11): the local number only, without the country code.
    phone: text(11),
    address: text(255),
    city: text(255),
    state: text(255),
    zip: text(255),
    country: text(200),
    language: text(10),
    currency: text(10),
    location: text(500),
    latitude: text(50),
    longitude: text(50),
    radius: z.coerce.number().int().min(0).max(100_000).optional(),
    image: text(255),
    coverImage: text(255),
    paymentEmail: email(500),
    accountHolder: text(500),
    accountNumber: text(500),
    bankName: text(500),
    bankLocation: text(500),
    swiftCode: text(500),
    profileId: z.coerce.number().int().positive().optional(),
    paymentBy: z.enum(["Passenger", "Organization"]).optional(),
    status: z.enum(["Active", "Inactive"]).optional(),
    // Optional on create as well: an organization added without a password is managed
    // from this screen but cannot sign in to the legacy panel.
    password: fields.password.optional(),
    loginId: text(100),
  })
  // An empty body would otherwise be accepted as a "change nothing" write.
  .refine((v) => Object.keys(v).length > 0, { message: "Send at least one field to write." });

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/** A delete hides the account from every report, so its own name must come back. */
const deleteSchema = z.object({ confirm: z.string().trim().min(1).max(255) });

/** Which artwork column a stream or upload concerns: `?field=image|coverImage`. */
const fileKey = z.enum([...ORGANIZATION_MEDIA_KEYS] as [string, ...string[]]);
const mediaQuery = z.object({ field: fileKey });

export const organizationRouter = Router();

organizationRouter.use(requireAuth());

/** GET /api/organization/list — live organizations. */
organizationRouter.get(
  "/list",
  requirePermission("view-organization"),
  asyncHandler(ctrl.list),
);

/**
 * GET /api/organization/export — the listing as CSV. Registered before `/:id`, which
 * would otherwise swallow “export” as an id. The payout block is not exported.
 */
organizationRouter.get(
  "/export",
  requirePermission("export-organization"),
  asyncHandler(ctrl.exportCsv),
);

/**
 * GET /api/organization/defaults — an empty organization plus the ride profiles the
 * picker may offer.
 */
organizationRouter.get(
  "/defaults",
  requirePermission("create-organization"),
  asyncHandler(ctrl.defaults),
);

/** GET /api/organization/profiles — ride profiles an organization can be filed under. */
organizationRouter.get(
  "/profiles",
  requirePermission("view-organization"),
  asyncHandler(ctrl.profiles),
);

/** GET /api/organization/:id — one organization, payout block included. */
organizationRouter.get(
  "/:id",
  requirePermission("view-organization"),
  validate({ params: idParam }),
  asyncHandler(ctrl.getOne),
);

/** POST /api/organization — add an organization. */
organizationRouter.post(
  "/",
  requirePermission("create-organization"),
  validate({ body: organizationSchema }),
  asyncHandler(ctrl.create),
);

/** PUT /api/organization/:id — write only the fields the request names. */
organizationRouter.put(
  "/:id",
  requirePermission("edit-organization"),
  validate({ params: idParam, body: organizationSchema }),
  asyncHandler(ctrl.update),
);

/** PATCH /api/organization/:id/status — activate / deactivate an account. */
organizationRouter.patch(
  "/:id/status",
  requirePermission("update-status-organization"),
  validate({ params: idParam, body: statusSchema }),
  asyncHandler(ctrl.setStatus),
);

/** DELETE /api/organization/:id — guarded soft delete. */
organizationRouter.delete(
  "/:id",
  requirePermission("delete-organization"),
  validate({ params: idParam, body: deleteSchema }),
  asyncHandler(ctrl.remove),
);

/** GET /api/organization/:id/image?field=image|coverImage — stream one artwork column. */
organizationRouter.get(
  "/:id/image",
  requirePermission("view-organization"),
  validate({ params: idParam, query: mediaQuery }),
  asyncHandler(ctrl.image),
);

/**
 * POST /api/organization/:id/image?field=… — attach or replace one artwork column.
 * Create is accepted as well as edit: the add form has no row to upload to until the
 * organization exists, so its first picture is posted right after the POST that made it.
 */
organizationRouter.post(
  "/:id/image",
  requireAnyPermission(["edit-organization", "create-organization"]),
  validate({ params: idParam, query: mediaQuery }),
  ctrl.mediaUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);
