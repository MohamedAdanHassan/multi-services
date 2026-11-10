import { AppError } from "../../../errors/AppError";
import { findContentViolation } from "../../../utils/contentSanitizer";
import { listLanguages } from "../../language/models/languageModel";
import type { LanguageRow } from "../../language/models/languageModel";
import * as model from "../models/masterServiceCategoryModel";
import type {
  MasterCategoryRow,
  MasterCategoryScope,
  MasterCategoryStatus,
} from "../models/masterServiceCategoryModel";

/**
 * Business rules for the app master service category (Parcel Delivery → #sub-136).
 *
 * The pasted legacy form edits three things on one row: an icon, the category name in
 * every installed language, and the status switch. The name lives in one JSON blob
 * keyed `vCategoryName_<CODE>`, and the legacy panel rebuilt that whole blob from the
 * posted form on every save — a language whose input was not in the request was
 * written back empty. This service merges instead: the editor sends only the
 * languages it changed, and every other key of the stored blob is preserved.
 *
 * The status switch is the second divergence. Legacy handed a master row's switch to
 * the parent `vehicle_category` rows of the same app family and on to their linked
 * `service_categories`. This screen writes only its own row and reports what legacy
 * would also have flipped, so the difference is visible to the admin rather than
 * silently repeated or silently dropped.
 *
 * Everything is bound to a {@link MasterCategoryScope}: the `:app` segment of the route
 * decides which `eType` row may be read or written, and no payload can name another.
 */

/** `vCategoryName_XX` — the blob key suffix, i.e. a language code. */
const LANG_CODE = /^[A-Z]{1,10}$/;
/** Names that would write onto an inherited property of the parsed blob. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty"]);
/** The blob is text; a megabyte of category names is a mistake, not content. */
const MAX_BLOB_BYTES = 64_000;
/** varchar(500) in the legacy schema, far above the longest stored name (~40). */
const MAX_NAME_LEN = 500;

/** The blob key of one language code, as the legacy app spells it. */
function blobKey(code: string): string {
  return `vCategoryName_${code}`;
}

/**
 * Parse the stored blob without a prototype, so a key read back from it can never
 * resolve to an inherited property. A non-object (or unparseable) blob is reported as
 * null: the caller then refuses to overwrite it instead of dropping legacy data.
 */
