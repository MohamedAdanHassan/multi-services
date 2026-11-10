import type { Request, Response } from "express";
import { AppError } from "../../../errors/AppError";
import { clientIp } from "../../../utils/http";
import * as audit from "../../audit/services/auditService";
import * as service from "../services/pushService";

/**
 * HTTP layer for Marketing Tools → Send Push-Notification (#sub-114).
 *
 * The sub-group has a single capability, `manage-send-push-notification`, and
 * every handler here is gated on exactly that — the reads (history, audience
 * preview) included, because the legacy screen was one page behind one
 * permission and this panel does not subdivide what the RBAC data does not.
 */

/** Audit events for push notification management. */
export const PushEvents = {
  Recorded: "push_notification_recorded",
} as const;

/** GET /api/push-notifications/history — recorded notifications, newest first. */
export async function history(req: Request, res: Response) {
  const out = await service.history(req.query.limit);
  res.json(out);
}

/** GET /api/push-notifications/preview — who a send would reach, and who it would not. */
export async function preview(req: Request, res: Response) {
  res.json(await service.plan(req.query));
}

/** GET /api/push-notifications/countries — countries present in an audience. */
export async function countries(req: Request, res: Response) {
  const rows = await service.countries(req.query);
  res.json({ countries: rows });
}

/**
 * POST /api/push-notifications/send — record a broadcast in
 * `pushnotification_log`, one row per reached recipient.
 */
export async function send(req: Request, res: Response) {
  const body = req.body as { message?: unknown; recipients?: unknown };
  if (!body || typeof body !== "object") throw AppError.badRequest("A JSON body is required.");
  const result = await service.send(body, clientIp(req));
  if (req.auth) {
    audit.logQuiet(req, PushEvents.Recorded, {
      adminId: req.auth.adminId,
      email: req.auth.email,
    });
  }
  res.status(201).json({ result });
}
