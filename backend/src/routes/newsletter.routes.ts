import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/newsletter.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Routes for Marketing Tools → Newsletter Subscribers (#sub-113).
 *
 * Two GET endpoints, one per capability the sub-group actually grants. Both are
 * reads, so the CSRF middleware (which guards cookie-authenticated mutations)
 * never applies, and both filter in the service layer so the screen and the
 * exported file cannot drift apart.
 */

/** The two statuses are the enum's whole domain — there is no 'Deleted' member. */
const listQuery = z.object({
  status: z.enum(["all", "Subscribe", "Unsubscribe"]).optional(),
  search: z.string().max(100).optional(),
});

export const newsletterRouter = Router();

newsletterRouter.use(requireAuth());

/** GET /api/newsletter/list — every subscriber row, newest first, filtered. */
newsletterRouter.get(
  "/list",
  requirePermission("manage-newsletter"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.list),
);

/** GET /api/newsletter/export — CSV of the listing the filters leave. */
newsletterRouter.get(
  "/export",
  requirePermission("export-newsletter"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.exportCsv),
);
