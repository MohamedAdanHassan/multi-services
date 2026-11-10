import { AppError } from "../../../errors/AppError";
import * as model from "../models/languageModel";
import type { LanguageInput, LanguageRow, LanguageStatus } from "../models/languageModel";

/**
 * Business rules for the language catalog. Keeps controllers thin: existence
 * checks, field limits, and the "exactly one default" invariant live here.
 * Like currencies, the catalog is fixed (installed languages referenced by the
 * `language_label` tables via `vCode`), so there is no create or delete —
 * only edit, status toggle, and default selection.
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
function normalizeInput(input: LanguageInput): LanguageInput {
  const displayOrder = Math.trunc(input.displayOrder);
  if (!Number.isFinite(displayOrder) || displayOrder < 0 || displayOrder > 9999) {
    throw AppError.badRequest("Display order must be between 0 and 9999.");
  }

  return {
    title: cleanField("Language name", input.title, 50, true),
    titleEn: cleanField("English name", input.titleEn, 50, true),
    gmapLangCode: cleanField("Google Maps code", input.gmapLangCode, 5, true),
    langCode: cleanField("Language code", input.langCode, 5, true),
    currencyCode: cleanField("Currency code", input.currencyCode, 100, false),
    currencySymbol: cleanField("Currency symbol", input.currencySymbol, 50, false),
    displayOrder,
    direction: input.direction,
  };
}

/** Load a language or throw 404. */
async function mustFind(id: number): Promise<LanguageRow> {
  const row = await model.findLanguage(id);
  if (!row) {
    throw AppError.notFound("Language not found.");
  }
  return row;
}

/** Validate and persist an edit, returning the fresh row. */
export async function updateLanguage(id: number, input: LanguageInput): Promise<LanguageRow> {
  await mustFind(id);
  const clean = normalizeInput(input);
  await model.updateLanguage(id, clean);
  return await mustFind(id);
}

/** Toggle Active / Inactive, returning the fresh row. */
export async function changeStatus(id: number, status: LanguageStatus): Promise<LanguageRow> {
  const row = await mustFind(id);
  if (row.status !== status) {
    await model.setStatus(id, status);
  }
  return await mustFind(id);
}

/**
 * Designate a language as the default. Refuses Inactive languages (a disabled
 * default would leave the apps with no usable fallback language).
 */
export async function setDefault(id: number): Promise<LanguageRow> {
  const row = await mustFind(id);
  if (row.status !== "Active") {
    throw AppError.badRequest("Only an active language can be set as default.");
  }
  if (!row.isDefault) {
    await model.makeDefault(id);
  }
  return await mustFind(id);
}
