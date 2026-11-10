import { AppError } from "../../../errors/AppError";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";
import { findContentViolation } from "../../../utils/contentSanitizer";
import { listLanguages } from "../../language/models/languageModel";
import * as model from "../models/subServiceCategoryModel";
import type {
  SubCategoryDetailRow,
  SubCategoryFilter,
  SubCategoryScope,
  SubCategoryStatus,
} from "../models/subServiceCategoryModel";

/**
 * Business rules for the Parcel Delivery sub-category screen (#sub-136, the legacy
 * "Sub Service Category (Parcel)" list). The screen reads a parent's children and offers
 * the legacy actions — activate, deactivate and soft-delete — plus a DRILL-DOWN:
 * pressing a row's "View" re-runs the same list for that row's own children. An EDIT
 * (gated by `update-service-category-parcel-delivery`) may rename the row in every
 * installed language and set its display order — the two fields a child row owns about
 * itself; artwork and the fare/settings columns belong to the master/taxi editors, not
 * here. There is no create (the legacy "Add Sub Category" button only ever appears for
 * ServiceProvider parents, and no create permission is seeded for this app anyway).
 *
 * Every request names the parent it is acting on (defaulting to the app's ROOT). Before
 * any read or write, {@link resolveParent} proves that parent is the root or a descendant
 * of it, so this delivery route can never list or edit another app's category tree.
 */

/** The languages the `vehicle_category` table pre-allocates a column for. */
const KNOWN_CODES = new Set<string>(TRANSLATION_LANGUAGES.map((l) => l.code));

/** What a bulk operation may name at most; no parent has anywhere near this many. */
const MAX_BULK_IDS = 200;

/** Cap for one translated name; matches the taxi category editor's name family. */
const NAME_MAX = 200;

/**
 * Column suffix used to show a name: the installed default language (what the legacy
 * list labels its Name column from), else English. Only ever a whitelisted code, so the
 * model can interpolate it as a column name safely.
 */
async function displayLanguageCode(): Promise<string> {
  const languages = await listLanguages();
  const fallback = "EN";
  const def =
    languages.find((l) => l.isDefault && l.status === "Active") ??
    languages.find((l) => l.isDefault) ??
    languages[0];
  const code = def?.code?.toUpperCase() ?? "";
  return KNOWN_CODES.has(code) ? code : fallback;
}

export interface SubCategoryDto {
  id: number;
  name: string;
  catType: string;
  status: SubCategoryStatus;
  displayOrder: number;
  /** Live children this row owns; drives the drill-down "View" link. */
  childCount: number;
  /** False when the row owns live service types, i.e. delete would be refused. */
  canDelete: boolean;
}

function toDto(row: model.SubCategoryRow): SubCategoryDto {
  return {
    id: row.id,
    name: row.name,
    catType: row.catType,
    status: row.status,
    displayOrder: row.displayOrder,
    childCount: row.childCount,
    canDelete: row.liveServiceTypes === 0,
  };
}

/** One language the edit form may write a name for. */
export interface SubCategoryLanguageOption {
  code: string;
  label: string;
  /** The default language's name is the one the list shows, so the form requires it. */
  required: boolean;
  direction: "rtl" | "ltr";
}

/** Detail shape for the edit page, plus the languages it exposes. */
export interface SubCategoryDetailDto {
  id: number;
  /** The level the detail was read at — the row's own parent, echoed for the edit link. */
  parentId: number;
  catType: string;
  status: SubCategoryStatus;
  displayOrder: number;
  childCount: number;
  canDelete: boolean;
  /** Editable languages in install order; `names` carries every one of these codes. */
  languages: SubCategoryLanguageOption[];
  names: Record<string, string>;
}

function toDetailDto(
  row: SubCategoryDetailRow,
  languages: SubCategoryLanguageOption[],
): SubCategoryDetailDto {
  return {
    id: row.id,
    parentId: row.parentId,
    catType: row.catType,
    status: row.status,
    displayOrder: row.displayOrder,
    childCount: row.childCount,
    canDelete: row.liveServiceTypes === 0,
    languages,
    names: row.names,
  };
}

/**
 * The languages the form edits: the installed ACTIVE ones that also own a
 * `vehicle_category` column (an active language without a column could never be
 * stored), ordered as the install lists them with the default first. The row's own
 * current display order decides nothing here — the editor list is the same for every row.
 */
