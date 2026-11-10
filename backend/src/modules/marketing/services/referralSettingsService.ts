import { AppError } from "../../../errors/AppError";
import { validateValue } from "../../settings/services/settingsService";
import type { SettingRow, SettingWrite } from "../../settings/models/settingsModel";
import * as model from "../models/referralSettingsModel";
import type { ReferralLevelRow, ReferralLevelWrite } from "../models/referralSettingsModel";

/**
 * Business rules for MLM Referral Settings (Marketing Tools → #sub-146).
 *
 * The page edits two things at once, and they are coupled: the scheme switches
 * in `configurations` decide how a level row is *read*, while
 * `multi_level_referral_master` decides *what* gets paid at each depth. So the
 * `REFERRAL_LEVEL` setting ("Maximum number of levels that can be defined") is
 * the ceiling the level form validates against, and this service is where that
 * coupling is enforced rather than in the client.
 *
 * Rules, all traceable to the live schema or to the shipped dataset:
 *  - a depth is a whole number ≥ 1 and ≤ the current `REFERRAL_LEVEL`;
 *  - no two live rows may claim the same depth (a retired row frees its
 *    number — nothing in the schema keys on `iReferralId`);
 *  - the amount is bounded by the column, `decimal(15,10)` leaves five integer
 *    digits, so 99999.9999999999 is the largest storable value. We do NOT apply
 *    a "≤ 100 because it is a percentage" rule: the strategy switch can be
 *    flipped to Fixed at any time, and a stored 150 would then become
 *    un-editable. The UI names the unit instead; the server enforces storage.
 *  - the amount may be 0. A depth that pays nothing is a legitimate way to
 *    reserve a level in the chain without funding it.
 *
 * There is no delete and no status toggle: `delete-referral-settings` (#702) is
 * Inactive in the RBAC table, so this module never writes `eStatus = 'Deleted'`
 * and never exposes a route for it. Rows retired by the legacy panel stay
 * hidden from the listing.
 */

/** `decimal(15,10)`: ten decimals leave five integer digits. */
const MAX_AMOUNT = 99999.9999999999;
/** vTitle is longtext; the panel caps the label to keep the table readable. */
const MAX_TITLE_LEN = 255;
/**
 * The `REFERRAL_LEVEL` value this dataset ships with. Used as the ceiling only
 * if the settings row is missing or holds a nonsense value — better than
 * allowing unbounded depths the apps would never walk.
 */
const FALLBACK_MAX_LEVEL = 15;

/** API shape for one referral level. */
export interface ReferralLevelDto {
  id: number;
  /** Depth in the chain (1 = the referrer themselves' direct referee). */
  level: number;
  title: string;
  amount: number;
}

function toDto(row: ReferralLevelRow): ReferralLevelDto {
  return { id: row.id, level: row.level, title: row.title, amount: row.amount };
}

/**
 * Amount round-off. The column keeps ten decimals, so the panel must not invent
 * a two-decimal money rounding: rounding a 0.00005 commission away would change
 * what the apps pay out. We keep the value as entered.
 */
function cleanAmount(value: unknown): number {
  // A blank field must not quietly become "0%" — zero is a deliberate choice
  // the admin has to actually type.
  if (value === undefined || value === null || String(value).trim() === "") {
    throw AppError.badRequest("Commission is required. Enter 0 to reserve a level without paying it.");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw AppError.badRequest("Commission must be a number.");
  }
  if (n < 0) {
    throw AppError.badRequest("Commission cannot be negative.");
  }
  if (n > MAX_AMOUNT) {
    throw AppError.badRequest(`Commission must be at most ${MAX_AMOUNT}.`);
  }
  return n;
}

function cleanTitle(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw AppError.badRequest("Level title is required.");
  if (text.length > MAX_TITLE_LEN) {
    throw AppError.badRequest(`Level title must be at most ${MAX_TITLE_LEN} characters.`);
  }
  return text;
}

/** The highest depth the scheme currently allows. */
async function maxLevel(): Promise<number> {
  const row = (await model.listReferralSettings()).find((s) => s.key === "REFERRAL_LEVEL");
  const n = Number(row?.value ?? "");
  return Number.isInteger(n) && n > 0 ? n : FALLBACK_MAX_LEVEL;
}

