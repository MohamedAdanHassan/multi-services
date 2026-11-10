import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";
import type { ContentFieldKind } from "../../../utils/contentSanitizer";
import { contentFieldLimit, findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/serviceCategoryModel";
import {
  BLOB_COLUMNS,
  CATEGORY_LANGUAGES,
  MEDIA_COLUMNS,
  SETTINGS,
  SETTINGS_BY_COLUMN,
  TEXT_FAMILIES,
} from "../models/serviceCategoryModel";
import type {
  CategoryRow,
  CategoryStatus,
  CategorySummaryRow,
  SettingSpec,
  TextFamilySpec,
} from "../models/serviceCategoryModel";

/**
 * Business rules for Ride service categories (group 7 → #sub-13).
 *
 * `vehicle_category` mixes three kinds of state in one row, and each is written
 * differently:
 *
 * - the per-language name/title/description columns are plain values, edited one
 *   language at a time and written as sent;
 * - the homepage copy columns are flat JSON objects keyed `<base>_<LANG>`, so a
 *   save merges only the keys the editor changed into the stored object and every
 *   other key, translation and language survives — exactly like the #sub-12
 *   section blobs;
 * - the settings columns are enums and numbers with a narrow legal range, so each
 *   value is checked against the legacy DDL rather than trusted.
 *
 * Everything is validated before anything is written, and the write itself is one
 * UPDATE: the table is MyISAM and has no transactions to fall back on.
 */

/** `vCategory_EN`, `tListDescription_ZHCN`: a legacy base name plus language. */
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
/** Names that would write onto an inherited property of the parsed JSON column. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty"]);
/** A JSON column is mediumtext, but a megabyte of tile copy is a mistake, not content. */
const MAX_BLOCK_BLOB_BYTES = 512_000;

const FAMILY_BY_KEY: Record<string, TextFamilySpec> = Object.assign(
  Object.create(null) as Record<string, TextFamilySpec>,
  Object.fromEntries(TEXT_FAMILIES.map((f) => [f.key, f])),
);

const MEDIA_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(MEDIA_COLUMNS.map((m) => [m.column, m.label])),
);

const BLOCK_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(BLOB_COLUMNS.map((b) => [b.key, b.label])),
);

const LANGUAGE_CODES = new Set<string>(CATEGORY_LANGUAGES.map((l) => l.code as string));

/**
 * How the apps render one homepage-copy key. Description-like bases are stored as
 * markup and get the passive-HTML rules; everything else is a title, name or
 * button label and must stay plain text.
 */
function blockFieldKind(base: string): ContentFieldKind {
  return /desc/i.test(base) ? "html" : "text";
}

/**
 * Legacy column names to a readable label: `v`/`t`/`l` are the type prefixes the
 * DDL uses, and the rest is camelCase, so `vCatSloganHomepage` reads back as
 * “Cat Slogan Homepage”.
 */
function prettifyBase(base: string): string {
  const words = base
    .replace(/^[a-z](?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `tBannerButtonText_EN` → `{ base: "tBannerButtonText", lang: "EN" }`. */
function splitKey(key: string): { base: string; lang: string } {
  const at = key.lastIndexOf("_");
  if (at <= 0) return { base: key, lang: "" };
  return { base: key.slice(0, at), lang: key.slice(at + 1) };
}

/**
 * Parse a stored JSON column into a prototype-less object so merged keys can
 * never touch inherited properties. An empty column is an empty block; a non-empty
 * value that is not a JSON object is reported as unparseable so callers refuse to
 * overwrite it instead of silently dropping what the legacy app stored.
 */
function parseRaw(value: string | number | null): Record<string, unknown> | null {
  const text = String(value ?? "").trim();
  if (!text) return Object.create(null) as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = entry;
    }
    return out;
  } catch {
    return null;
  }
}

/** The same block as text values, for the editor (never written back verbatim). */
function parseDisplay(value: string | number | null): Record<string, string> | null {
  const parsed = parseRaw(value);
  if (parsed === null) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(parsed)) {
    out[key] = typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
  }
  return out;
}

/** Text of one scalar column, trimmed the way the apps read it. */
function storedText(value: string | number | null): string {
  return String(value ?? "");
}

async function mustFind(id: number): Promise<CategoryRow> {
  const row = await model.findCategoryRow(id);
  if (!row) throw AppError.notFound(`Service category #${id} not found.`);
  return row;
}

export interface ServiceCategorySummaryDto extends CategorySummaryRow {
  languagesTotal: number;
}