async function editableLanguages(): Promise<SubCategoryLanguageOption[]> {
  const languages = await listLanguages();
  const active = languages.filter((l) => l.status === "Active" && KNOWN_CODES.has(l.code));
  const def =
    active.find((l) => l.isDefault && l.status === "Active") ??
    active.find((l) => l.isDefault) ??
    active.find((l) => l.code === "EN") ??
    active[0];
  const ordered = def ? [def, ...active.filter((l) => l.code !== def.code)] : active;
  return ordered.map((l) => ({
    code: l.code,
    label: l.titleEn || l.title || l.code,
    required: l.code === def?.code,
    direction: l.direction,
  }));
}

/**
 * Decide which parent a request acts on: the app root when none is named, otherwise the
 * named id — but ONLY when that id is the root or lives under it. A parent outside the
 * family is refused, never silently re-scoped.
 */
async function resolveParent(scope: SubCategoryScope, requested: unknown): Promise<number> {
  const blank = requested === undefined || requested === null || requested === "";
  const parentId = blank ? scope.rootCategoryId : Number(requested);
  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw AppError.badRequest("Invalid parent sub-category.");
  }
  if (!(await model.isInSubtree(scope.rootCategoryId, parentId))) {
    throw AppError.forbidden(`Sub-category #${parentId} is outside the ${scope.label} category family.`);
  }
  return parentId;
}

/** Normalise a posted id list: integers, de-duplicated, bounded, non-empty. */
function cleanIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || !ids.length) {
    throw AppError.badRequest("Select at least one sub-category.");
  }
  const out: number[] = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw AppError.badRequest(`Invalid sub-category id: “${String(raw)}”.`);
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_BULK_IDS) {
    throw AppError.badRequest(`A single action may touch at most ${MAX_BULK_IDS} sub-categories.`);
  }
  return out;
}

export async function listSubCategories(
  scope: SubCategoryScope,
  requestedParent: unknown,
  filter: SubCategoryFilter,
): Promise<SubCategoryDto[]> {
  const parentId = await resolveParent(scope, requestedParent);
  const lang = await displayLanguageCode();
  const rows = await model.listSubCategories(parentId, lang, filter);
  return rows.map(toDto);
}

/**
 * Activate / deactivate one child of the resolved parent, then return its refreshed row.
 * The status enum is enforced at the route; here we only confirm the row is a live child
 * of this parent.
 */
export async function changeStatus(
  scope: SubCategoryScope,
  requestedParent: unknown,
  id: number,
  status: SubCategoryStatus,
): Promise<SubCategoryDto> {
  const parentId = await resolveParent(scope, requestedParent);
  const lang = await displayLanguageCode();
  const row = await model.findSubCategory(parentId, id, lang);
  if (!row) {
    throw AppError.notFound(`No ${scope.label} sub-category #${id} under #${parentId}.`);
  }
  if (row.status !== status) await model.setStatus(parentId, id, status);
  const fresh = await model.findSubCategory(parentId, id, lang);
  if (!fresh) throw AppError.notFound(`No ${scope.label} sub-category #${id} under #${parentId}.`);
  return toDto(fresh);
}

/**
 * Soft-delete children of the resolved parent. Refuses the WHOLE request when any named
 * row still owns live `vehicle_type` rows — the legacy panel blocks the same way ("delete
 * the service types first"), and MyISAM has no transaction to half-apply safely.
 */
export async function deleteSubCategories(
  scope: SubCategoryScope,
  requestedParent: unknown,
  ids: unknown,
): Promise<{ requested: number; deleted: number }> {
  const parentId = await resolveParent(scope, requestedParent);
  const targets = cleanIds(ids);
  const blocked = await model.blockedByServiceTypes(parentId, targets);
  if (blocked.length) {
    throw AppError.badRequest(
      `Sub-category ${blocked.join(", ")} still has service types, so it cannot be deleted. Delete its service types first.`,
    );
  }
  const deleted = await model.softDelete(parentId, targets);
  return { requested: targets.length, deleted };
}

/** Bulk activate / deactivate, scoped to the resolved parent. */
export async function changeStatusMany(
  scope: SubCategoryScope,
  requestedParent: unknown,
  ids: unknown,
  status: SubCategoryStatus,
): Promise<{ requested: number }> {
  const parentId = await resolveParent(scope, requestedParent);
  const targets = cleanIds(ids);
  await model.setStatusMany(parentId, targets, status);
  return { requested: targets.length };
}

