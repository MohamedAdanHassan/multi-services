import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/supportRequests/controllers/supportRequests.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

// Shared query schema for the three report listings; date-format and
// from≤to rules are enforced in supportRequestsService.
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  from: z.string().trim().max(10).optional(),
  to: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// SOS adds the legacy panel's extra refinements (user / service provider /
// trip-job number); 0 is treated as "all" in the service.
const sosListQuery = listQuery.extend({
  userId: z.coerce.number().int().min(0).optional(),
  driverId: z.coerce.number().int().min(0).optional(),
  tripNumber: z.string().trim().max(50).optional(),
});

// Contact Us adds the legacy panel's User Type filter (the eUserType enum).
const contactUsListQuery = listQuery.extend({
  userType: z.enum(["Passenger", "Driver", "Company", "Guest"]).optional(),
});

// Payment Requests adds the legacy panel's Status filter (eMarkAsDone enum).
const paymentListQuery = listQuery.extend({
  status: z.enum(["Yes", "No"]).optional(),
});

export const supportRequestsRouter = Router();

supportRequestsRouter.use(requireAuth());

/** GET /api/support-requests/contact-us/list — Contact Us submissions (#sub-103). */
supportRequestsRouter.get(
  "/contact-us/list",
  requirePermission("view-contactus-report"),
  validate({ query: contactUsListQuery }),
  asyncHandler(ctrl.contactUsList),
);

/** GET /api/support-requests/sos/list — SOS/emergency requests (#sub-104). */
supportRequestsRouter.get(
  "/sos/list",
  requirePermission("view-sos-request-report"),
  validate({ query: sosListQuery }),
  asyncHandler(ctrl.sosList),
);

/** GET /api/support-requests/sos/options — SOS filter dropdown sources. */
supportRequestsRouter.get(
  "/sos/options",
  requirePermission("view-sos-request-report"),
  asyncHandler(ctrl.sosOptions),
);

/** GET /api/support-requests/payment/list — driver payment requests (#sub-107). */
supportRequestsRouter.get(
  "/payment/list",
  requirePermission("view-payment-request-report"),
  validate({ query: paymentListQuery }),
  asyncHandler(ctrl.paymentList),
);

/** GET /api/support-requests/trip-job-help/list — Trips/Jobs Help (#sub-105). */
supportRequestsRouter.get(
  "/trip-job-help/list",
  requirePermission("view-trip-job-help-request-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.tripJobHelpList),
);

/** GET /api/support-requests/order-help/list — Order Help (#sub-106). */
supportRequestsRouter.get(
  "/order-help/list",
  requirePermission("view-order-help-request-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.orderHelpList),
);

/** GET /api/support-requests/withdraw/list — Withdraw Requests (#sub-108). */
supportRequestsRouter.get(
  "/withdraw/list",
  requirePermission("view-withdraw-request-report"),
  validate({ query: paymentListQuery }),
  asyncHandler(ctrl.withdrawList),
);