function parseNameBlob(raw: string): Record<string, string> | null {
  const text = raw.trim();
  if (!text) return Object.create(null) as Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value == null) {
        out[key] = "";
      } else if (typeof value === "string") {
        out[key] = value;
      } else {
        // A structured value in a name column is legacy debris; keep the bytes.
        out[key] = JSON.stringify(value);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Codes carried by `vCategoryName_<CODE>` keys, in the order they appear. */
function codesOf(blob: Record<string, string>): string[] {
  const codes: string[] = [];
  for (const key of Object.keys(blob)) {
    const code = codeOfKey(key);
    if (code !== null && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function codeOfKey(key: string): string | null {
  if (!key.startsWith("vCategoryName_")) return null;
  const code = key.slice("vCategoryName_".length);
  return LANG_CODE.test(code) ? code : null;
}

export interface MasterCategoryLanguageDto {
  code: string;
  /** Native name, as the legacy label reads "Title (العربية)". */
  title: string;
  /** The row the app shows in its single-line field before the modal is opened. */
  isDefault: boolean;
  active: boolean;
  rtl: boolean;
}

export interface MasterCategorySummaryDto {
  id: number;
  eType: string;
  label: string;
  status: MasterCategoryStatus;
  icon: string;
  /** Default-language name, or the first non-empty one; empty when the blob is unreadable. */
  displayName: string;
  /** True when the stored blob is not JSON, so the editor must not overwrite it. */
  unparsed: boolean;
  /** How many languages currently carry a name. */
  namesFilled: number;
}

export interface MasterCategoryDto extends MasterCategorySummaryDto {
  /** Every installed language, default first — the modal's input list. */
  languages: MasterCategoryLanguageDto[];
  /** Stored name per language code, including codes no longer installed. */
  names: Record<string, string>;
  /** What a legacy toggle of this row would also have switched. Read-only. */
  linkedCategories: model.LinkedCategoryRow[];
}

/** Language rows, default first, then display order (legacy `getLangDataDefaultFirst`). */
function orderLanguages(rows: LanguageRow[]): LanguageRow[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return a.id - b.id;
  });
}

function toLanguageDto(row: LanguageRow): MasterCategoryLanguageDto {
  return {
    code: row.code,
    title: row.title || row.titleEn || row.code,
    isDefault: row.isDefault,
    active: row.status === "Active",
    rtl: row.direction === "rtl",
  };
}

/**
 * Best-display name of a row: the default language when it has one (what the legacy
 * list column shows), else the first language that carries text, so a row whose
 * default translation was never filled still has a readable name in the table.
 */
function displayNameOf(blob: Record<string, string> | null, defaultCode: string): string {
  if (!blob) return "";
  const direct = blob[blobKey(defaultCode)];
  if (direct !== undefined && direct.trim()) return direct.trim();
  for (const code of codesOf(blob)) {
    const value = blob[blobKey(code)];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function toSummaryDto(
  row: MasterCategoryRow,
  scope: MasterCategoryScope,
  defaultCode: string,
): MasterCategorySummaryDto {
  const blob = parseNameBlob(row.nameBlob);
  return {
    id: row.id,
    eType: row.eType,
    label: scope.label,
    status: row.status,
    icon: row.icon,
    displayName: displayNameOf(blob, defaultCode),
    unparsed: blob === null,
    namesFilled: blob ? codesOf(blob).filter((c) => (blob[blobKey(c)] ?? "").trim()).length : 0,
  };
}

async function mustFind(scope: MasterCategoryScope, id: number): Promise<MasterCategoryRow> {
  const row = await model.findCategoryRow(scope, id);
  if (!row) {
    throw AppError.notFound(`No ${scope.label} service category #${id}.`);
  }
  return row;
}

/** Validate one posted name. Names are plain text the apps paste into their markup. */
function cleanName(code: string, value: unknown, required: boolean): string {
  if (!LANG_CODE.test(code)) {
    throw AppError.badRequest(`Invalid language code: “${code}”.`);
  }
  if (RESERVED_KEYS.has(code.toLowerCase())) {
    throw AppError.badRequest(`Language “${code}” uses a reserved name.`);
  }
  if (typeof value !== "string") {
    throw AppError.badRequest(`Name for “${code}” must be text.`);
  }
  const text = value.trim();
  const reason = findContentViolation("text", text);
  if (reason) throw AppError.badRequest(`Name for “${code}” ${reason}.`);
  if (text.length > MAX_NAME_LEN) {
    throw AppError.badRequest(`Name for “${code}” must be at most ${MAX_NAME_LEN} characters.`);
  }
  if (required && !text) {
    throw AppError.badRequest(`Name for “${code}” is required: it is the default language.`);
  }
  return text;
}

export async function listCategories(
  scope: MasterCategoryScope,
): Promise<MasterCategorySummaryDto[]> {
  const [rows, languages] = await Promise.all([
    model.listCategoryRows(scope),
    listLanguages(),
  ]);
  const defaultCode = orderLanguages(languages).find((l) => l.isDefault)?.code ?? "EN";
  return rows.map((row) => toSummaryDto(row, scope, defaultCode));
}

export async function getCategory(
  scope: MasterCategoryScope,
  id: number,
): Promise<MasterCategoryDto> {
  const [row, languages, linkedCategories] = await Promise.all([
    mustFind(scope, id),
    listLanguages(),
    model.deliveryFamilyCategories(),
  ]);
  const ordered = orderLanguages(languages);
  const defaultCode = ordered.find((l) => l.isDefault)?.code ?? "EN";
  const blob = parseNameBlob(row.nameBlob);

  const names = Object.create(null) as Record<string, string>;
  // Installed languages first (the editor's rows), then any stored code the panel no
  // longer knows about, so nothing is hidden from the merge and nothing is dropped. An
  // unparseable blob yields empty rows plus the unparsed flag, and the editor offers no
  // name save rather than overwriting bytes it cannot read.
  if (blob) {
    for (const lang of ordered) names[lang.code] = blob[blobKey(lang.code)] ?? "";
    for (const code of codesOf(blob)) if (!(code in names)) names[code] = blob[blobKey(code)];
  }

  return {
    ...toSummaryDto(row, scope, defaultCode),
    languages: ordered.map(toLanguageDto),
    names,
    linkedCategories,
  };
}

/**
 * Merge a name save. `names` carries only the languages the editor changed, keyed by
 * bare language code; every other key of the stored blob is written back unchanged.
 */
export async function updateNames(
  scope: MasterCategoryScope,
  id: number,
  names: Record<string, unknown>,
): Promise<MasterCategoryDto> {
  const row = await mustFind(scope, id);
  const stored = parseNameBlob(row.nameBlob);
  if (stored === null) {
    throw AppError.badRequest(
      `The stored name of ${scope.label} service category #${id} is not valid JSON, so it cannot be edited here.`,
    );
  }

  const ordered = orderLanguages(await listLanguages());
  const defaultLang = ordered.find((l) => l.isDefault);
  const posted = Object.keys(names);
  if (!posted.length) {
    throw AppError.badRequest("Send at least the language names that changed.");
  }
  const knownCodes = new Set([...ordered.map((l) => l.code), ...codesOf(stored)]);
  if (posted.length > knownCodes.size) {
    throw AppError.badRequest(`A save may change at most ${knownCodes.size} languages.`);
  }

  // Validate the whole payload before touching the database: the legacy table is
  // MyISAM (no transactions), so a rejected code must not leave half a name behind.
  const clean = Object.create(null) as Record<string, string>;
  for (const [code, value] of Object.entries(names)) {
    // Only an installed language, or one the blob already carries, may be written: a
    // fresh code would grow the blob past anything the apps can read.
    if (!knownCodes.has(code)) {
      throw AppError.badRequest(`Language “${code}” is not installed, so it has no name here.`);
    }
    clean[code] = cleanName(code, value, !!defaultLang && code === defaultLang.code);
  }

  if (defaultLang && !(defaultLang.code in clean)) {
    // The legacy form makes the default input required, so a save that never mentions
    // it cannot be checked against that rule. Refuse rather than risk blanking it.
    const current = stored[blobKey(defaultLang.code)] ?? "";
    if (!current.trim()) {
      throw AppError.badRequest(
        `Name for “${defaultLang.code}” is required: it is the default language.`,
      );
    }
  }

  let changed = false;
  for (const [code, text] of Object.entries(clean)) {
    const key = blobKey(code);
    const existing = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
    if (existing === undefined && !text) continue;
    if (existing !== text) {
      stored[key] = text;
      changed = true;
    }
  }

  if (changed) {
    const raw = JSON.stringify(stored);
    if (Buffer.byteLength(raw, "utf8") > MAX_BLOB_BYTES) {
      throw AppError.badRequest(`The name would grow past ${MAX_BLOB_BYTES} bytes.`);
    }
    await model.updateNameBlob(scope, id, raw);
  }
  return getCategory(scope, id);
}

/**
 * Flip this row's switch only. `getCategory` reports the `vehicle_category` rows a
 * legacy toggle would have cascaded to, so the divergence is shown, not hidden.
 */
export async function changeStatus(
  scope: MasterCategoryScope,
  id: number,
  status: MasterCategoryStatus,
): Promise<MasterCategoryDto> {
  const row = await mustFind(scope, id);
  if (row.status !== status) await model.setCategoryStatus(scope, id, status);
  return getCategory(scope, id);
}

// ---------------------------------------------------------------------------
// Icon. One column (`vIconImage1`), one flat directory, a bare file name the apps
// concatenate into an image URL. Only the upload endpoint writes it: a name never
// arrives in a JSON payload, so nothing here accepts one.
// ---------------------------------------------------------------------------

/** Stored file name of one row, for the stream/upload endpoints. */
export async function getIconFilename(scope: MasterCategoryScope, id: number): Promise<string> {
  const row = await mustFind(scope, id);
  return row.icon;
}

/** Point the icon column at a file already written to disk, and return the fresh row. */
export async function setIconFilename(
  scope: MasterCategoryScope,
  id: number,
  filename: string,
): Promise<MasterCategoryDto> {
  await mustFind(scope, id);
  await model.updateIcon(scope, id, filename);
  return getCategory(scope, id);
}
