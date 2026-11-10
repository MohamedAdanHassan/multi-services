import { AppError } from "../../../errors/AppError";
import { findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/genieServiceContentModel";
import {
  BLOB_BY_KEY,
  CATEGORY_LANGUAGES,
  IMAGE_SLOTS,
  SETTINGS,
  SETTINGS_BY_COLUMN,
  NAME_COLUMN,
} from "../models/genieServiceContentModel";
import type {
  ServiceContentRow,
  ServiceContentScope,
  ServiceContentStatus,
  SettingSpec,
} from "../models/genieServiceContentModel";

/**
 * Business rules for Delivery Genie → Manage Service/Content (group 33 → #sub-141):
 * the app's root `vehicle_category` row, edited in the two tabs the legacy page shows.
 *
 * Three kinds of copy are written three different ways, and the difference is the whole
 * point of this service:
 *
 * - the category name lives in ONE COLUMN PER LANGUAGE (`vCategory_EN`, `vCategory_AR`,
 *   …), so a changed language is a changed column and nothing else has to be touched;
 * - the promotional-banner title and the home-page title/sub-title live in JSON columns
 *   keyed `<base>_<LANG>`. The legacy panel rebuilt those objects from the posted form on
 *   every save, so a language whose input was not in the request came back empty. This
 *   service merges instead: the editor sends only the keys it changed and every other key
 *   of the stored object is written back as it was;
 * - the settings columns are enums and integers whose legal values come from the legacy
 *   DDL, so each one is checked rather than trusted.
 *
 * Everything is validated before anything is written and the write itself is a single
 * UPDATE: the table is MyISAM, with no transactions to fall back on.
 *
 * The one deliberate extra statement is the promote-banner exclusivity. The legacy screen
 * promised "Enabling this will remove this feature from all other services if enabled" and
 * then did exactly that (`vehicle_category_action.php:905`), because the apps render a
 * single promoted service. A save that turns this row on clears the flag everywhere else
 * and reports how many rows it un-promoted; a save that does not mention the toggle leaves
 * every other row alone.
 */

/** `<base>_<LANG>` — the blob key suffix must be a language code we know. */
const LANG_CODE = /^[A-Z]{1,10}$/;
/** Names that would write onto an inherited property of a parsed blob. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty"]);
/** A JSON column is text; a megabyte of banner copy is a mistake, not content. */
const MAX_BLOB_BYTES = 512_000;

/**
 * Length caps the DDL does not carry. `vCategory_*` columns are `longtext` and the blob
 * columns are `mediumtext`, so the database would accept almost anything: these are the
 * limits the apps can actually render in a title line, and each is far above the longest
 * stored value (~300 characters for the home-page sub-title).
 */
const MAX_NAME_LEN = 200;
const MAX_TITLE_LEN = 255;
const MAX_SUBTITLE_LEN = 1_000;

/** Cap of one blob base: the home page sub-title is a paragraph, the rest are one-liners. */
function maxOfBase(base: string): number {
  return base.toLowerCase().includes("subtitle") ? MAX_SUBTITLE_LEN : MAX_TITLE_LEN;
}

/** The default language: the first of the shipped set, which the legacy list column reads. */
const DEFAULT_CODE = CATEGORY_LANGUAGES[0]?.code ?? "EN";

/** `tPromoteBannerTitle_EN` → `{ base: "tPromoteBannerTitle", code: "EN" }`. */
function splitKey(key: string): { base: string; code: string } {
  const at = key.lastIndexOf("_");
  if (at <= 0) return { base: key, code: "" };
  return { base: key.slice(0, at), code: key.slice(at + 1) };
}

/**
 * Parse a stored JSON column without a prototype, so a key read back from it can never
 * resolve to an inherited property. An empty column is an empty object; a non-empty value
 * that is not a JSON object is reported as null, and the caller then refuses to overwrite
 * bytes it cannot read instead of dropping the legacy translations.
 */
function parseBlob(raw: string | number | null): Record<string, string> | null {
  const text = String(raw ?? "").trim();
  if (!text) return Object.create(null) as Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value == null) out[key] = "";
      else if (typeof value === "string") out[key] = value;
      // A structured value in a copy column is legacy debris; keep the bytes.
      else out[key] = JSON.stringify(value);
    }
    return out;
  } catch {
    return null;
  }
}

export interface ServiceContentLanguageDto {
  code: string;
  label: string;
  /** The language the list column and the app's fallback read. */
  isDefault: boolean;
}

export interface ServiceContentBlobDto {
  key: string;
  label: string;
  /** Editable bases of this column, i.e. the `<base>` prefixes the legacy form writes. */
  fields: { base: string; label: string; max: number }[];
  /** Raw `<base>_<LANG>` map, including keys no longer editable here. */
  values: Record<string, string>;
  /** True when the column is not JSON — the editor must not overwrite it. */
  unparsed: boolean;
}

