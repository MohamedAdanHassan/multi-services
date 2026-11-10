import { AppError } from "../../../errors/AppError";
import * as model from "../models/seoModel";
import type { SeoSectionInput, SeoSectionRow } from "../models/seoModel";

/**
 * Business rules for the SEO sections catalog. Fixed set of installed pages
 * (no create/delete), so the only operation is editing one section's content.
 */

/** Trim + enforce a max length, with an optional required check. */
function cleanField(name: string, value: string, maxLen: number, required: boolean): string {
  const v = value.trim();
  if (required && !v) {
    throw AppError.badRequest(`"${name}" is required.`);
  }
  if (v.length > maxLen) {
    throw AppError.badRequest(`"${name}" must be ${maxLen} characters or fewer.`);
  }
  return v;
}

/** Normalise + validate an edit payload before it reaches the model. */
function normalizeInput(input: SeoSectionInput): SeoSectionInput {
  return {
    pageName: cleanField("Page name", input.pageName, 500, true),
    pageTitle: cleanField("Page title", input.pageTitle, 500, true),
    metaKeywords: cleanField("Meta keywords", input.metaKeywords, 500, false),
    // tDescription is a TEXT column; keep a generous but bounded size.
    description: cleanField("Description", input.description, 65_000, false),
  };
}

/** Load a section or throw 404. */
async function mustFind(id: number): Promise<SeoSectionRow> {
  const row = await model.findSeoSection(id);
  if (!row) {
    throw AppError.notFound("SEO section not found.");
  }
  return row;
}

/** Validate and persist an edit, returning the fresh row. */
export async function updateSection(id: number, input: SeoSectionInput): Promise<SeoSectionRow> {
  await mustFind(id);
  const clean = normalizeInput(input);
  await model.updateSeoSection(id, clean);
  return await mustFind(id);
}