function cleanDepth(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw AppError.badRequest("Level is required.");
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.badRequest("Level must be a whole number starting at 1.");
  }
  return n;
}

async function mustFind(id: number): Promise<ReferralLevelRow> {
  const row = await model.findLevel(id);
  if (!row) throw AppError.notFound(`Referral level #${id} not found.`);
  return row;
}

/** Reject a depth another live row already claims. */
async function assertDepthFree(level: number, max: number, selfId?: number): Promise<void> {
  if (level > max) {
    throw AppError.badRequest(
      `Level ${level} exceeds the maximum of ${max} allowed by the "Referral Level" setting.`,
    );
  }
  const taken = await model.findLevelByDepth(level);
  if (taken && taken.id !== selfId) {
    throw AppError.badRequest(`Level ${level} is already defined as "${taken.title}".`);
  }
}

/** Validate a create/edit payload against the schema and the current ceiling. */
async function resolveWrite(
  input: { level?: unknown; title?: unknown; amount?: unknown },
  selfId?: number,
): Promise<ReferralLevelWrite> {
  const depth = cleanDepth(input.level);
  // Title before amount: a blank label is the likelier slip and the more
  // specific problem of the two.
  const title = cleanTitle(input.title);
  const amount = cleanAmount(input.amount);
  const max = await maxLevel();
  await assertDepthFree(depth, max, selfId);
  return { level: depth, title, amount };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Everything the page needs in one round trip. */
export async function getPage(): Promise<{
  settings: SettingRow[];
  levels: ReferralLevelDto[];
  maxLevel: number;
}> {
  const [settings, rows, max] = await Promise.all([
    model.listReferralSettings(),
    model.listLevels(),
    maxLevel(),
  ]);
  return { settings, levels: rows.map(toDto), maxLevel: max };
}

export async function getLevel(id: number): Promise<ReferralLevelDto> {
  return toDto(await mustFind(id));
}

// ---------------------------------------------------------------------------
// Writes — levels
// ---------------------------------------------------------------------------

export async function createLevel(input: {
  level?: unknown;
  title?: unknown;
  amount?: unknown;
}): Promise<ReferralLevelDto> {
  const write = await resolveWrite(input);
  const id = await model.nextLevelId();
  await model.createLevel(id, write);
  return toDto(await mustFind(id));
}

export async function updateLevel(
  id: number,
  input: { level?: unknown; title?: unknown; amount?: unknown },
): Promise<ReferralLevelDto> {
  // Existence check first: a write to a retired or foreign id must 404 rather
  // than silently match zero rows.
  await mustFind(id);
  const write = await resolveWrite(input, id);
  await model.updateLevel(id, write);
  return toDto(await mustFind(id));
}

// ---------------------------------------------------------------------------
// Writes — scheme settings (#sub-146 shares the `configurations` metadata
// validation with General Settings and Maps API Settings)
// ---------------------------------------------------------------------------

/** Settings this page may write, keyed by id. Read-only context is excluded. */
async function editableByIds(): Promise<Map<number, SettingRow>> {
  const rows = await model.listReferralSettings();
  const editable = new Set<string>(model.EDITABLE_REFERRAL_KEYS);
  return new Map(rows.filter((r) => editable.has(r.key)).map((r) => [r.id, r]));
}

/**
 * Apply a batch of scheme-setting writes. Unknown ids (including the read-only
 * single-level rows shown for context) and invalid values are collected and
 * rejected up-front, so nothing partial is persisted. Only genuinely changed
 * values are written. Returns the count saved.
 */
export async function saveReferralSettings(writes: SettingWrite[]): Promise<number> {
  const defs = await editableByIds();

  const byId = new Map<number, string>();
  for (const w of writes) byId.set(w.id, w.value);

  const errors: string[] = [];
  const changes: SettingWrite[] = [];
  for (const [id, raw] of byId) {
    const def = defs.get(id);
    if (!def) {
      errors.push(`Unknown or read-only referral setting #${id}.`);
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
  await model.bulkUpdateReferralSettingValues(changes);
  return changes.length;
}