export interface ServiceContentImageDto {
  slot: string;
  column: string;
  label: string;
  /** Stored bare file name; empty when the row holds none. */
  value: string;
}

export interface ServiceContentSettingSpecDto {
  column: string;
  label: string;
  kind: SettingSpec["kind"];
  options?: string[];
  min?: number;
  max?: number;
}

export interface ServiceContentSummaryDto {
  id: number;
  app: string;
  label: string;
  catType: string;
  status: ServiceContentStatus;
  displayName: string;
  namesFilled: number;
  languagesTotal: number;
  displayOrder: number;
  displayOrderHomepage: number;
  promoteBanner: string;
  icon: string;
}

export interface ServiceContentDto extends ServiceContentSummaryDto {
  languages: ServiceContentLanguageDto[];
  /** Stored name per language code. */
  names: Record<string, string>;
  images: ServiceContentImageDto[];
  blobs: ServiceContentBlobDto[];
  settingSpecs: ServiceContentSettingSpecDto[];
  /** Column → stored value as text, so the form can diff without type surprises. */
  settings: Record<string, string>;
  /** Rows currently promoted, i.e. the ones turning this row on would un-promote. */
  promotedElsewhere: model.PromotedRow[];
}

async function mustFind(scope: ServiceContentScope, id: number): Promise<ServiceContentRow> {
  const row = await model.findRow(scope, id);
  if (!row) {
    throw AppError.notFound(`No ${scope.label} service content row #${id}.`);
  }
  return row;
}

/** Names of a row keyed by language code, EN first. */
function namesOf(row: ServiceContentRow): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const lang of CATEGORY_LANGUAGES) {
    out[lang.code] = String(row.values[`${NAME_COLUMN}_${lang.code}`] ?? "");
  }
  return out;
}