export interface ServiceCategoryBlockDto {
  key: string;
  label: string;
  /** Editable bases of this block, i.e. the keys the legacy row actually uses. */
  fields: { base: string; label: string; kind: ContentFieldKind; max: number }[];
  /** Raw `<base>_<LANG>` map exactly as stored. */
  values: Record<string, string>;
  /** True when the column is not JSON — the editor must not overwrite it. */
  unparsed: boolean;
}

export interface ServiceCategoryDto {
  id: number;
  eFor: string;
  catType: string;
  subCatType: string;
  status: CategoryStatus;
  languages: { code: string; label: string }[];
  /** What each text group is and how far a value may go, so the form needs no copy of the DDL. */
  textSpecs: {
    key: string;
    label: string;
    kind: ContentFieldKind;
    max: number;
    multiline: boolean;
  }[];
  /** Family key → language code → text. */
  texts: Record<string, Record<string, string>>;
  media: { column: string; label: string; value: string }[];
  /** Legal values and ranges of every settings column. */
  settingSpecs: {
    column: string;
    label: string;
    kind: SettingSpec["kind"];
    options?: string[];
    min?: number;
    max?: number;
    note?: string;
  }[];
  /** Column → stored value as text, so the form can diff without type surprises. */
  settings: Record<string, string>;
  blocks: ServiceCategoryBlockDto[];
}

/** Bases used by a block, over every language, so an empty language can be filled in here. */
function blockFields(stored: Record<string, string>) {
  const seen = new Map<string, { base: string; label: string; kind: ContentFieldKind; max: number }>();
  for (const key of Object.keys(stored)) {
    const { base, lang } = splitKey(key);
    if (!base || lang === "" || seen.has(base)) continue;
    const kind = blockFieldKind(base);
    seen.set(base, { base, label: prettifyBase(base), kind, max: contentFieldLimit(kind) });
  }
  return [...seen.values()];
}

function toDto(row: CategoryRow): ServiceCategoryDto {
  const texts: Record<string, Record<string, string>> = {};
  for (const family of TEXT_FAMILIES) {
    const byLang: Record<string, string> = {};
    for (const lang of CATEGORY_LANGUAGES) {
      byLang[lang.code] = storedText(row.values[`${family.column}_${lang.code}`]);
    }
    texts[family.key] = byLang;
  }

  const settings: Record<string, string> = {};
  for (const spec of SETTINGS) {
    settings[spec.column] = storedText(row.values[spec.column]);
  }

  return {
    id: row.id,
    eFor: row.eFor,
    catType: row.catType,
    subCatType: row.subCatType,
    status: row.status,
    languages: CATEGORY_LANGUAGES.map((l) => ({ code: l.code as string, label: l.label })),
    textSpecs: TEXT_FAMILIES.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.kind,
      max: f.max,
      multiline: f.multiline,
    })),
    texts,
    media: MEDIA_COLUMNS.map((m) => ({
      column: m.column,
      label: m.label,
      value: storedText(row.values[m.column]),
    })),
    settingSpecs: SETTINGS.map((s) => ({
      column: s.column,
      label: s.label,
      kind: s.kind,
      options: s.kind === "enum" ? [...s.values] : undefined,
      min: s.kind === "enum" ? undefined : s.min,
      max: s.kind === "enum" ? undefined : s.max,
      note: s.note,
    })),
    settings,
    blocks: BLOB_COLUMNS.map((b) => {
      const values = parseDisplay(row.values[b.key]);
      return {
        key: b.key,
        label: BLOCK_LABEL[b.key] ?? b.key,
        fields: blockFields(values ?? {}),
        values: values ?? {},
        unparsed: values === null,
      };
    }),
  };
}

/** Validate one per-language text against the rules of its family. */
function cleanText(family: TextFamilySpec, code: string, value: unknown): string {
  if (typeof value !== "string") {
    throw AppError.badRequest(`${family.label} (${code}) must be text.`);
  }
  const text = value.trim();
  if (text.length > family.max) {
    throw AppError.badRequest(
      `${family.label} (${code}) must be at most ${family.max} characters.`,
    );
  }
  const reason = findContentViolation(family.kind, text);
  if (reason) throw AppError.badRequest(`${family.label} (${code}) ${reason}.`);
  return text;
}

/** Validate one artwork column: a bare legacy file name, never a path. */
function cleanMedia(column: string, value: unknown): string {
  if (typeof value !== "string") {
    throw AppError.badRequest(`“${MEDIA_LABEL[column]}” must be text.`);
  }
  const text = value.trim();
  const reason = findContentViolation("file", text);
  if (reason) throw AppError.badRequest(`“${MEDIA_LABEL[column]}” ${reason}.`);
  return text;
}

