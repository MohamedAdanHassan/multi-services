import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";
import * as model from "../models/settingsModel";
import type { SettingRow, SettingWrite } from "../models/settingsModel";

/**
 * Business logic for the general settings editor. The rules encoded here mirror
 * the legacy `configurations` metadata flags (input type, zero/space/double
 * allowances, max value, required, select options) so values are validated the
 * same way the original PHP admin validated them — without any per-key switch.
 */

/** Parse a `tSelectVal` blob ("Yes,No" / "All,Distance,Time") into options. */
export function parseSelectOptions(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Validate + normalise one value against its setting definition. */
export function validateValue(def: SettingRow, rawValue: string): string {
  const name = def.label || def.key;
  // Trim surrounding whitespace for every field except free-form textareas,
  // where newlines/indent are meaningful.
  const text = def.inputType === "Textarea" ? rawValue : rawValue.trim();

  if (def.required && text === "") {
    throw AppError.badRequest(`"${name}" is required.`);
  }
  if (text === "") return ""; // blank is allowed for non-required fields

  if (!def.spaceAllowed && /\s/.test(text)) {
    throw AppError.badRequest(`"${name}" must not contain spaces.`);
  }

  if (def.inputType === "Number" || def.inputType === "NumericRange") {
    const num = Number(text);
    if (!Number.isFinite(num)) {
      throw AppError.badRequest(`"${name}" must be a number.`);
    }
    if (!def.doubleAllowed && !Number.isInteger(num)) {
      throw AppError.badRequest(`"${name}" must be a whole number.`);
    }
    if (!def.zeroAllowed && num === 0) {
      throw AppError.badRequest(`"${name}" cannot be zero.`);
    }
    if (def.maxValue > 0 && num > def.maxValue) {
      throw AppError.badRequest(`"${name}" cannot be greater than ${def.maxValue}.`);
    }
  }

  if (def.inputType === "Time" && !/^\d{1,2}:\d{2}$/.test(text)) {
    throw AppError.badRequest(`"${name}" must be a time in HH:MM form.`);
  }

  // Select: enforce membership only when the legacy row actually lists options
  // (some Select rows ship with an empty option set and behave as free text).
  if (def.inputType === "Select") {
    const options = parseSelectOptions(def.selectOptions);
    if (options.length && !options.includes(text)) {
      throw AppError.badRequest(`"${name}" must be one of: ${options.join(", ")}.`);
    }
  }

  return text;
}

/**
 * Editable-settings rows are read on every General Settings visit AND for
 * every save's validation pass; 60s of reuse is invisible to the UI (saves
 * clear the cache immediately) yet absorbs the dashboard's repeated loads.
 */
const editableCache = createTtlCache<SettingRow[]>(60_000, 8);

/** Cached variant of `model.listEditableSettings()` (shared by all readers). */
export function listEditableSettingsCached(): Promise<SettingRow[]> {
  return editableCache.load("editable", () => model.listEditableSettings());
}

/** Admin-displayable settings, keyed by id (single source for validation). */
async function editableByIds(): Promise<Map<number, SettingRow>> {
  const rows = await listEditableSettingsCached();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Apply a batch of value writes. Later writes to the same id win; unknown ids
 * and invalid values are collected and rejected up-front so nothing partial is
 * persisted. Only genuinely changed values are written. Returns the count saved.
 */
export async function saveSettings(writes: SettingWrite[]): Promise<number> {
  const defs = await editableByIds();

  // De-duplicate by id (last write wins) before validating.
  const byId = new Map<number, string>();
  for (const w of writes) byId.set(w.id, w.value);

  const errors: string[] = [];
  const changes: SettingWrite[] = [];
  for (const [id, raw] of byId) {
    const def = defs.get(id);
    if (!def) {
      errors.push(`Unknown or non-editable setting #${id}.`);
      continue;
    }
    try {
      const clean = validateValue(def, raw);
      if (clean !== def.value) changes.push({ id, value: clean });
    } catch (err) {
      errors.push(err instanceof AppError ? err.message : `"${def.label}" is invalid.`);
    }
  }

  if (errors.length) throw AppError.badRequest("Some settings could not be saved.", errors);
  if (!changes.length) return 0;

  // One round trip for the whole save (was: one UPDATE per changed row).
  await model.bulkUpdateSettingValues(changes);
  editableCache.clear(); // the next read must see the new values
  return changes.length;
}