/**
 * Open the edit form for one live child: its stored names for every editable language,
 * the current display order, and the level it was read at. A row that is not a live child
 * of the named level is only accepted after a second look — the dedicated edit page can be
 * opened by id alone (deep link / refresh, no `?parent=`), so when the level asks for the
 * app root and the row turns out to be a deeper descendant, its OWN parent is re-resolved
 * through the same subtree check and used for the read. Anything outside the family is
 * still a 404, so the form can never be primed with another app's row.
 */
export async function getSubCategory(
  scope: SubCategoryScope,
  requestedParent: unknown,
  id: number,
): Promise<SubCategoryDetailDto> {
  let parentId = await resolveParent(scope, requestedParent);
  const languages = await editableLanguages();
  const codes = languages.map((l) => l.code);
  let row = await model.findSubCategoryDetail(parentId, id, codes);
  if (!row && parentId === scope.rootCategoryId) {
    const own = await model.findOwnParent(id);
    if (own && own !== parentId && (await model.isInSubtree(scope.rootCategoryId, own))) {
      parentId = own;
      row = await model.findSubCategoryDetail(parentId, id, codes);
    }
  }
  if (!row) {
    throw AppError.notFound(`No ${scope.label} sub-category #${id} under #${parentId}.`);
  }
  return toDetailDto(row, languages);
}

/**
 * Rename a child and/or change its display order. Only the codes the form was given
 * may be written (an active installed language), each value is plain text bounded to
 * {@link NAME_MAX}, and the DEFAULT language's name must stay non-empty — that column is
 * what the list and the mobile apps label the row with, so blanking it would leave an
 * unnamed category (the mirror-label defect the vehicle-type editor guards against). The
 * write is a single parent-scoped UPDATE, so it either fully applies to this level's row
 * or matches nothing.
 */
export async function updateSubCategory(
  scope: SubCategoryScope,
  requestedParent: unknown,
  id: number,
  input: { names?: unknown; displayOrder?: unknown },
): Promise<SubCategoryDto> {
  const parentId = await resolveParent(scope, requestedParent);
  const lang = await displayLanguageCode();
  const existing = await model.findSubCategory(parentId, id, lang);
  if (!existing) {
    throw AppError.notFound(`No ${scope.label} sub-category #${id} under #${parentId}.`);
  }

  const editable = await editableLanguages();
  const byCode = new Map(editable.map((l) => [l.code, l]));
  const names = input.names;
  // An order-only save sends no names at all — that is a legitimate "rename nothing",
  // not a malformed body; anything that IS present must still be a plain map.
  if (names !== undefined && names !== null && (typeof names !== "object" || Array.isArray(names))) {
    throw AppError.badRequest("names must be a map of language code to text.");
  }

  const sets: { column: string; value: string | number }[] = [];
  for (const [code, raw] of Object.entries((names ?? {}) as Record<string, unknown>)) {
    const option = byCode.get(code);
    if (!option) {
      throw AppError.badRequest(`Unknown or non-editable language: “${code}”.`);
    }
    if (typeof raw !== "string") {
      throw AppError.badRequest(`Name (${code}) must be text.`);
    }
    const text = raw.trim();
    if (option.required && !text) {
      throw AppError.badRequest(
        `Name (${option.label}) is required — a sub-category cannot be left unnamed.`,
      );
    }
    if (text.length > NAME_MAX) {
      throw AppError.badRequest(`Name (${code}) must be at most ${NAME_MAX} characters.`);
    }
    const reason = findContentViolation("text", text);
    if (reason) throw AppError.badRequest(`Name (${code}) ${reason}.`);
    sets.push({ column: `vCategory_${code}`, value: text });
  }

  if (input.displayOrder !== undefined) {
    const order = Number(input.displayOrder);
    if (!Number.isInteger(order) || order < 0 || order > 9_999) {
      throw AppError.badRequest("Display order must be a whole number between 0 and 9999.");
    }
    sets.push({ column: "iDisplayOrder", value: order });
  }

  if (sets.length) await model.updateChild(parentId, id, sets);
  const fresh = await model.findSubCategory(parentId, id, lang);
  if (!fresh) {
    throw AppError.notFound(`No ${scope.label} sub-category #${id} under #${parentId}.`);
  }
  return toDto(fresh);
}
