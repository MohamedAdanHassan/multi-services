import type { Request, Response } from "express";
import * as service from "../services/packageTypeService";
import type { PackageTypeCreate, PackageTypeUpdate } from "../services/packageTypeService";
import type { PackageStatus } from "../models/packageTypeModel";
import * as audit from "../../audit/services/auditService";

/** Audit events for package types. */
export const PackageTypeEvents = {
  Created: "package_type_created",
  Updated: "package_type_updated",
  StatusChanged: "package_type_status_changed",
  Deleted: "package_type_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * GET /api/package-type/list — live package types. With no `page`/`limit`/`search`/
 * `status` query the full list is returned; once any is present it switches to a
 * filtered SQL page and adds `page`/`limit`/`pages` for the pager.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const paginated =
    q.page !== undefined || q.limit !== undefined || q.search !== undefined || q.status !== undefined;
  if (paginated) {
    const p = await service.listPackageTypesPaged(q);
    res.json({ items: p.rows, total: p.total, page: p.page, limit: p.limit, pages: p.pages });
    return;
  }
  const items = await service.listPackageTypes();
  res.json({ items, total: items.length });
}

/**
 * GET /api/package-type/defaults — the language columns and delivery-field choices
 * a new package type would start from, so the form asks the server what may be filled in.
 */
export async function defaults(_req: Request, res: Response) {
  const [item, fields] = await Promise.all([
    service.blankRecord(),
    service.listFieldOptions(),
  ]);
  res.json({ item, fields });
}

/** GET /api/package-type/fields — delivery fields a package type can belong to. */
export async function fields(_req: Request, res: Response) {
  res.json({ fields: await service.listFieldOptions() });
}

/** GET /api/package-type/:id — one package type with every stored language. */
export async function getOne(req: Request, res: Response) {
  res.json({ item: await service.getPackageType(Number(req.params.id)) });
}

/** POST /api/package-type — add a package type. */
export async function create(req: Request, res: Response) {
  const item = await service.createPackageType(req.body as PackageTypeCreate);
  await writeAudit(req, PackageTypeEvents.Created);
  res.status(201).json({ item });
}

/** PUT /api/package-type/:id — write the changed languages, optionally re-link the field. */
export async function update(req: Request, res: Response) {
  const item = await service.updatePackageType(Number(req.params.id), req.body as PackageTypeUpdate);
  await writeAudit(req, PackageTypeEvents.Updated);
  res.json({ item });
}

/** PATCH /api/package-type/:id/status — activate / deactivate a package type. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: PackageStatus };
  const item = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, PackageTypeEvents.StatusChanged);
  res.json({ item });
}

/** DELETE /api/package-type/:id — name-confirmed, usage-guarded soft delete. */
export async function remove(req: Request, res: Response) {
  const { confirm } = req.body as { confirm?: unknown };
  const result = await service.deletePackageType(Number(req.params.id), confirm);
  await writeAudit(req, PackageTypeEvents.Deleted);
  res.json({ ok: true, ...result });
}

