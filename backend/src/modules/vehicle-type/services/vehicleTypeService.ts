import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";
import type { ContentFieldKind } from "../../../utils/contentSanitizer";
import { contentFieldLimit, findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/vehicleTypeModel";
import {
  ALL_LOCATIONS,
  BLOB_COLUMNS,
  CLOCK,
  GLOBAL_TIMES,
  MEDIA_COLUMNS,
  NO_CATEGORY,
  PICKUP_DAYS,
  PRIMARY_LANGUAGE,
  SCOPE_COLUMNS,
  SETTINGS,
  SETTINGS_BY_COLUMN,
  SURGE_KEYS,
  TEXT_FAMILIES,
  TYPE_LANGUAGES,
} from "../models/vehicleTypeModel";
import type {
  ScopeOption,
  SettingGroup,
  SettingSpec,
  TextFamilySpec,
  TypeRow,
  TypeStatus,
  TypeSummaryRow,
  VehicleTypeAppScope,
} from "../models/vehicleTypeModel";

/**
 * Business rules for vehicle types, shared by every app that owns a slice of the
 * `vehicle_type` table (Ride #sub-15, Deliver #sub-138, DeliverAll / Genie #sub-153).
 * Each entry takes the request's {@link VehicleTypeAppScope} so it only ever reads /
 * writes its own rows.
 *
 * One `vehicle_type` row mixes four kinds of state, each written differently:
 *
 * - the 26 per-language name and rental-alias columns are plain values, written as
 *   sent. The unsuffixed `vVehicleType` column is a legacy mirror every Ride row
 *   keeps equal to the English name, so it is written with it rather than left to
 *   drift;
 * - the four copy blobs are flat JSON objects keyed `<column>_<LANG>` and
 *   `tNightSurgeData` is a flat JSON object of 21 fixed schedule keys, so a save
 *   merges only the keys the editor changed and every other key survives — the
 *   blobs on several rows are empty or hold only some languages;
 * - the fare, policy and surcharge columns are enums and `float(10,2)` numbers
 *   that are checked against the legacy DDL instead of trusted.
 *
 * Everything is validated before anything is written, and the write itself is one
 * UPDATE: the table has no primary key and each row is shared by ten other
 * legacy tables, so a save must either fully apply or not happen at all.
 */

/** `<column>_<LANG>` key names; the service owns the real whitelist of columns. */
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
/** Names that would write onto an inherited property of a parsed JSON column. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty"]);
/** A blob column is text/longtext, but a megabyte of fare schedule is a mistake. */
const MAX_BLOB_BYTES = 512_000;
/** The largest value `float(10,2)` can hold: 8 digits, then 2 decimals. */
const FLOAT_COLUMN_MAX = 99_999_99.99;

const FAMILY_BY_KEY: Record<string, TextFamilySpec> = Object.assign(
  Object.create(null) as Record<string, TextFamilySpec>,
  Object.fromEntries(TEXT_FAMILIES.map((f) => [f.key, f])),
);

const MEDIA_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(MEDIA_COLUMNS.map((m) => [m.column, m.label])),
);

const BLOB_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(BLOB_COLUMNS.map((b) => [b.column, b.label])),
);

const BLOB_BY_COLUMN: Record<string, (typeof BLOB_COLUMNS)[number]> = Object.assign(
  Object.create(null) as Record<string, (typeof BLOB_COLUMNS)[number]>,
  Object.fromEntries(BLOB_COLUMNS.map((b) => [b.column, b])),
);

const LANGUAGE_CODES = new Set<string>(TYPE_LANGUAGES.map((l) => l.code as string));

/** The 18 `MySQL time` columns of the surcharge schedule, with their labels. */
const TIME_COLUMNS: { column: string; label: string }[] = [
  ...GLOBAL_TIMES.map((t) => ({ column: t.column, label: t.label })),
  ...PICKUP_DAYS.flatMap((d) => [
    { column: d.start, label: `${d.label} pick-up from` },
    { column: d.end, label: `${d.label} pick-up to` },
  ]),
];

const TIME_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(TIME_COLUMNS.map((t) => [t.column, t.label])),
);

const SURGE_LABEL: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(SURGE_KEYS.map((s) => [s.key, s.label])),
);

