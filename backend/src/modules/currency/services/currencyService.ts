import { AppError } from "../../../errors/AppError";
import * as model from "../models/currencyModel";
import type { CurrencyInput, CurrencyRow, CurrencyStatus } from "../models/currencyModel";

/**
 * Business rules for the currency catalog. Keeps controllers thin: existence
 * checks, numeric sanity, and the "exactly one default" invariant live here.
 * The catalog is fixed (seeded from `master_currency`), so there is no create
 * or delete — only edit, status toggle, and default selection.
 */

/** Round to the 4-decimal precision the legacy `double(10,4)` columns store. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function requireFinite(name: string, n: number): number {
  if (!Number.isFinite(n) || n < 0) {
    throw AppError.badRequest(`"${name}" must be a non-negative number.`);
  }
  return n;
}

/** Normalise + validate an edit payload before it reaches the model. */
function normalizeInput(input: CurrencyInput): CurrencyInput {
  const symbol = input.symbol.trim();
  if (!symbol) {
    throw AppError.badRequest("Currency symbol is required.");
  }
  if (symbol.length > 20) {
    throw AppError.badRequest("Currency symbol must be 20 characters or fewer.");
  }

  const displayOrder = Math.trunc(input.displayOrder);
  if (displayOrder < 0 || displayOrder > 9999) {
    throw AppError.badRequest("Display order must be between 0 and 9999.");
  }

  return {
    symbol,
    ratio: round4(requireFinite("Ratio", input.ratio)),
    displayOrder,
    threshold: round4(requireFinite("Threshold amount", input.threshold)),
    reverseFormatting: input.reverseFormatting,
    reverseSymbol: input.reverseSymbol,
    roundingOff: input.roundingOff,
    firstRange: round4(requireFinite("First range value", input.firstRange)),
    middleRange: round4(requireFinite("Middle range value", input.middleRange)),
    secondRange: round4(requireFinite("Second range value", input.secondRange)),
  };
}

/** Load a currency or throw 404. */
async function mustFind(id: number): Promise<CurrencyRow> {
  const row = await model.findCurrency(id);
  if (!row) {
    throw AppError.notFound("Currency not found.");
  }
  return row;
}

/** Validate and persist an edit, returning the fresh row. */
export async function updateCurrency(id: number, input: CurrencyInput): Promise<CurrencyRow> {
  await mustFind(id);
  const clean = normalizeInput(input);
  await model.updateCurrency(id, clean);
  return (await mustFind(id));
}

/** Toggle Active / Inactive, returning the fresh row. */
export async function changeStatus(id: number, status: CurrencyStatus): Promise<CurrencyRow> {
  const row = await mustFind(id);
  if (row.status !== status) {
    await model.setStatus(id, status);
  }
  return (await mustFind(id));
}

/**
 * Designate a currency as the default. Refuses Inactive currencies (picking a
 * disabled one as the store default would break price display everywhere).
 */
export async function setDefault(id: number): Promise<CurrencyRow> {
  const row = await mustFind(id);
  if (row.status !== "Active") {
    throw AppError.badRequest("Only an active currency can be set as default.");
  }
  if (!row.isDefault) {
    await model.makeDefault(id);
  }
  return (await mustFind(id));
}
