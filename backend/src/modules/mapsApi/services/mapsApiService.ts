import { AppError } from "../../../errors/AppError";
import { validateValue } from "../../settings/services/settingsService";
import type { SettingRow, SettingWrite } from "../../settings/models/settingsModel";
import * as model from "../models/mapsApiModel";

/**
 * Business rules for the Maps API Settings editor. Value validation is shared
 * with General Settings (`validateValue` interprets each row's legacy metadata:
 * input type, select membership, numeric/zero/space constraints), so a Maps
 * field is validated exactly as the original PHP admin would have. The only
 * Maps-specific rule is that writes are confined to the curated allowlist —
 * ids outside it are rejected so this endpoint can never touch other settings.
 */

/** Active Maps settings keyed by id (the only ids this editor may write). */
async function mapsByIds(): Promise<Map<number, SettingRow>> {
  const rows = await model.listMapsSettings();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Apply a batch of value changes to the Maps settings. Later writes to the same
 * id win; unknown/non-Maps ids and invalid values are collected and rejected
 * up-front so nothing partial is persisted. Only genuinely changed values are
 * written. Returns the number saved.
 */
export async function saveMapsSettings(writes: SettingWrite[]): Promise<number> {
  const defs = await mapsByIds();

  // De-duplicate by id (last write wins) before validating.
  const byId = new Map<number, string>();
  for (const w of writes) byId.set(w.id, w.value);

  const errors: string[] = [];
  const changes: SettingWrite[] = [];
  for (const [id, raw] of byId) {
    const def = defs.get(id);
    if (!def) {
      errors.push(`Unknown or non-Maps setting #${id}.`);
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
  await model.bulkUpdateMapSettingValues(changes);
  return changes.length;
}
