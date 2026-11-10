import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/reviews/controllers/reviews.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Routes for Reviews (group 24). Six handlers, two per sub-group's three
 * capabilities (list / export / edit), each gated on that sub-group's own
 * permission name — the reads are gated too, because a list IS the `manage-*`
 * capability and there is no separate "view" row to honour. The service owns tab
 * legality, message rules and the empty-vs-all distinction; the schema here only
 * bounds sizes and shapes.
 */

const idParam = z.object({ id: fields.positiveInt });

// `subject` is not an enum: reviewsService.cleanSubject names the legal tabs in a
// readable sentence, and '' / "all" must pass through as "no tab narrowing".
const rideQuery = z.object({
  subject: z.string().trim().max(20).optional(),
  status: z.string().trim().max(20).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(20).optional(),
  dir: z.string().trim().max(4).optional(),
});

const editSchema = z.object({
  // An empty comment is a legal edit (it clears the text), so no min(1) here.
  message: z.string().max(4000),
});

export const reviewsRouter = Router();

reviewsRouter.use(requireAuth());

/** GET /api/reviews/rides — ride reviews for a tab (#sub-93). */
reviewsRouter.get(
  "/rides",
  requirePermission("manage-reviews"),
  validate({ query: rideQuery }),
  asyncHandler(ctrl.listRides),
);

/** GET /api/reviews/rides/export — CSV of the filtered ride reviews. */
reviewsRouter.get(
  "/rides/export",
  requirePermission("export-review"),
  validate({ query: rideQuery }),
  asyncHandler(ctrl.exportRides),
);

/** PUT /api/reviews/rides/:id/comment — rewrite a ride review's comment. */
reviewsRouter.put(
  "/rides/:id/comment",
  requirePermission("edit-review"),
  validate({ params: idParam, body: editSchema }),
  asyncHandler(ctrl.editRideComment),
);

/** GET /api/reviews/orders — store/order reviews for a tab (#sub-94). */
reviewsRouter.get(
  "/orders",
  requirePermission("manage-store-reviews"),
  validate({ query: rideQuery }),
  asyncHandler(ctrl.listOrders),
);

/** GET /api/reviews/orders/export — CSV of the filtered order reviews. */
reviewsRouter.get(
  "/orders/export",
  requirePermission("export-store-reviews"),
  validate({ query: rideQuery }),
  asyncHandler(ctrl.exportOrders),
);

/** PUT /api/reviews/orders/:id/comment — rewrite an order review's comment. */
reviewsRouter.put(
  "/orders/:id/comment",
  requirePermission("edit-store-reviews"),
  validate({ params: idParam, body: editSchema }),
  asyncHandler(ctrl.editOrderComment),
);