/** Validate one enum column against the legacy DDL, plus what the rows already hold. */
function cleanEnum(spec: Extract<SettingSpec, { kind: "enum" }>, value: unknown): string {
  if (typeof value !== "string") throw AppError.badRequest(`${spec.label} must be text.`);
  const text = value.trim();
  if (!spec.values.includes(text)) {
    const allowed = spec.values.filter((v) => v !== "").join(" / ") || "empty";
    throw AppError.badRequest(`${spec.label} must be one of: ${allowed}.`);
  }
  return text;
}

/** Validate one number column: type, range, and the two decimals float(10,2) can store. */
function cleanNumber(spec: Extract<SettingSpec, { kind: "int" | "float" }>, value: unknown): number {
  const label = spec.label;
  const raw = typeof value === "number" ? value : typeof value === "string" ? value.trim() : null;
  if (raw === null || raw === "") throw AppError.badRequest(`${label} must be a number.`);
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw AppError.badRequest(`${label} must be a number.`);
  if (spec.kind === "int" && !Number.isInteger(n)) {
    throw AppError.badRequest(`${label} must be a whole number.`);
  }
  if (n < spec.min || n > spec.max) {
    throw AppError.badRequest(`${label} must be between ${spec.min} and ${spec.max}.`);
  }
  return spec.kind === "float" ? Math.round(n * 100) / 100 : n;
}

/** Validate one homepage-copy key name; returns the field untouched. */
function checkFieldKey(field: string): void {
  if (!FIELD_KEY.test(field)) {
    throw AppError.badRequest(`Invalid field name: “${field}”.`);
  }
  const { base } = splitKey(field);
  if (RESERVED_KEYS.has(base.toLowerCase())) {
    throw AppError.badRequest(`Field “${field}” uses a reserved name.`);
  }
}

export interface ServiceCategoryUpdate {
  texts?: Record<string, Record<string, unknown>>;
  media?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  blocks?: Record<string, Record<string, unknown>>;
}

/**
 * Merge a save. Every group carries only what the editor changed; anything absent
 * from the payload keeps its stored value. All four groups end up in one UPDATE
 * so a rejected value can never leave half of a category written.
 */
export async function updateCategory(
  id: number,
  input: ServiceCategoryUpdate,
): Promise<ServiceCategoryDto> {
  const row = await mustFind(id);
  const sets: { column: string; value: string | number }[] = [];

  for (const [familyKey, byLang] of Object.entries(input.texts ?? {})) {
    const family = Object.prototype.hasOwnProperty.call(FAMILY_BY_KEY, familyKey)
      ? FAMILY_BY_KEY[familyKey]
      : undefined;
    if (!family) throw AppError.badRequest(`Unknown text group: “${familyKey}”.`);
    if (byLang === null || typeof byLang !== "object" || Array.isArray(byLang)) {
      throw AppError.badRequest(`Text group “${familyKey}” must be a map of language to text.`);
    }
    for (const [code, value] of Object.entries(byLang)) {
      if (!LANGUAGE_CODES.has(code)) {
        throw AppError.badRequest(`Unknown language code: “${code}”.`);
      }
      sets.push({
        column: `${family.column}_${code}`,
        value: cleanText(family, code, value),
      });
    }
  }

  for (const [column, value] of Object.entries(input.media ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(MEDIA_LABEL, column)) {
      throw AppError.badRequest(`Unknown image column: “${column}”.`);
    }
    sets.push({ column, value: cleanMedia(column, value) });
  }

  for (const [column, value] of Object.entries(input.settings ?? {})) {
    const spec = Object.prototype.hasOwnProperty.call(SETTINGS_BY_COLUMN, column)
      ? SETTINGS_BY_COLUMN[column]
      : undefined;
    if (!spec) throw AppError.badRequest(`Unknown setting: “${column}”.`);
    // Absent means “keep as is”; a provided value is checked against the DDL.
    if (value == null) continue;
    if (spec.kind === "enum") {
      sets.push({ column, value: cleanEnum(spec, value) });
    } else {
      sets.push({ column, value: cleanNumber(spec, value) });
    }
  }

  for (const [blockKey, fields] of Object.entries(input.blocks ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(BLOCK_LABEL, blockKey)) {
      throw AppError.badRequest(`Unknown text block: “${blockKey}”.`);
    }
    const stored = parseRaw(row.values[blockKey]);
    if (stored === null) {
      throw AppError.badRequest(
        `Block “${BLOCK_LABEL[blockKey]}” is not valid JSON, so it cannot be edited here.`,
      );
    }
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw AppError.badRequest(
        `Block “${BLOCK_LABEL[blockKey]}” must be a map of field names to text.`,
      );
    }

    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      checkFieldKey(field);
      if (typeof value !== "string") {
        throw AppError.badRequest(`Field “${field}” must be text.`);
      }
      const text = value.trim();
      const reason = findContentViolation(blockFieldKind(splitKey(field).base), text);
      if (reason) throw AppError.badRequest(`Field “${field}” ${reason}.`);

      const existing = Object.prototype.hasOwnProperty.call(stored, field)
        ? stored[field]
        : undefined;
      if (existing !== undefined && typeof existing !== "string") {
        // Refuse instead of replacing a structured value with its string form.
        throw AppError.badRequest(
          `Field “${field}” is stored as a non-text value, so it cannot be edited here.`,
        );
      }
      if (existing === undefined && !text) continue;
      if (existing !== text) {
        stored[field] = text;
        changed = true;
      }
    }
    if (!changed) continue;

    const raw = JSON.stringify(stored);
    if (Buffer.byteLength(raw, "utf8") > MAX_BLOCK_BLOB_BYTES) {
      throw AppError.badRequest(
        `Block “${BLOCK_LABEL[blockKey]}” would grow past ${MAX_BLOCK_BLOB_BYTES} bytes.`,
      );
    }
    sets.push({ column: blockKey, value: raw });
  }

  if (sets.length) {
    await model.updateCategoryColumns(id, sets);
    listCache.clear();
  }
  return toDto(await mustFind(id));
}