/** The night-surcharge blob always carries these 21 keys in the legacy app. */
const SURGE_BY_KEY: Record<string, (typeof SURGE_KEYS)[number]> = Object.assign(
  Object.create(null) as Record<string, (typeof SURGE_KEYS)[number]>,
  Object.fromEntries(SURGE_KEYS.map((s) => [s.key, s])),
);

/** `<tTypeDesc_EN>` → `{ base: "tTypeDesc", lang: "EN" }`. */
function splitKey(key: string): { base: string; lang: string } {
  const at = key.lastIndexOf("_");
  if (at <= 0) return { base: key, lang: "" };
  return { base: key.slice(0, at), lang: key.slice(at + 1) };
}

/**
 * Parse a stored JSON column into a prototype-less object so merged keys can
 * never touch inherited properties. An empty column is an empty object; a
 * non-empty value that is not a JSON object is reported as unparseable so callers
 * refuse to overwrite it instead of silently dropping what the legacy app stored.
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

/** Text of one scalar column, as the apps read it. */
function storedText(value: string | number | null): string {
  return value == null ? "" : String(value);
}

async function mustFind(scope: VehicleTypeAppScope, id: number): Promise<TypeRow> {
  const row = await model.findTypeRow(scope, id);
  if (!row) throw AppError.notFound(`Vehicle type #${id} not found.`);
  return row;
}

export interface VehicleTypeFieldDto {
  key: string;
  label: string;
  kind: ContentFieldKind;
  max: number;
}

export interface VehicleTypeBlobDto {
  column: string;
  label: string;
  /** One field per language the column pre-allocates, even when it is still empty. */
  fields: VehicleTypeFieldDto[];
  /** Raw `<column>_<LANG>` map exactly as stored. */
  values: Record<string, string>;
  /** Stored keys this screen does not edit; they survive a save untouched. */
  extraKeys: string[];
  /** True when the column is not JSON — the editor must not overwrite it. */
  unparsed: boolean;
}

export interface VehicleTypeScope {
  /** Zone id, or `ALL_LOCATIONS` (-1) when offered everywhere. */
  locationId: number;
  /** Resolved zone label; "" for All locations, or the stored name when unlisted. */
  locationName: string;
  /** Category id, or `NO_CATEGORY` (0) when not tied to one. */
  categoryId: number;
  /** Resolved category label; "" for No specific category. */
  categoryName: string;
}

/** Choices the two scope dropdowns are built from; the sentinels are added client-side. */
export interface VehicleTypeScopeOptions {
  locations: ScopeOption[];
  categories: ScopeOption[];
}

export interface VehicleTypeDto {
  id: number;
  status: TypeStatus;
  languages: { code: string; label: string }[];
  textSpecs: { key: string; label: string; kind: ContentFieldKind; max: number; multiline: boolean }[];
  /** Family key → language code → text. */
  texts: Record<string, Record<string, string>>;
  media: { column: string; label: string; value: string }[];
  /** Legal values and ranges of every enum / number column, grouped for the form. */
  settingSpecs: {
    column: string;
    label: string;
    group: SettingGroup;
    kind: SettingSpec["kind"];
    options?: string[];
    min?: number;
    max?: number;
    note?: string;
  }[];
  /** Column → stored value as text, so the form can diff without type surprises. */
  settings: Record<string, string>;
  timeSpecs: { column: string; label: string }[];
  times: Record<string, string>;
  /** Weekday rows of the pick-up surcharge grid: window columns + amount column. */
  pickups: { day: string; label: string; start: string; end: string; price: string }[];
  surge: {
    specs: { key: string; label: string; day: string; kind: "time" | "float" }[];
    values: Record<string, string>;
    extraKeys: string[];
    unparsed: boolean;
  };
  blobs: VehicleTypeBlobDto[];
  /** Editable zone + category binding, resolved for honest round-tripping. */
  scope: VehicleTypeScope;
  /** Every legal zone / category the two dropdowns may offer. */
  scopeOptions: VehicleTypeScopeOptions;
  /** Service line and geo cascade this screen shows but never writes. */
  readonly: {
    eType: string;
    iCountryId: number;
    iStateId: number;
    iCityId: number;
    vAddress: string;
    geoLabel: string;
  };
}

