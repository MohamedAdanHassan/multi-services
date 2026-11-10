import type { Request, Response } from "express";
import { AppError } from "../../../errors/AppError";
import * as audit from "../../audit/services/auditService";
import * as service from "../services/reviewsService";

/**
 * HTTP layer for Reviews (group 24). Two read-only sub-screens plus one comment
 * edit each, mapped onto the permissions the RBAC data actually grants:
 *   #sub-93 Reviews         — manage-reviews / edit-review / export-review
 *   #sub-94 Orders Reviews  — manage-store-reviews / edit-store-reviews /
 *                             export-store-reviews
 * There is no create, delete, status or rating route: none of those permissions
 * exists in these sub-groups, so offering one would hand out a power no admin
 * holds. Only the two edits are audited — reads leave the data untouched.
 */

/** Audit events for review management. */
export const ReviewEvents = {
  RideCommentEdited: "ride_review_comment_edited",
  OrderCommentEdited: "order_review_comment_edited",
} as const;

function asQuery(req: Request): Record<string, unknown> {
  return req.query as Record<string, unknown>;
}

/** GET /api/reviews/rides — ride reviews for a tab, after filter + search + sort. */
export async function listRides(req: Request, res: Response) {
  const out = await service.listRides(asQuery(req));
  res.json({
    subject: out.subject,
    reviews: out.reviews,
    total: out.reviews.length,
    active: out.counts.active,
    deleted: out.counts.deleted,
    tabTotal: out.counts.total,
  });
}

/** GET /api/reviews/orders — store/order reviews for a tab, after filter + search + sort. */
export async function listOrders(req: Request, res: Response) {
  const out = await service.listOrders(asQuery(req));
  res.json({
    subject: out.subject,
    reviews: out.reviews,
    total: out.reviews.length,
    active: out.counts.active,
    deleted: out.counts.deleted,
    tabTotal: out.counts.total,
  });
}

// ---------------------------------------------------------------------------
// CSV export — the RFC 4180 + BOM shape used across the panel, and the exact
// same filters the table is showing, so a download never disagrees with it.
// ---------------------------------------------------------------------------

function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/reviews/rides/export — CSV of the filtered ride reviews. */
export async function exportRides(req: Request, res: Response) {
  const rows = await service.exportRides(asQuery(req));
  const header = ["ID", "Ride No", "Driver", "Passenger", "Rating", "Safety", "Comment", "Status", "Date"];
  const lines = [
    header.map(csvField).join(","),
    ...rows.map((r) =>
      [r.id, r.rideNo, r.driverName, r.passengerName, r.rating, r.safetyRating, r.message, r.status, r.date]
        .map(csvField)
        .join(","),
    ),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="reviews.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

/** GET /api/reviews/orders/export — CSV of the filtered order reviews. */
export async function exportOrders(req: Request, res: Response) {
  const rows = await service.exportOrders(asQuery(req));
  const header = ["ID", "Order No", "Store", "Driver", "Customer", "Rating", "Safety", "Comment", "Status", "Date"];
  const lines = [
    header.map(csvField).join(","),
    ...rows.map((r) =>
      [r.id, r.orderNo, r.companyName, r.driverName, r.passengerName, r.rating, r.safetyRating, r.message, r.status, r.date]
        .map(csvField)
        .join(","),
    ),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="store-reviews.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

/** Body of a comment edit: { id, message }. */
function readEdit(req: Request): { id: unknown; message: unknown } {
  const body = req.body as { id?: unknown; message?: unknown };
  if (!body || typeof body !== "object") throw AppError.badRequest("A JSON body is required.");
  return { id: body.id, message: body.message };
}

async function recordAudit(req: Request, event: string): Promise<void> {
  if (req.auth) {
    audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
  }
}

/** PUT /api/reviews/rides/:id/comment — rewrite the comment on a ride review. */
export async function editRideComment(req: Request, res: Response) {
  const { message } = readEdit(req);
  const result = await service.editRideComment(req.params.id, message);
  await recordAudit(req, ReviewEvents.RideCommentEdited);
  res.json({ result });
}

/** PUT /api/reviews/orders/:id/comment — rewrite the comment on an order review. */
export async function editOrderComment(req: Request, res: Response) {
  const { message } = readEdit(req);
  const result = await service.editOrderComment(req.params.id, message);
  await recordAudit(req, ReviewEvents.OrderCommentEdited);
  res.json({ result });
}