function displayNameOf(names: Record<string, string>): string {
  const direct = (names[DEFAULT_CODE] ?? "").trim();
  if (direct) return direct;
  for (const code of Object.keys(names)) {
    const value = (names[code] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function toSummaryDto(row: ServiceContentRow, scope: ServiceContentScope) {
  const names = namesOf(row);
  return {
    id: row.id,
    app: scope.app,
    label: scope.label,
    catType: row.catType,
    status: row.status,
    displayName: displayNameOf(names),
    namesFilled: Object.values(names).filter((v) => v.trim()).length,
    languagesTotal: CATEGORY_LANGUAGES.length,
    displayOrder: Number(row.values.iDisplayOrder ?? 0),
    displayOrderHomepage: Number(row.values.iDisplayOrderHomepage ?? 0),
    promoteBanner: String(row.values.ePromoteBanner ?? ""),
    icon: String(row.values.vListLogo3 ?? "").trim(),
  };
}

export async function listContent(
  scope: ServiceContentScope,
): Promise<ServiceContentSummaryDto[]> {
  const rows = await model.listRows(scope);
  return rows.map((row) => ({
    id: row.id,
    app: scope.app,
    label: scope.label,
    catType: row.catType,
    status: row.status,
    displayName: row.displayName,
    namesFilled: row.namesFilled,
    languagesTotal: CATEGORY_LANGUAGES.length,
    displayOrder: row.displayOrder,
    displayOrderHomepage: row.displayOrderHomepage,
    promoteBanner: row.promoteBanner,
    icon: row.icon,
  }));
}

export async function getContent(
  scope: ServiceContentScope,
  id: number,
): Promise<ServiceContentDto> {
  const [row, promotedElsewhere] = await Promise.all([
    mustFind(scope, id),
    model.promotedRowsExcept(id),
  ]);
  const names = namesOf(row);

  const settings = Object.create(null) as Record<string, string>;
  for (const spec of SETTINGS) {
    settings[spec.column] = String(row.values[spec.column] ?? "");
  }

  return {
    ...toSummaryDto(row, scope),
    names,
    languages: CATEGORY_LANGUAGES.map((l) => ({
      code: l.code,
      label: l.label,
      isDefault: l.code === DEFAULT_CODE,
    })),
    images: IMAGE_SLOTS.map((slot) => ({
      slot: slot.slot,
      column: slot.column,
      label: slot.label,
      value: String(row.values[slot.column] ?? "").trim(),
    })),
    blobs: model.BLOB_COLUMNS.map((spec) => {
      const values = parseBlob(row.values[spec.key]);
      return {
        key: spec.key,
        label: spec.label,
        fields: spec.bases.map((base) => ({
          base,
          label: prettifyBase(base),
          max: maxOfBase(base),
        })),
        values: values ?? {},
        unparsed: values === null,
      };
    }),
    settingSpecs: SETTINGS.map((s) => ({
      column: s.column,
      label: s.label,
      kind: s.kind,
      options: s.kind === "enum" ? [...s.values] : undefined,
      min: s.kind === "enum" ? undefined : s.min,
      max: s.kind === "enum" ? undefined : s.max,
    })),
    settings,
    promotedElsewhere,
  };
}

/**
 * Legacy column names to a readable label: `v`/`t`/`l` are the DDL's type prefixes and
 * the rest is camelCase, so `vServiceCatSubTitleHomepage` reads back as
 * “Service Cat Sub Title Homepage”.
 */
function prettifyBase(base: string): string {
  const words = base
    .replace(/^[a-z](?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Validate one per-language name. Names are plain text the apps paste into markup. */
function cleanName(code: string, value: unknown): string {
  const label = CATEGORY_LANGUAGES.find((l) => l.code === code)?.label ?? code;
  if (!CATEGORY_LANGUAGES.some((l) => l.code === code)) {
    throw AppError.badRequest(`Unknown language code: “${code}”.`);
  }
  if (typeof value !== "string") throw AppError.badRequest(`Name for “${label}” must be text.`);
  const text = value.trim();
  const reason = findContentViolation("text", text);
  if (reason) throw AppError.badRequest(`Name for “${label}” ${reason}.`);
  if (text.length > MAX_NAME_LEN) {
    throw AppError.badRequest(`Name for “${label}” must be at most ${MAX_NAME_LEN} characters.`);
  }
  return text;
}

/** Validate one settings column against the legacy DDL. */
function cleanSetting(column: string, value: unknown): string | number {
  const spec = Object.prototype.hasOwnProperty.call(SETTINGS_BY_COLUMN, column)
    ? SETTINGS_BY_COLUMN[column]
    : undefined;
  if (!spec) throw AppError.badRequest(`Unknown setting: “${column}”.`);
  if (spec.kind === "enum") {
    if (typeof value !== "string") throw AppError.badRequest(`${spec.label} must be text.`);
    const text = value.trim();
    if (!spec.values.includes(text)) {
      // The empty value such a row reads back as is not one it can be written: the column is
      // a strict enum, so passing it through would reach MySQL and come back as a 500.
      // Answer with a 400 naming the members the form offers instead.
      if (spec.storedOnly?.includes(text)) {
        throw AppError.badRequest(
          `${spec.label} is unset on this row and cannot be saved as blank — choose ${spec.values.join(" / ")}.`,
        );
      }
      throw AppError.badRequest(`${spec.label} must be one of: ${spec.values.join(" / ")}.`);
    }
    return text;
  }
  const raw = typeof value === "number" ? value : typeof value === "string" ? value.trim() : null;
  if (raw === null || raw === "") throw AppError.badRequest(`${spec.label} must be a number.`);
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw AppError.badRequest(`${spec.label} must be a number.`);
  if (!Number.isInteger(n)) throw AppError.badRequest(`${spec.label} must be a whole number.`);
  if (n < spec.min || n > spec.max) {
    throw AppError.badRequest(`${spec.label} must be between ${spec.min} and ${spec.max}.`);
  }
  return n;
}

export interface ServiceContentUpdate {
  /** Language code → name, only the languages that changed. */
  names?: Record<string, unknown>;
  /** Column → value, only the settings that changed. */
  settings?: Record<string, unknown>;
  /** Blob column → `<base>_<LANG>` → text, only the keys that changed. */
  copy?: Record<string, Record<string, unknown>>;
}

export interface ServiceContentSaveResult {
  item: ServiceContentDto;
  /** Rows the promote-banner exclusivity switched off alongside this save. */
  promotedCleared: number;
}

/**
 * Merge a save across both tabs. Every group carries only what the editor changed;
 * anything absent from the payload keeps its stored value. All of it lands in ONE UPDATE
 * so a rejected value can never leave half a row written, and the promote-banner
 * exclusivity runs after that statement, only when this save actually turned the toggle on.
 */
export async function updateContent(
  scope: ServiceContentScope,
  id: number,
  input: ServiceContentUpdate,
): Promise<ServiceContentSaveResult> {
  const row = await mustFind(scope, id);
  const sets: { column: string; value: string | number }[] = [];

  for (const [code, value] of Object.entries(input.names ?? {})) {
    sets.push({ column: `${NAME_COLUMN}_${code}`, value: cleanName(code, value) });
  }

  const settings = input.settings ?? {};
  for (const [column, value] of Object.entries(settings)) {
    if (value == null) continue; // absent means "keep as is"
    sets.push({ column, value: cleanSetting(column, value) });
  }

  for (const [blobKey, fields] of Object.entries(input.copy ?? {})) {
    const spec = Object.prototype.hasOwnProperty.call(BLOB_BY_KEY, blobKey)
      ? BLOB_BY_KEY[blobKey]
      : undefined;
    if (!spec) throw AppError.badRequest(`Unknown text block: “${blobKey}”.`);
    const stored = parseBlob(row.values[blobKey]);
    if (stored === null) {
      throw AppError.badRequest(
        `“${spec.label}” is not valid JSON, so it cannot be edited here.`,
      );
    }
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw AppError.badRequest(
        `“${spec.label}” must be a map of <base>_<LANGUAGE> to text.`,
      );
    }

    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      const { base, code } = splitKey(field);
      // Only a base this column is known to carry, and only a shipped language: a new
      // base would grow the blob past anything the apps can read.
      if (!spec.bases.includes(base)) {
        throw AppError.badRequest(`Field “${field}” is not part of “${spec.label}”.`);
      }
      if (!LANG_CODE.test(code) || !CATEGORY_LANGUAGES.some((l) => l.code === code)) {
        throw AppError.badRequest(`Field “${field}” does not name a known language.`);
      }
      if (RESERVED_KEYS.has(base.toLowerCase())) {
        throw AppError.badRequest(`Field “${field}” uses a reserved name.`);
      }
      if (typeof value !== "string") {
        throw AppError.badRequest(`Field “${field}” must be text.`);
      }
      const text = value.trim();
      const reason = findContentViolation("text", text);
      if (reason) throw AppError.badRequest(`Field “${field}” ${reason}.`);
      const max = maxOfBase(base);
      if (text.length > max) {
        throw AppError.badRequest(`Field “${field}” must be at most ${max} characters.`);
      }
      // A key the column does not carry and a blank value is a no-op, not an addition:
      // writing it would put an empty translation where the apps read nothing at all.
      const held = Object.prototype.hasOwnProperty.call(stored, field);
      if (!held && !text) continue;
      if (held && stored[field] === text) continue;
      stored[field] = text;
      changed = true;
    }
    if (!changed) continue;

    // Keep the untouched remainder of the object — legacy-only bases included — by
    // writing the parsed copy back rather than only the keys in this request.
    const raw = JSON.stringify(stored);
    if (Buffer.byteLength(raw, "utf8") > MAX_BLOB_BYTES) {
      throw AppError.badRequest(`“${spec.label}” would grow past ${MAX_BLOB_BYTES} bytes.`);
    }
    sets.push({ column: blobKey, value: raw });
  }

  if (sets.length) await model.updateRowColumns(scope, id, sets);

  // The exclusivity runs after the row is written, and only when this save is what
  // turned the promotion on — a save that leaves the toggle alone must not clear
  // another service's banner.
  let promotedCleared = 0;
  if ("ePromoteBanner" in settings && settings.ePromoteBanner === "Yes") {
    promotedCleared = await model.clearPromoteBannerEverywhereExcept(id);
  }

  return { item: await getContent(scope, id), promotedCleared };
}

/** Flip this row's switch. Nothing else in the table moves. */
export async function changeStatus(
  scope: ServiceContentScope,
  id: number,
  status: ServiceContentStatus,
): Promise<ServiceContentDto> {
  const row = await mustFind(scope, id);
  if (row.status !== status) await model.setRowStatus(scope, id, status);
  return getContent(scope, id);
}

/** The slot a stream / upload endpoint is addressed as, or a 400 naming what exists. */
export function requireSlot(name: unknown): model.ImageSlotSpec {
  const key = String(name ?? "");
  const slot = model.SLOT_BY_NAME[key];
  if (!slot) {
    throw AppError.badRequest(
      `Unknown image slot: “${key || "(empty)"}”. Expected one of: ${IMAGE_SLOTS.map((s) => s.slot).join(", ")}.`,
    );
  }
  return slot;
}

/** Stored file name of one image column, for the stream endpoint. */
export async function getImageFilename(
  scope: ServiceContentScope,
  id: number,
  slot: model.ImageSlotSpec,
): Promise<string> {
  const row = await mustFind(scope, id);
  return String(row.values[slot.column] ?? "").trim();
}

/** Point an image column at a file already written to disk, and return the fresh row. */
export async function setImageFilename(
  scope: ServiceContentScope,
  id: number,
  slot: model.ImageSlotSpec,
  filename: string,
): Promise<ServiceContentDto> {
  await mustFind(scope, id);
  await model.updateRowColumns(scope, id, [{ column: slot.column, value: filename }]);
  return getContent(scope, id);
}