/** The 26 `<column>_<LANG>` keys a language blob can hold, plus anything extra stored. */
function blobFields(column: string, kind: ContentFieldKind, stored: Record<string, unknown>) {
  const fields: VehicleTypeFieldDto[] = TYPE_LANGUAGES.map((l) => ({
    key: `${column}_${l.code}`,
    label: l.label,
    kind,
    max: contentFieldLimit(kind),
  }));
  const known = new Set(fields.map((f) => f.key));
  const extraKeys = Object.keys(stored).filter((key) => !known.has(key));
  return { fields, extraKeys };
}

/**
 * The country/state/city cascade and free address stay read-only (the location
 * screens own them), so they are folded into one label that only surfaces values
 * that actually point at something — the sentinel 0s are invisible.
 */
function geoLabel(readonly: TypeRow["readonly"]): string {
  const address = storedText(readonly.vAddress).trim();

  const geo: string[] = [];
  if (Number(readonly.iCountryId ?? 0) > 0) geo.push(`country ${Number(readonly.iCountryId)}`);
  if (Number(readonly.iStateId ?? 0) > 0) geo.push(`state ${Number(readonly.iStateId)}`);
  if (Number(readonly.iCityId ?? 0) > 0) geo.push(`city ${Number(readonly.iCityId)}`);
  if (geo.length) return geo.join(" · ");

  if (address) return `Address only: ${address}`;
  return "No further geo restriction";
}

function toDto(row: TypeRow): VehicleTypeDto {
  const texts: Record<string, Record<string, string>> = {};
  for (const family of TEXT_FAMILIES) {
    const byLang: Record<string, string> = {};
    for (const lang of TYPE_LANGUAGES) {
      byLang[lang.code] = storedText(row.values[`${family.base}_${lang.code}`]);
    }
    texts[family.key] = byLang;
  }

  const settings: Record<string, string> = {};
  for (const spec of SETTINGS) {
    settings[spec.column] = storedText(row.values[spec.column]);
  }

  const times: Record<string, string> = {};
  for (const { column } of TIME_COLUMNS) {
    times[column] = storedText(row.values[column]);
  }

  const blobs: VehicleTypeBlobDto[] = BLOB_COLUMNS.map((b) => {
    const parsed = parseRaw(row.values[b.column]);
    const stored = parsed ?? {};
    const { fields, extraKeys } = blobFields(b.column, b.kind, stored);
    const values = Object.create(null) as Record<string, string>;
    for (const [key, entry] of Object.entries(stored)) {
      values[key] = typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
    }
    return {
      column: b.column,
      label: BLOB_LABEL[b.column] ?? b.column,
      fields,
      values,
      extraKeys,
      unparsed: parsed === null,
    };
  });

  const surgeParsed = parseRaw(row.values.tNightSurgeData);
  const surgeStored = surgeParsed ?? {};
  const surgeValues = Object.create(null) as Record<string, string>;
  for (const spec of SURGE_KEYS) {
    const entry = Object.prototype.hasOwnProperty.call(surgeStored, spec.key)
      ? surgeStored[spec.key]
      : undefined;
    if (entry !== undefined) {
      surgeValues[spec.key] = typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
    }
  }

  return {
    id: row.id,
    status: row.status,
    languages: TYPE_LANGUAGES.map((l) => ({ code: l.code as string, label: l.label })),
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
      group: s.group,
      kind: s.kind,
      options: s.kind === "enum" ? [...s.values] : undefined,
      min: s.kind === "enum" ? undefined : s.min,
      max: s.kind === "enum" ? undefined : s.max,
      note: s.note,
    })),
    settings,
    timeSpecs: TIME_COLUMNS.map((t) => ({ ...t })),
    times,
    pickups: PICKUP_DAYS.map((d) => ({ day: d.day, label: d.label, start: d.start, end: d.end, price: d.price })),
    surge: {
      specs: SURGE_KEYS.map((s) => ({ key: s.key, label: s.label, day: s.day, kind: s.kind })),
      values: surgeValues,
      extraKeys: Object.keys(surgeStored).filter((key) => !Object.prototype.hasOwnProperty.call(SURGE_BY_KEY, key)),
      unparsed: surgeParsed === null,
    },
    blobs,
    scope: {
      locationId: Number(row.values.iLocationid ?? ALL_LOCATIONS),
      locationName: "",
      categoryId: Number(row.values.iVehicleCategoryId ?? NO_CATEGORY),
      categoryName: "",
    },
    scopeOptions: { locations: [], categories: [] },
    readonly: {
      eType: storedText(row.readonly.eType),
      iCountryId: Number(row.readonly.iCountryId ?? 0),
      iStateId: Number(row.readonly.iStateId ?? 0),
      iCityId: Number(row.readonly.iCityId ?? 0),
      vAddress: storedText(row.readonly.vAddress),
      geoLabel: geoLabel(row.readonly),
    },
  };
}

