import { AppError } from "../../../errors/AppError";
import {
  contentFieldKind,
  findContentViolation,
  findMetaViolation,
} from "../../../utils/contentSanitizer";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";
import * as model from "../models/serviceContentModel";
import { sectionColumn } from "../models/serviceContentModel";
import type {
  ContentAppScope,
  ContentRow,
  ContentStatus,
  ContentSummaryRow,
} from "../models/serviceContentModel";

/**
 * Business rules for the app landing-page copy (Taxi Service → #sub-12 and
 * Parcel Delivery → #sub-135, which share one legacy table).
 *
 * Each `l*Section` column is a flat JSON object of `<field>_<LANG>` keys. The
 * editor never rewrites a whole blob from scratch: it sends only the fields it
 * actually changed (already language-suffixed), and this service merges them
 * into the stored object, so every other field, translation and language
 * survives a save — including keys the admin UI does not know about.
 *
 * Every entry point takes the caller's {@link ContentAppScope}, which decides both
 * which rows are visible and which blocks may be written: a save aimed at Parcel
 * Delivery cannot reach a ride-only column of the same table, and the row lookup is
 * bound to the app the route was addressed as.
 *
 * Merging happens on the parsed JSON, not on a stringified view of it: a stored
 * value that is not a string is left exactly as it was, and editing it is
 * refused rather than quietly flattened to `"[object Object]"`.
 */

/** `title_EN`, `cartype_img1_AR`, and the legacy empty-suffix `title_`. */
const FIELD_KEY = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
/** Names that would write onto an inherited property of the parsed blob. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty"]);
/** A section blob is longtext, but a megabyte of copy is a mistake, not content. */
const MAX_SECTION_BLOB_BYTES = 512_000;
const MAX_META_TITLE_LEN = 200; // varchar(200)
const MAX_META_TEXT_LEN = 2_000; // text

/** `base_LANG` → parts. Keys without a language (e.g. `title_`) give `""`. */
function splitKey(key: string): { base: string; lang: string } {
  const at = key.lastIndexOf("_");
  if (at <= 0) return { base: key, lang: "" };
  return { base: key.slice(0, at), lang: key.slice(at + 1) };
}

/**
 * Parse a stored blob into a prototype-less object so that merged keys can never
 * touch inherited properties. An empty column is an empty block; a non-empty
 * value that is not a JSON object is reported as unparseable so callers can
 * refuse to overwrite it instead of silently dropping data.
 */
function parseSectionRaw(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return Object.create(null) as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** The same blob as text values, for the editor (never written back verbatim). */
function parseSection(raw: string): Record<string, string> | null {
  const parsed = parseSectionRaw(raw);
  if (parsed === null) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value ?? "");
  }
  return out;
}

/**
 * Meta columns: only what the payload sends is validated, so a legacy value that
 * predates these rules never blocks an unrelated save. Absent means “keep as is”.
 */
function metaValue(name: string, value: unknown, stored: string, maxLen: number): string {
  if (value == null) return stored;
  if (typeof value !== "string") throw AppError.badRequest(`${name} must be text.`);
  const text = value.trim();
  const reason = findMetaViolation(name, text, maxLen);
  if (reason) throw AppError.badRequest(`${reason}.`);
  return text;
}

/** Validate one incoming field against the rules for the kind of copy it is. */
function cleanField(field: string, value: unknown): string {
  if (!FIELD_KEY.test(field)) {
    throw AppError.badRequest(`Invalid field name: “${field}”.`);
  }
  const { base } = splitKey(field);
  if (RESERVED_KEYS.has(base.toLowerCase())) {
    throw AppError.badRequest(`Field “${field}” uses a reserved name.`);
  }
  if (typeof value !== "string") {
    throw AppError.badRequest(`Field “${field}” must be text.`);
  }
  const text = value.trim();
  const reason = findContentViolation(contentFieldKind(base), text);
  if (reason) throw AppError.badRequest(`Field “${field}” ${reason}.`);
  return text;
}

async function mustFind(scope: ContentAppScope, id: number): Promise<ContentRow> {
  const row = await model.findContentRow(scope, id);
  if (!row) {
    throw AppError.notFound(`No ${scope.app} service content row #${id}.`);
  }
  return row;
}

export interface ServiceContentSummaryDto {
  id: number;
  vehicleCategoryId: number;
  categoryName: string | null;
  metaTitle: string;
  sectionsFilled: number;
  sectionsTotal: number;
  status: ContentStatus;
}

function toSummaryDto(row: ContentSummaryRow, scope: ContentAppScope): ServiceContentSummaryDto {
  return { ...row, sectionsTotal: scope.sections.length };
}

export interface ServiceContentSectionDto {
  key: string;
  label: string;
  /** Raw `<field>_<LANG>` map exactly as stored. */
  values: Record<string, string>;
  /** True when the blob is not JSON — the editor must not overwrite it. */
  unparsed: boolean;
}

