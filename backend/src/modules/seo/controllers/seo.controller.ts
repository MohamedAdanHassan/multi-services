import type { Request, Response } from "express";
import * as model from "../models/seoModel";
import type { SeoSectionInput, SeoSectionRow } from "../models/seoModel";
import * as service from "../services/seoService";
import * as audit from "../../audit/services/auditService";

/** Audit event for an SEO section save. */
export const SeoEvents = {
  Updated: "seo_section_updated",
} as const;

/** Public API shape for an SEO section row. */
function toDto(r: SeoSectionRow) {
  return {
    id: r.id,
    pageName: r.pageName,
    pageTitle: r.pageTitle,
    metaKeywords: r.metaKeywords,
    description: r.description,
  };
}

/** GET /api/seo/list — every SEO section. */
export async function list(_req: Request, res: Response) {
  const rows = await model.listSeoSections();
  res.json({ sections: rows.map(toDto), total: rows.length });
}

/** PUT /api/seo/:id — validate and persist one section's metadata. */
export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const input = req.body as SeoSectionInput;
  const row = await service.updateSection(id, input);
  if (req.auth) {
    audit.logQuiet(req, SeoEvents.Updated, { adminId: req.auth.adminId, email: req.auth.email });
  }
  res.json({ section: toDto(row) });
}