/**
 * Zone / category option lists feed every type's edit form. They live in other
 * modules' tables (`location_master`, `vehicle_category`), so this module has no
 * write to invalidate on — a 60s TTL is the staleness bound, and the two lists
 * collapse a per-edit pair of round trips into one cached read.
 */
const scopeOptionsCache = createTtlCache<VehicleTypeScopeOptions>(60_000, 4);

/**
 * Fill the scope dropdowns and resolve the two bound names. The current zone /
 * category is always present in `scope` even when it is missing from the option
 * list (a soft-deleted reference), so an edit never silently drops a stored value
 * the admin did not choose to change.
 */
async function withScope(
  appScope: VehicleTypeAppScope,
  dto: VehicleTypeDto,
): Promise<VehicleTypeDto> {
  const { locations, categories } = await scopeOptionsCache.load(appScope.categoryEFor, async () => {
    const [locs, cats] = await Promise.all([
      model.listLocationZoneOptions(),
      model.listCategoryOptions(appScope),
    ]);
    return { locations: locs, categories: cats };
  });
  dto.scopeOptions = { locations, categories };

  const { scope } = dto;
  if (scope.locationId > 0) {
    const listed = locations.find((l) => l.id === scope.locationId)?.name;
    scope.locationName = listed || (await model.findLocationZoneName(scope.locationId));
  }
  if (scope.categoryId > 0) {
    const listed = categories.find((c) => c.id === scope.categoryId)?.name;
    scope.categoryName = listed || (await model.findCategoryName(scope.categoryId));
  }
  return dto;
}

/** Parse one scope id from the payload (an HTML select may send it as text). */
function cleanScopeId(raw: unknown): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^-?\d+$/.test(text)) throw AppError.badRequest("Scope ids must be whole numbers.");
  return Number(text);
}

/** Validate one zone: the All-locations sentinel, or a zone that still exists. */
async function cleanLocationId(spec: (typeof SCOPE_COLUMNS)["location"], value: unknown): Promise<number> {
  const id = cleanScopeId(value);
  if (id === spec.sentinel) return spec.sentinel;
  if (id < 0 || !(await model.locationZoneExists(id))) {
    throw AppError.badRequest(`${spec.label}: no location zone #${id}.`);
  }
  return id;
}

/** Validate one category: the no-category sentinel, or a live category in the app's scope. */
async function cleanCategoryId(
  scope: VehicleTypeAppScope,
  spec: (typeof SCOPE_COLUMNS)["category"],
  value: unknown,
): Promise<number> {
  const id = cleanScopeId(value);
  if (id === spec.sentinel) return spec.sentinel;
  if (id < 0 || !(await model.categoryExists(scope, id))) {
    throw AppError.badRequest(`${spec.label}: no ${scope.label} category #${id}.`);
  }
  return id;
}