/** The ride-category catalog feeds several pickers; 60s reuse is plenty. */
const listCache = createTtlCache<ServiceCategorySummaryDto[]>(60_000, 4);

export async function listCategories(): Promise<ServiceCategorySummaryDto[]> {
  return listCache.load("list", async () => {
    const rows = await model.listCategoryRows();
    return rows.map((row) => ({ ...row, languagesTotal: CATEGORY_LANGUAGES.length }));
  });
}

export async function getCategory(id: number): Promise<ServiceCategoryDto> {
  return toDto(await mustFind(id));
}

export async function changeStatus(
  id: number,
  status: CategoryStatus,
): Promise<ServiceCategoryDto> {
  const row = await mustFind(id);
  if (row.status !== status) {
    await model.setCategoryStatus(id, status);
    listCache.clear();
  }
  return toDto(await mustFind(id));
}

export interface ServiceCategoryCreate {
  name: string;
  status: CategoryStatus;
}

/**
 * Add a new Ride category. The legacy "Add New Taxi Service" screen collected only
 * a name and a status, so this keeps to that: the English name is validated with
 * the same rules as a name edit (and must not be empty), the status is one of the
 * two the row scope allows, and everything else — artwork, settings, the other 25
 * languages — is left for the editor to flesh out once the row exists.
 */
export async function createCategory(input: ServiceCategoryCreate): Promise<ServiceCategoryDto> {
  const family = FAMILY_BY_KEY["name"];
  if (!family) throw AppError.badRequest("Category name family is unavailable.");
  const name = cleanText(family, "EN", input.name);
  if (!name) throw AppError.badRequest("Category name is required.");
  if (input.status !== "Active" && input.status !== "Inactive") {
    throw AppError.badRequest("Status must be Active or Inactive.");
  }
  const id = await model.createCategory({ name, status: input.status });
  listCache.clear();
  return toDto(await mustFind(id));
}

/**
 * The category's primary icon. The legacy "Edit Taxi Service" form uploaded a
 * single image into `webimages/upload/MasterServiceCategories/` and stored its
 * bare file name in the artwork column the apps and the list treat as the logo;
 * that is `vLogo`. Kept as one named column so the upload route and the list DTO
 * never disagree about which of the 14 artwork fields is "the icon".
 */
export const ICON_COLUMN = "vLogo";

/** The stored icon file name (bare, relative to the MasterServiceCategories dir), or "". */
export async function getIconFilename(id: number): Promise<string> {
  const row = await mustFind(id);
  return storedText(row.values[ICON_COLUMN]).trim();
}

/** Persist an uploaded icon file name into the icon column and return the refreshed category. */
export async function setIcon(id: number, filename: string): Promise<ServiceCategoryDto> {
  await model.updateCategoryColumns(id, [{ column: ICON_COLUMN, value: filename }]);
  listCache.clear();
  return toDto(await mustFind(id));
}