export interface ServiceContentDto {
  id: number;
  eFor: string;
  vehicleCategoryId: number;
  categoryName: string | null;
  status: ContentStatus;
  meta: { title: string; keyword: string; description: string };
  /** Language codes that have at least one text, in a stable order. */
  languages: { code: string; label: string }[];
  sections: ServiceContentSectionDto[];
}

function toDto(row: ContentRow, scope: ContentAppScope): ServiceContentDto {
  const sections: ServiceContentSectionDto[] = scope.sections.map((s) => {
    const values = parseSection(row.sections[s.key] ?? "");
    return { key: s.key, label: s.label, values: values ?? {}, unparsed: values === null };
  });

  const present = new Set<string>();
  for (const section of sections) {
    for (const key of Object.keys(section.values)) {
      const { lang } = splitKey(key);
      if (lang) present.add(lang);
    }
  }
  const known = TRANSLATION_LANGUAGES.filter((l) => present.has(l.code)).map((l) => ({
    code: l.code as string,
    label: l.label,
  }));
  const knownCodes = new Set(known.map((l) => l.code));
  const extras = [...present]
    .filter((code) => !knownCodes.has(code))
    .sort()
    .map((code) => ({ code, label: code }));

  return {
    id: row.id,
    eFor: row.eFor,
    vehicleCategoryId: row.vehicleCategoryId,
    categoryName: row.categoryName,
    status: row.status,
    meta: { title: row.metaTitle, keyword: row.metaKeyword, description: row.metaDescription },
    languages: [...known, ...extras],
    sections,
  };
}

export async function listContent(scope: ContentAppScope): Promise<ServiceContentSummaryDto[]> {
  const rows = await model.listContentRows(scope);
  return rows.map((row) => toSummaryDto(row, scope));
}

export async function getContent(
  scope: ContentAppScope,
  id: number,
): Promise<ServiceContentDto> {
  return toDto(await mustFind(scope, id), scope);
}

/**
 * Merge a save. `sections` carries only the fields the editor changed, keyed by
 * section then by the full `<field>_<LANG>` key; `meta` carries any of the three
 * SEO columns. Everything absent from the payload is left untouched.
 */
export async function updateContent(
  scope: ContentAppScope,
  id: number,
  input: {
    meta?: { title?: unknown; keyword?: unknown; description?: unknown };
    sections?: Record<string, Record<string, unknown>>;
  },
): Promise<ServiceContentDto> {
  const row = await mustFind(scope, id);

  // Validate the whole payload first: the legacy table is MyISAM (no
  // transactions), so a rejected field must not leave half a save behind.
  const meta = input.meta
    ? {
        title: metaValue("Meta title", input.meta.title, row.metaTitle, MAX_META_TITLE_LEN),
        keyword: metaValue(
          "Meta keywords",
          input.meta.keyword,
          row.metaKeyword,
          MAX_META_TEXT_LEN,
        ),
        description: metaValue(
          "Meta description",
          input.meta.description,
          row.metaDescription,
          MAX_META_TEXT_LEN,
        ),
      }
    : null;

  const pending: { column: string; raw: string }[] = [];
  for (const [sectionKey, fields] of Object.entries(input.sections ?? {})) {
    const column = sectionColumn(scope, sectionKey);
    if (!column) {
      // Names this app never renders are refused here, not written: a delivery save
      // must not put copy in a column only the taxi screens read.
      throw AppError.badRequest(`Section “${sectionKey}” is not editable for ${scope.app}.`);
    }

    const stored = parseSectionRaw(row.sections[sectionKey] ?? "");
    if (stored === null) {
      throw AppError.badRequest(
        `Section “${sectionKey}” is not valid JSON, so it cannot be edited here.`,
      );
    }
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw AppError.badRequest(`Section “${sectionKey}” must be a map of field names to text.`);
    }

    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      const text = cleanField(field, value);
      const existing = field in stored ? stored[field] : undefined;
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
    if (Buffer.byteLength(raw, "utf8") > MAX_SECTION_BLOB_BYTES) {
      throw AppError.badRequest(
        `Section “${sectionKey}” would grow past ${MAX_SECTION_BLOB_BYTES} bytes.`,
      );
    }
    pending.push({ column, raw });
  }

  if (meta) await model.updateMeta(scope, id, meta);
  if (pending.length) await model.updateSections(scope, id, pending);

  return getContent(scope, id);
}

export async function changeStatus(
  scope: ContentAppScope,
  id: number,
  status: ContentStatus,
): Promise<ServiceContentDto> {
  const row = await mustFind(scope, id);
  if (row.status !== status) await model.setContentStatus(scope, id, status);
  return getContent(scope, id);
}
