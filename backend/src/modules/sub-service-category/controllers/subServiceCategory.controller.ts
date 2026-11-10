import type { Request, Response } from "express";
import type { SubCategoryStatus } from "../models/subServiceCategoryModel";
import { requireScope } from "../models/subServiceCategoryModel";
import * as service from "../services/subServiceCategoryService";
import * as audit from "../../audit/services/auditService";

/**
 * Audit events for the Parcel Delivery sub-category screen. Distinct from the master
 * row's `master_service_category_*` names and the taxi `service_category_*` names, so an
 * admin log can tell the three screens apart. All fit the 50-character event column.
 */
export const SubServiceCategoryEvents = {
  StatusChanged: "sub_service_category_status_changed",
  Updated: "sub_service_category_updated",
  Deleted: "sub_service_category_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** The app the request is addressed as; the route's zod enum normally guarantees it. */
function scopeOf(req: Request) {
  return requireScope(req.params.app);
}

/**
 * Which parent the request is acting on. It is always a QUERY value (`?parent=`), so the
 * same locator works for the read, the single-action routes and the bulk POSTs alike; the
 * service validates it is inside this app's subtree (defaulting to the app root when the
 * param is absent).
 */
function parentOf(req: Request): unknown {
  return typeof req.query.parent === "string" ? req.query.parent : undefined;
}

/** Parse the optional list filters from the query string. */
function filterOf(req: Request): { keyword?: string; status?: SubCategoryStatus | "Deleted" } {
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword : undefined;
  const status =
    typeof req.query.status === "string" ? (req.query.status as SubCategoryStatus | "Deleted") : undefined;
  return { keyword, status };
}

/** GET /api/sub-service-category/:app/list — the parent's live children. */
export async function list(req: Request, res: Response) {
  const items = await service.listSubCategories(scopeOf(req), parentOf(req), filterOf(req));
  res.json({ items, total: items.length });
}

/** GET /api/sub-service-category/:app/:id — one child's edit detail (names + order). */
export async function getOne(req: Request, res: Response) {
  const item = await service.getSubCategory(scopeOf(req), parentOf(req), Number(req.params.id));
  res.json({ item });
}

/** PATCH /api/sub-service-category/:app/:id/status — activate / deactivate one child. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: SubCategoryStatus };
  const item = await service.changeStatus(scopeOf(req), parentOf(req), Number(req.params.id), status);
  await writeAudit(req, SubServiceCategoryEvents.StatusChanged);
  res.json({ item });
}

/** PATCH /api/sub-service-category/:app/:id — rename a child / set its display order. */
export async function update(req: Request, res: Response) {
  const body = req.body as { names?: Record<string, string>; displayOrder?: number };
  const item = await service.updateSubCategory(scopeOf(req), parentOf(req), Number(req.params.id), {
    names: body.names,
    displayOrder: body.displayOrder,
  });
  await writeAudit(req, SubServiceCategoryEvents.Updated);
  res.json({ item });
}

/** POST /api/sub-service-category/:app/bulk-status — activate / deactivate many children. */
export async function bulkStatus(req: Request, res: Response) {
  const { ids, status } = req.body as { ids: number[]; status: SubCategoryStatus };
  const result = await service.changeStatusMany(scopeOf(req), parentOf(req), ids, status);
  await writeAudit(req, SubServiceCategoryEvents.StatusChanged);
  res.json({ ok: true, ...result });
}

/** DELETE /api/sub-service-category/:app/:id — soft-delete one child. */
export async function removeOne(req: Request, res: Response) {
  const result = await service.deleteSubCategories(scopeOf(req), parentOf(req), [Number(req.params.id)]);
  await writeAudit(req, SubServiceCategoryEvents.Deleted);
  res.json({ ok: true, ...result });
}

/** POST /api/sub-service-category/:app/bulk-delete — soft-delete many children. */
export async function bulkDelete(req: Request, res: Response) {
  const { ids } = req.body as { ids: number[] };
  const result = await service.deleteSubCategories(scopeOf(req), parentOf(req), ids);
  await writeAudit(req, SubServiceCategoryEvents.Deleted);
  res.json({ ok: true, ...result });
}

