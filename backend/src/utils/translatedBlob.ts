import { AppError } from "../errors/AppError";

/**
 * Read / write helpers for the legacy "translated blob" columns.
 *
 * Several Ride tables store one piece of copy in a single `text` / `longtext`
 * column as a flat JSON object whose keys name both the column and the language:
 *
 *   vReasonTitle → {"vReasonTitle_EN":"Airport/Station Ride","vReasonTitle_AR":"…"}
 *
 * Three rules make a save safe on that shape:
 *
 * - only the keys the editor actually changed are overwritten, so the languages
 *   the screen does not show survive untouched (most legacy rows hold 26 of them);
 * - a column that is not JSON at all — plain text, or empty, which plenty of
 *   legacy rows are — is read as the primary language rather than discarded, and
 *   stays readable after the first save;
 * - unknown keys inside the object are preserved verbatim, because other legacy
 *   screens may write them.
 */

/** Language a plain-text blob is assumed to be written in when it has no keys. */
const PRIMARY_FALLBACK = "EN";

/** `<column>_<CODE>` language keys, e.g. `vTitle_EN`. */
export function translationKey(column: string, code: string): string {
  return `${column}_${code}`;
}

/**
 * Parse one blob into a prototype-less `<key, text>` map. Returns `null` when the
 * column holds something that is not a translation object (empty, plain text, a
 * JSON array or scalar) so the caller can decide what the fallback text is.
 */
export function parseTranslationBlob(raw: unknown): Record<string, string> | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const out = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    // A stored non-string is kept as its JSON form rather than dropped, so a
    // re-save cannot silently change what the apps read.
    out[key] = typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
  }
  return out;
}

/**
 * The English (primary-language) text of a blob, whatever shape it is in: the
 * `<column>_<primary>` key when the column parsed, otherwise the raw text itself.
 * Listing columns use this so a legacy plain-text row still shows a name.
 */
export function primaryText(raw: unknown, column: string, primary: string): string {
  const parsed = parseTranslationBlob(raw);
  const value = parsed ? parsed[translationKey(column, primary)] : undefined;
  if (value !== undefined && value !== "") return value;
  if (parsed) {
    // No primary language stored: the first non-empty translation still names the row.
    const first = Object.values(parsed).find((v) => v.trim() !== "");
    if (first) return first;
  }
  return typeof raw === "string" ? raw.trim() : "";
}

/** One language's change inside a `<key, text>` group of an update payload. */
export interface TranslationChange {
  code: string;
  text: string;
}

/**
 * Merge `changed` into the stored blob of one column and return the JSON to write.
 * `changed` texts are taken as sent (the caller sanitises them); keys for languages
 * that were not touched keep their stored value.
 */
export function mergeTranslationBlob(
  raw: unknown,
  column: string,
  languages: readonly string[],
  changed: readonly TranslationChange[],
): string {
  const allowed = new Set(languages);
  const stored = parseTranslationBlob(raw);

  const out = Object.create(null) as Record<string, string>;
  if (stored) {
    for (const [key, value] of Object.entries(stored)) out[key] = value;
  } else {
    // Un-parsable column: keep whatever was there as the primary-language text so
    // the first save from this screen does not erase an unreadable legacy value.
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() !== "") out[translationKey(column, PRIMARY_FALLBACK)] = text;
  }

  for (const { code, text } of changed) {
    if (!allowed.has(code)) throw AppError.badRequest(`Unknown language: “${code}”.`);
    out[translationKey(column, code)] = text;
  }
  return JSON.stringify(out);
}
