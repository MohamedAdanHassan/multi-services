import type { Request, Response } from "express";
import type { ContentAppKey, ContentStatus } from "../models/serviceContentModel";
import { requireScope } from "../models/serviceContentModel";
import * as service from "../services/serviceContentService";
import * as audit from "../../audit/services/auditService";

/**
 * Audit events, one pair per app. The Taxi Service names are what existing
 * `admin_audit_log` rows already carry, so they stay exactly as they were; the
 * Parcel Delivery pair is new. Both fit the 50-character event column.
 */
const SERVICE_CONTENT_EVENTS: Record<ContentAppKey, { updated: string; statusChanged: string }> = {
  ride: {
    updated: "service_content_updated",
    statusChanged: "service_content_status_changed",
  },
  delivery: {
    updated: "parcel_service_content_updated",
    statusChanged: "parcel_service_content_status_changed",
  },
};

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * Which app the request is addressed as. The route's zod enum normally guarantees
 * the name, so this is the backstop that refuses an unmapped path instead of
 * reading the other app's rows.
 */
function scopeOf(req: Request) {
  return requireScope(req.params.app);
}

/** GET /api/service-content/:app/list — this app's content rows (Ride: 6, Delivery: 1). */
export async function list(req: Request, res: Response) {
  const items = await service.listContent(scopeOf(req));
  res.json({ items, total: items.length });
}

/** GET /api/service-content/:app/:id — one row with every section blob (edit page). */
export async function getOne(req: Request, res: Response) {
  const scope = scopeOf(req);
  res.json({ item: await service.getContent(scope, Number(req.params.id)) });
}

/** PUT /api/service-content/:app/:id — merge changed section fields and/or SEO meta. */
export async function update(req: Request, res: Response) {
  const scope = scopeOf(req);
  const item = await service.updateContent(
    scope,
    Number(req.params.id),
    req.body as {
      meta?: { title?: unknown; keyword?: unknown; description?: unknown };
      sections?: Record<string, Record<string, unknown>>;
    },
  );
  await writeAudit(req, SERVICE_CONTENT_EVENTS[scope.app].updated);
  res.json({ item });
}

/** PATCH /api/service-content/:app/:id/status — activate / deactivate a page. */
export async function setStatus(req: Request, res: Response) {
  const scope = scopeOf(req);
  const { status } = req.body as { status: ContentStatus };
  const item = await service.changeStatus(scope, Number(req.params.id), status);
  await writeAudit(req, SERVICE_CONTENT_EVENTS[scope.app].statusChanged);
  res.json({ item });
}