/** Validate one per-language text against the rules of its family. */
function cleanText(family: TextFamilySpec, code: string, value: unknown): string {
  if (typeof value !== "string") {
    throw AppError.badRequest(`${family.label} (${code}) must be text.`);
  }
  const text = value.trim();
  if (text.length > family.max) {
    throw AppError.badRequest(`${family.label} (${code}) must be at most ${family.max} characters.`);
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
  if (Math.abs(n) > FLOAT_COLUMN_MAX) {
    throw AppError.badRequest(`${label} is too large for a fare column.`);
  }
  return spec.kind === "float" ? Math.round(n * 100) / 100 : n;
}

/** Validate a schedule time, normalising it to the `HH:MM:SS` the column stores. */
function cleanClock(label: string, value: unknown): string {
  if (typeof value !== "string") throw AppError.badRequest(`${label} must be a time.`);
  const text = value.trim();
  if (!text) return model.BLANK_TIME;
  if (!CLOCK.test(text)) {
    throw AppError.badRequest(`${label} must be a time like 18:00 or 18:00:00.`);
  }
  const [hour = "0", minute = "0", second = "0"] = text.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`;
}

/**
 * Validate one night-surcharge value. The blob stores text and the legacy app
 * writes both `18:00` and `18:00:00`, so a clock is normalised to the column
 * format while a price keeps the exact digits it was sent with.
 */
function cleanSurge(spec: (typeof SURGE_KEYS)[number], value: unknown): string {
  if (typeof value !== "string") throw AppError.badRequest(`${spec.label} must be text.`);
  const text = value.trim();
  if (!text) return "";
  if (spec.kind === "time") {
    if (!CLOCK.test(text)) {
      throw AppError.badRequest(`${spec.label} must be a time like 18:00 or 18:00:00.`);
    }
    return text;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw AppError.badRequest(`${spec.label} must be a number.`);
  if (n < 0 || n > 99_999) {
    throw AppError.badRequest(`${spec.label} must be between 0 and 99999.`);
  }
  return String(Math.round(n * 100) / 100);
}

/** Validate a blob field name; returns the field untouched. */
function checkFieldKey(field: string): void {
  if (!FIELD_KEY.test(field)) throw AppError.badRequest(`Invalid field name: “${field}”.`);
  const { base } = splitKey(field);
  if (RESERVED_KEYS.has(base.toLowerCase())) {
    throw AppError.badRequest(`Field “${field}” uses a reserved name.`);
  }
}

/** Language part of a blob key, checked against the 26 the table allocates. */
function checkLangKey(column: string, field: string): void {
  checkFieldKey(field);
  const { base, lang } = splitKey(field);
  if (base !== column) {
    throw AppError.badRequest(`Field “${field}” does not belong to “${BLOB_LABEL[column]}”.`);
  }
  if (!LANGUAGE_CODES.has(lang)) throw AppError.badRequest(`Unknown language code: “${lang}”.`);
}

/**
 * Collect one column assignment. A later write to the same column wins, so a
 * payload touching both `vVehicleType_EN` and the legacy mirror it feeds can never
 * put one column in the SET list twice.
 */
function queueSet(
  sets: { column: string; value: string | number }[],
  column: string,
  value: string | number,
): void {
  const at = sets.findIndex((s) => s.column === column);
  if (at >= 0) sets[at] = { column, value };
  else sets.push({ column, value });
}

export interface VehicleTypeScopeInput {
  locationId?: unknown;
  categoryId?: unknown;
}

export interface VehicleTypeUpdate {
  texts?: Record<string, Record<string, unknown>>;
  media?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  times?: Record<string, unknown>;
  surge?: Record<string, unknown>;
  blobs?: Record<string, Record<string, unknown>>;
  /** Zone / category binding; a present key is validated and written. */
  scope?: VehicleTypeScopeInput;
}

/**
 * Merge a save. Every group carries only what the editor changed; anything absent
 * from the payload keeps its stored value. All six groups end up in one UPDATE,
 * so a rejected value can never leave half of a type written.
 */
export async function updateType(
  scope: VehicleTypeAppScope,
  id: number,
  input: VehicleTypeUpdate,
): Promise<VehicleTypeDto> {
  const row = await mustFind(scope, id);
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
      const text = cleanText(family, code, value);
      // The English name is what the apps list and the mirror column repeats, so
      // blanking it would leave a bookable type with no label at all.
      if (family.mirror && code === PRIMARY_LANGUAGE && !text) {
        throw AppError.badRequest(`${family.label} (${code}) is required — a type cannot be unnamed.`);
      }
      queueSet(sets, `${family.base}_${code}`, text);
      // The apps still read the unsuffixed legacy column, so it follows English.
      if (family.mirror && code === PRIMARY_LANGUAGE) queueSet(sets, family.mirror, text);
    }
  }

  for (const [column, value] of Object.entries(input.media ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(MEDIA_LABEL, column)) {
      throw AppError.badRequest(`Unknown image column: “${column}”.`);
    }
    queueSet(sets, column, cleanMedia(column, value));
  }

  for (const [column, value] of Object.entries(input.settings ?? {})) {
    const spec = Object.prototype.hasOwnProperty.call(SETTINGS_BY_COLUMN, column)
      ? SETTINGS_BY_COLUMN[column]
      : undefined;
    if (!spec) throw AppError.badRequest(`Unknown setting: “${column}”.`);
    // Absent means “keep as is”; a provided value is checked against the DDL.
    if (value == null) continue;
    queueSet(
      sets,
      column,
      spec.kind === "enum" ? cleanEnum(spec, value) : cleanNumber(spec, value),
    );
  }

  for (const [column, value] of Object.entries(input.times ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(TIME_LABEL, column)) {
      throw AppError.badRequest(`Unknown schedule column: “${column}”.`);
    }
    queueSet(sets, column, cleanClock(TIME_LABEL[column], value));
  }

  if (input.surge) {
    const stored = parseRaw(row.values.tNightSurgeData);
    if (stored === null) {
      throw AppError.badRequest(
        "The night surcharge schedule is not valid JSON, so it cannot be edited here.",
      );
    }
    let changed = false;
    for (const [key, value] of Object.entries(input.surge)) {
      checkFieldKey(key);
      const spec = Object.prototype.hasOwnProperty.call(SURGE_BY_KEY, key)
        ? SURGE_BY_KEY[key]
        : undefined;
      if (!spec) {
        throw AppError.badRequest(`Unknown night surcharge field: “${key}”.`);
      }
      const clean = cleanSurge(spec, value);
      const existing = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
      if (existing !== undefined && typeof existing !== "string") {
        // Refuse instead of replacing a structured value with its string form.
        throw AppError.badRequest(
          `“${SURGE_LABEL[key]}” is stored as a non-text value, so it cannot be edited here.`,
        );
      }
      if (existing === undefined && !clean) continue;
      if (existing !== clean) {
        stored[key] = clean;
        changed = true;
      }
    }
    if (changed) {
      const raw = JSON.stringify(stored);
      if (Buffer.byteLength(raw, "utf8") > MAX_BLOB_BYTES) {
        throw AppError.badRequest(`The night surcharge schedule would grow past ${MAX_BLOB_BYTES} bytes.`);
      }
      queueSet(sets, "tNightSurgeData", raw);
    }
  }

  for (const [column, fields] of Object.entries(input.blobs ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(BLOB_LABEL, column)) {
      throw AppError.badRequest(`Unknown text block: “${column}”.`);
    }
    const spec = BLOB_BY_COLUMN[column];
    const stored = parseRaw(row.values[column]);
    if (stored === null) {
      throw AppError.badRequest(
        `“${BLOB_LABEL[column]}” is not valid JSON, so it cannot be edited here.`,
      );
    }
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw AppError.badRequest(`“${BLOB_LABEL[column]}” must be a map of field names to text.`);
    }

    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      checkLangKey(column, field);
      if (typeof value !== "string") {
        throw AppError.badRequest(`Field “${field}” must be text.`);
      }
      const text = value.trim();
      const reason = findContentViolation(spec.kind, text);
      if (reason) throw AppError.badRequest(`Field “${field}” ${reason}.`);
      if (text.length > contentFieldLimit(spec.kind)) {
        throw AppError.badRequest(
          `Field “${field}” must be at most ${contentFieldLimit(spec.kind)} characters.`,
        );
      }

      const existing = Object.prototype.hasOwnProperty.call(stored, field) ? stored[field] : undefined;
      if (existing !== undefined && typeof existing !== "string") {
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
    if (Buffer.byteLength(raw, "utf8") > MAX_BLOB_BYTES) {
      throw AppError.badRequest(`“${BLOB_LABEL[column]}” would grow past ${MAX_BLOB_BYTES} bytes.`);
    }
    queueSet(sets, column, raw);
  }

  // A present scope key is checked against the referenced table before the write;
  // an absent one keeps the stored binding.
  if (input.scope) {
    if (input.scope.locationId !== undefined) {
      queueSet(sets, SCOPE_COLUMNS.location.column, await cleanLocationId(SCOPE_COLUMNS.location, input.scope.locationId));
    }
    if (input.scope.categoryId !== undefined) {
      queueSet(sets, SCOPE_COLUMNS.category.column, await cleanCategoryId(scope, SCOPE_COLUMNS.category, input.scope.categoryId));
    }
  }

  if (sets.length) await model.updateTypeColumns(scope, id, sets);
  return withScope(scope, toDto(await mustFind(scope, id)));
}

export interface VehicleTypeCreate {
  name: unknown;
  status?: unknown;
  logo?: unknown;
  /**
   * Columns the add form asks about, keyed by legacy column name and validated by
   * the same specs an update uses. Which ones a form sends is the app's decision —
   * Taxi and Parcel ask how the type looks and rides, Genie asks what a delivery
   * costs — so create carries a map instead of a fixed list of one app's fields.
   */
  settings?: Record<string, unknown>;
  /** Zone / category to bind; absent leaves the legacy All-locations / no-category defaults. */
  scope?: VehicleTypeScopeInput;
}

/**
 * Add a type to the app's scope. `vehicle_type` declares 95 NOT NULL columns with
 * no default, so the model supplies every one of them (the DDL's own defaults),
 * forces the scope's `eType`, and only the handful the create form asks about are
 * overwritten here.
 */
export async function createType(
  scope: VehicleTypeAppScope,
  input: VehicleTypeCreate,
): Promise<VehicleTypeDto> {
  const nameFamily = TEXT_FAMILIES[0];
  const name = cleanText(nameFamily, PRIMARY_LANGUAGE, input.name);
  if (!name) throw AppError.badRequest(`${nameFamily.label} is required.`);
  if (await model.isNameTaken(scope, name, null)) {
    throw AppError.badRequest(`A ${scope.label} vehicle type named “${name}” already exists.`);
  }

  const status: TypeStatus = input.status === "Inactive" ? "Inactive" : "Active";

  const values: Record<string, string | number> = {
    [`vVehicleType_${PRIMARY_LANGUAGE}`]: name,
    vVehicleType: name,
    eStatus: status,
  };
  if (input.logo !== undefined && String(input.logo) !== "") {
    values.vLogo = cleanMedia("vLogo", input.logo);
  }

  // An empty or absent value means "leave the legacy default", exactly as on a save,
  // so a form field the admin did not fill in never writes a 0 over the DDL default.
  for (const [column, value] of Object.entries(input.settings ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_BY_COLUMN, column)) {
      throw AppError.badRequest(`Unknown setting: “${column}”.`);
    }
    if (value == null || String(value).trim() === "") continue;
    const spec = SETTINGS_BY_COLUMN[column];
    values[column] = spec.kind === "enum" ? cleanEnum(spec, value) : cleanNumber(spec, value);
  }

  // Display order is the one column with a smarter default than the DDL's: a new
  // type belongs at the end of its own app's list, not next to the row above it.
  if (values.iDisplayOrder === undefined) {
    values.iDisplayOrder = await model.nextDisplayOrder(scope);
  }

  if (input.scope?.locationId !== undefined && String(input.scope.locationId) !== "") {
    values[SCOPE_COLUMNS.location.column] = await cleanLocationId(
      SCOPE_COLUMNS.location,
      input.scope.locationId,
    );
  }
  if (input.scope?.categoryId !== undefined && String(input.scope.categoryId) !== "") {
    values[SCOPE_COLUMNS.category.column] = await cleanCategoryId(
      scope,
      SCOPE_COLUMNS.category,
      input.scope.categoryId,
    );
  }

  const id = await model.nextTypeId();
  await model.insertTypeRow(scope, id, values);
  const row = await model.findTypeRow(scope, id);
  if (!row) throw AppError.notFound("Vehicle type was created but could not be re-read.");
  return withScope(scope, toDto(row));
}

/**
 * The row a create would produce, described the same way an edit is: every
 * column at its legacy DDL default. The add form renders its choices from this,
 * so no client holds a second copy of the enum lists or the numeric ranges.
 */
export async function blankRecord(scope: VehicleTypeAppScope): Promise<VehicleTypeDto> {
  const values = Object.create(null) as Record<string, string | number | null>;
  for (const column of Object.keys(model.EDITABLE_COLUMNS)) {
    values[column] = Object.prototype.hasOwnProperty.call(model.CREATE_DEFAULTS, column)
      ? model.CREATE_DEFAULTS[column]
      : "";
  }
  const readonly = Object.create(null) as Record<string, string | number | null>;
  for (const column of model.READONLY_COLUMNS) {
    readonly[column] = model.CREATE_DEFAULTS[column] ?? "";
  }
  // The scope's own service line, so a create form never previews another app's.
  readonly.eType = scope.eType;
  return withScope(
    scope,
    toDto({
      id: 0,
      status: model.CREATE_DEFAULTS.eStatus === "Inactive" ? "Inactive" : "Active",
      values,
      readonly,
    }),
  );
}

export async function listTypes(
  scope: VehicleTypeAppScope,
): Promise<(TypeSummaryRow & { languagesTotal: number })[]> {
  const rows = await model.listTypeRows(scope);
  return rows.map((row) => ({ ...row, languagesTotal: TYPE_LANGUAGES.length }));
}

export interface VehicleTypePage {
  rows: (TypeSummaryRow & { languagesTotal: number })[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/**
 * One filtered page of an app's types (store-management's contract) so a caller
 * that opts in with `page`/`limit`/`search`/`status` never pulls the whole table.
 */
export async function listTypesPaged(
  scope: VehicleTypeAppScope,
  raw: {
    search?: unknown;
    status?: unknown;
    page?: unknown;
    limit?: unknown;
  },
): Promise<VehicleTypePage> {
  const search = String(raw.search ?? "").trim();
  const status = raw.status === "Active" || raw.status === "Inactive" ? (raw.status as TypeStatus) : undefined;
  const limit = Math.min(Math.max(Number(raw.limit) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  let page = Math.max(Number(raw.page) || 1, 1);

  const filters: model.TypeListFilters = { search, status };
  const [total, firstRows] = await Promise.all([
    model.countTypes(scope, filters),
    model.listTypePage(scope, { ...filters, page, limit }),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  let rows = firstRows;
  if (page > pages) {
    page = pages;
    rows = await model.listTypePage(scope, { ...filters, page, limit });
  }
  return {
    rows: rows.map((row) => ({ ...row, languagesTotal: TYPE_LANGUAGES.length })),
    total,
    page,
    limit,
    pages,
  };
}

export async function getType(scope: VehicleTypeAppScope, id: number): Promise<VehicleTypeDto> {
  return withScope(scope, toDto(await mustFind(scope, id)));
}

export async function changeStatus(
  scope: VehicleTypeAppScope,
  id: number,
  status: TypeStatus,
): Promise<VehicleTypeDto> {
  const row = await mustFind(scope, id);
  if (row.status !== status) await model.setTypeStatus(scope, id, status);
  return toDto(await mustFind(scope, id));
}

/**
 * Soft delete, guarded. Ten legacy tables key on `iVehicleTypeId`, so the row is
 * hidden rather than removed; a type with live work attached cannot be hidden at
 * all, and because `Deleted` rows leave this screen's scope the action has no
 * undo here, so the caller must echo the type's name to prove it meant it.
 */
export async function deleteType(
  scope: VehicleTypeAppScope,
  id: number,
  confirm: unknown,
): Promise<{ id: number; name: string; tripRecords: number }> {
  const row = await mustFind(scope, id);
  const name = storedText(row.values[`vVehicleType_${PRIMARY_LANGUAGE}`]).trim();

  const wanted = typeof confirm === "string" ? confirm.trim() : "";
  if (!wanted) throw AppError.badRequest("Type the vehicle type name to confirm the delete.");
  if (wanted !== name) {
    throw AppError.badRequest(`Confirmation does not match: this type is named “${name}”.`);
  }

  const usage = await model.countTypeUsage(id);
  const blockers: string[] = [];
  if (usage.ongoingTrips) blockers.push(`${usage.ongoingTrips} ongoing trip(s)`);
  if (usage.openBookings) blockers.push(`${usage.openBookings} open booking(s)`);
  if (usage.openRequests) blockers.push(`${usage.openRequests} open request(s)`);
  if (usage.rentalPackages) blockers.push(`${usage.rentalPackages} rental package(s)`);
  if (blockers.length) {
    throw AppError.badRequest(
      `“${name}” still has ${blockers.join(", ")} attached and cannot be deleted.`,
    );
  }

  await model.softDeleteType(scope, id);
  return { id, name, tripRecords: usage.tripRecords };
}
