import { AppError } from "../../../errors/AppError";
import { findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/bannerModel";
import {
  ALL_LOCATIONS,
  BANNER_LANGUAGES,
  BANNER_LANGUAGE_CODES,
  PRIMARY_LANGUAGE,
} from "../models/bannerModel";
import type {
  BannerAppScope,
  BannerGroup,
  BannerLabel,
  BannerStatus,
} from "../models/bannerModel";

/**
 * Business rules for the `banners` table, which more than one app shares: Parcel
 * Delivery → Banners (display group 32, #sub-140), Delivery Genie → Banners (display
 * group 33, #sub-142) and Delivery Runner → Banners (display group 34, #sub-143). Every
 * entry point takes the caller's `BannerAppScope` and passes it straight to the model,
 * so a rule written once serves every slice without one reaching another's rows.
 *
 * The unit being managed is a **group**: `banners` keeps one row per language
 * (`vCode`) under a shared `iUniqueId`, all of them pointing at the same picture. So
 * every write here is a fan-out — a title change rewrites the rows of that one
 * language, while the slot, the colour, the status and the picture rewrite the whole
 * group, because the legacy apps read them off whichever row the user's language
 * picks and a banner that is Active in Arabic and Inactive in English is a bug, not a
 * state.
 *
 * A save still only writes the languages it was given, exactly like the 26-column
 * catalogs: the editor shows one language at a time, and a form that rewrote all 26
 * would blank the translations it never loaded. Where a group has no row for a
 * language at all, the save adds one — that is what the legacy translate pass did,
 * and it is the only way a half-translated banner can ever be finished from here.
 *
 * Deletes are hard: `eStatus` has no `Deleted` member, and nothing outside this table
 * names a banner, so there is no history to protect — which is also why the endpoint
 * asks for the banner's own title back before removing 26 rows at once.
 */

/** One language of a banner, as the editor sees it. */
export interface BannerLanguageField {
  code: string;
  label: string;
  text: string;
}

/** The whole banner, for the edit form. */
export interface BannerDto {
  /** `iUniqueId` — what the apps and the URL call the banner. */
  id: number;
  status: BannerStatus;
  /** English title, or the first language that says anything; what the list shows. */
  title: string;
  /** Stored file name; empty when the banner was created and never illustrated. */
  image: string;
  hasImage: boolean;
  displayOrder: number;
  statusBarColor: string;
  /** `iLocationid` as stored. '-1' is every location, which is every shipped row. */
  locationIds: string;
  languages: BannerLanguageField[];
  /** How many languages carry a title. */
  translationsFilled: number;
  /** How many language rows the group holds. */
  languageCount: number;
  /** Raw row count — above `languageCount` where the legacy data duplicated a code. */
  rowCount: number;
  maxTitleLength: number;
}

/** A row of the listing. */
export interface BannerListItem {
  id: number;
  title: string;
  image: string;
  hasImage: boolean;
  status: BannerStatus;
  displayOrder: number;
  statusBarColor: string;
  translationsFilled: number;
  languageCount: number;
  rowCount: number;
}

/** What may be sent when adding a banner. */
export interface BannerCreate {
  texts?: Record<string, unknown>;
  displayOrder?: unknown;
  statusBarColor?: unknown;
  status?: unknown;
}

/** What may be sent when editing one. Only the supplied parts are written. */
export interface BannerUpdate {
  texts?: Record<string, unknown>;
  displayOrder?: unknown;
  statusBarColor?: unknown;
}

/** `vTitle` is varchar(100) — a caption under a picture, not a paragraph. */
const TITLE_MAX = 100;

/** The colour column is varchar(10): '#RRGGBB', or blank for the app's own default. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Group status: Inactive the moment one of its language rows is switched off. */
function groupStatus(rows: { status: BannerStatus }[]): BannerStatus {
  return rows.some((r) => r.status === "Inactive") ? "Inactive" : "Active";
}

/**
 * The title a banner is known by. English wins; otherwise the first language that
 * says anything, in the order the rows were read, and the model always reads them by
 * row id. The shipped Runner banner has no English row at all, so this fallback is what
 * names it — and both the list and the detail view must reach the same answer, because
 * a heading that read "Dostavni tekač" over a row the list called "Piegādes skrējējs"
 * would leave the admin typing the wrong phrase into the delete confirmation.
 */
function resolveLabel(rows: { code: string; title: string }[], id: number): string {
  const english = rows.find((r) => r.code === PRIMARY_LANGUAGE && r.title.trim() !== "");
  if (english) return english.title.trim();
  const anyText = rows.find((r) => r.title.trim() !== "");
  return anyText ? anyText.title.trim() : `Banner #${id}`;
}

function textsOf(group: BannerGroup): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of BANNER_LANGUAGE_CODES) {
    // A duplicated legacy code keeps the first row's text, which is what the apps
    // have been reading; the duplicate is left alone rather than silently merged.
    const row = group.rows.find((r) => r.code === code);
    out[code] = row ? row.title : "";
  }
  return out;
}

async function toDto(group: BannerGroup): Promise<BannerDto> {
  const texts = textsOf(group);
  // Labelled from the group's own rows, in the order the model read them, exactly as
  // `toListItem` labels the same banner from its rows: two views of one group that
  // disagree about its name would be a bug the admin has to work around on delete.
  const title = resolveLabel(group.rows, group.id);
  return {
    id: group.id,
    status: groupStatus(group.rows),
    title,
    image: group.template.image,
    hasImage: group.template.image !== "",
    displayOrder: group.template.displayOrder,
    statusBarColor: group.template.statusBarColor,
    locationIds: group.template.locationIds,
    languages: BANNER_LANGUAGES.map((l) => ({
      code: l.code,
      label: l.label,
      text: texts[l.code],
    })),
    translationsFilled: BANNER_LANGUAGE_CODES.filter((c) => texts[c].trim() !== "").length,
    languageCount: new Set(group.rows.map((r) => r.code)).size,
    rowCount: group.rows.length,
    maxTitleLength: TITLE_MAX,
  };
}

function toListItem(
  summary: model.BannerGroupSummary,
  labels: BannerLabel[],
): BannerListItem {
  const own = labels.filter((l) => l.groupId === summary.id);
  // The aggregate already counted the languages holding text; the label needs the
  // rows themselves, so the two are read from the same page of ids.
  const title = resolveLabel(own, summary.id);
  return {
    id: summary.id,
    title,
    image: summary.image,
    hasImage: summary.image !== "",
    status: summary.inactiveCount > 0 ? "Inactive" : "Active",
    displayOrder: summary.displayOrder,
    statusBarColor: summary.statusBarColor,
    translationsFilled: summary.filledCount,
    languageCount: summary.languageCount,
    rowCount: summary.rowCount,
  };
}

/** Validate the supplied language map; unknown codes are refused, not ignored. */
function readTexts(input: Record<string, unknown> | undefined, required: boolean): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (required && entries.length === 0) {
    throw AppError.badRequest("Send at least the English title of the banner.");
  }
  // Tested before the loop: a create that omits English entirely would otherwise
  // store a group of 26 rows the listing can only name by id.
  if (required && asText(input?.[PRIMARY_LANGUAGE]).trim() === "") {
    throw AppError.badRequest("The English banner title cannot be empty.");
  }

  const changes: Record<string, string> = {};
  for (const [code, raw] of entries) {
    if (!BANNER_LANGUAGE_CODES.includes(code)) {
      throw AppError.badRequest(`Unknown language: “${code}”.`);
    }
    const text = asText(raw).trim();
    if (text.length > TITLE_MAX) {
      throw AppError.badRequest(
        `A banner title must be at most ${TITLE_MAX} characters (got ${text.length}).`,
      );
    }
    const violation = findContentViolation("text", text);
    if (violation) throw AppError.badRequest(`The ${code} banner title ${violation}.`);
    changes[code] = text;
  }
  return changes;
}

function readStatus(value: unknown): BannerStatus {
  if (value === undefined) return "Active";
  if (value !== "Active" && value !== "Inactive") {
    throw AppError.badRequest("Status must be Active or Inactive.");
  }
  return value;
}

/** Slot within the app. Omitted means "keep what the row has" / "append" on create. */
function readDisplayOrder(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw AppError.badRequest("Display order must be a whole number between 0 and 9999.");
  }
  return n;
}

/** Status-bar colour the app paints behind the banner. Blank means its own default. */
function readColor(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const color = asText(value).trim();
  if (color === "") return "";
  if (!HEX_COLOR.test(color)) {
    throw AppError.badRequest("Status-bar colour must be a #RRGGBB hex value, or blank.");
  }
  return color;
}

/** The whole live slice, newest slot first. */
export async function listBanners(scope: BannerAppScope): Promise<BannerListItem[]> {
  const summaries = await model.listGroupPage(scope, {
    search: "",
    limit: 1000,
    offset: 0,
  });
  const labels = await model.labelsForGroups(scope, summaries.map((s) => s.id));
  return summaries.map((s) => toListItem(s, labels));
}

/** Rows per page ceiling; the table is small, but the pager bounds it. */
const MAX_LIMIT = 200;

export interface BannerPage {
  rows: BannerListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One filtered page of banner groups, with the totals the pager needs. */
export async function listBannersPaged(
  scope: BannerAppScope,
  raw: {
    search?: unknown;
    status?: unknown;
    page?: unknown;
    limit?: unknown;
  },
): Promise<BannerPage> {
  const search = asText(raw.search).trim();
  const status = raw.status === "Active" || raw.status === "Inactive" ? (raw.status as BannerStatus) : undefined;
  const page = Math.max(Math.trunc(Number(raw.page ?? 1)) || 1, 1);
  const limit = Math.min(Math.max(Math.trunc(Number(raw.limit ?? 50)) || 50, 1), MAX_LIMIT);

  const filters = { search, status };
  const [total, summaries] = await Promise.all([
    model.countGroups(scope, filters),
    model.listGroupPage(scope, { ...filters, limit, offset: (page - 1) * limit }),
  ]);
  const labels = await model.labelsForGroups(scope, summaries.map((s) => s.id));
  return {
    rows: summaries.map((s) => toListItem(s, labels)),
    total,
    page,
    limit,
    pages: Math.max(Math.ceil(total / limit), 1),
  };
}

/** One banner with every language row. */
export async function getBanner(scope: BannerAppScope, id: number): Promise<BannerDto> {
  const group = await model.findGroup(scope, id);
  if (!group) throw AppError.notFound(`No banner #${id}.`);
  return toDto(group);
}

/** What the add form starts from: the next free slot and the language list. */
export async function blankRecord(scope: BannerAppScope): Promise<BannerDto> {
  const displayOrder = await model.nextDisplayOrder(scope);
  const texts: Record<string, string> = {};
  for (const code of BANNER_LANGUAGE_CODES) texts[code] = "";
  return {
    id: 0,
    status: "Active",
    title: "",
    image: "",
    hasImage: false,
    displayOrder,
    statusBarColor: "",
    locationIds: ALL_LOCATIONS,
    languages: BANNER_LANGUAGES.map((l) => ({ code: l.code, label: l.label, text: texts[l.code] })),
    translationsFilled: 0,
    languageCount: 0,
    rowCount: 0,
    maxTitleLength: TITLE_MAX,
  };
}

/**
 * Add a banner: one row per language, all sharing the new group id, the picture slot
 * and the colour. Languages the editor left blank are stored blank — a third of the
 * shipped rows are, so the app already knows how to show an image with no caption.
 */
export async function createBanner(scope: BannerAppScope, input: BannerCreate): Promise<BannerDto> {
  const changes = readTexts(input.texts, true);
  const status = readStatus(input.status);
  const displayOrder = readDisplayOrder(input.displayOrder, await model.nextDisplayOrder(scope));
  const statusBarColor = readColor(input.statusBarColor, "");

  const groupId = await model.nextGroupId();
  const rowIds = await model.nextRowIds(BANNER_LANGUAGE_CODES.length);
  const rows: model.NewBannerRow[] = BANNER_LANGUAGE_CODES.map((code, i) => ({
    rowId: rowIds[i],
    code,
    title: changes[code] ?? "",
    status,
  }));

  await model.insertBanner(
    scope,
    groupId,
    rows,
    {
      image: "",
      displayOrder,
      statusBarColor,
      locationIds: ALL_LOCATIONS,
      serviceId: 0,
      buyAnyService: "",
      forApp: "General",
      vehicleCategoryId: 0,
      masterServiceCategoryId: 0,
    },
  );

  const group = await model.findGroup(scope, groupId);
  if (!group) throw AppError.notFound("The new banner could not be read back.");
  return toDto(group);
}

/**
 * Edit a banner. Titles are written per language, the slot and the colour for the
 * whole group, and a language with no row yet gets one added to the group rather than
 * being silently dropped — that is the only way a partially translated banner (the
 * shipped Runner one has two languages of twenty-six) can be completed here.
 */
export async function updateBanner(
  scope: BannerAppScope,
  id: number,
  input: BannerUpdate,
): Promise<BannerDto> {
  const group = await model.findGroup(scope, id);
  if (!group) throw AppError.notFound(`No banner #${id}.`);

  const changes = readTexts(input.texts, false);
  const present = new Set(group.rows.map((r) => r.code));
  const status = groupStatus(group.rows);

  const displayOrder =
    input.displayOrder === undefined
      ? undefined
      : readDisplayOrder(input.displayOrder, group.template.displayOrder);
  const statusBarColor =
    input.statusBarColor === undefined
      ? undefined
      : readColor(input.statusBarColor, group.template.statusBarColor);

  const added = Object.keys(changes).filter((code) => !present.has(code));
  const touched = Object.keys(changes).length > 0;
  const groupEdit =
    (displayOrder !== undefined && displayOrder !== group.template.displayOrder) ||
    (statusBarColor !== undefined && statusBarColor !== group.template.statusBarColor);

  if (!touched && !groupEdit) {
    throw AppError.badRequest("Send the languages that changed, the display order or the colour.");
  }

  for (const [code, title] of Object.entries(changes)) {
    if (present.has(code)) await model.updateTitle(scope, id, code, title);
  }
  if (added.length) {
    const rowIds = await model.nextRowIds(added.length);
    await model.insertBanner(
      scope,
      id,
      added.map((code, i) => ({ rowId: rowIds[i], code, title: changes[code], status })),
      group.template,
    );
  }
  if (groupEdit) {
    await model.updateGroupFields(scope, id, {
      ...(displayOrder !== undefined ? { displayOrder } : {}),
      ...(statusBarColor !== undefined ? { statusBarColor } : {}),
    });
  }

  const after = await model.findGroup(scope, id);
  if (!after) throw AppError.notFound(`No banner #${id}.`);
  return toDto(after);
}

/** Activate / deactivate the whole group. */
export async function changeStatus(
  scope: BannerAppScope,
  id: number,
  status: BannerStatus,
): Promise<BannerDto> {
  const group = await model.findGroup(scope, id);
  if (!group) throw AppError.notFound(`No banner #${id}.`);
  const next = readStatus(status);
  if (groupStatus(group.rows) !== next) await model.setGroupStatus(scope, id, next);
  return getBanner(scope, id);
}

/** Picture the group currently names, for the upload path to clean up afterwards. */
export async function getImageFilename(scope: BannerAppScope, id: number): Promise<string> {
  const group = await model.findGroup(scope, id);
  if (!group) throw AppError.notFound(`No banner #${id}.`);
  return group.template.image;
}

export interface ImageAttachResult {
  banner: BannerDto;
  /** The file this banner used before, if it named one. */
  previousImage: string;
  /** True when other rows still name the old file, so it must stay on disk. */
  previousStillReferenced: boolean;
}

/**
 * Point every row of the group at a new picture. The old one is left for the caller
 * to remove, and only when nothing else has claimed it — the legacy data reuses one
 * image across several banners.
 */
export async function attachImage(
  scope: BannerAppScope,
  id: number,
  filename: string,
): Promise<ImageAttachResult> {
  const previous = await getImageFilename(scope, id);
  await model.updateImage(scope, id, filename);
  const stillReferenced = previous !== "" && previous !== filename
    ? (await model.countImageRefs(previous)) > 0
    : false;
  return { banner: await getBanner(scope, id), previousImage: previous, previousStillReferenced: stillReferenced };
}

export interface DeleteResult {
  title: string;
  /** Rows the DELETE removed — normally the 26 languages of the group. */
  rowsRemoved: number;
  image: string;
  /** True when other banners still name the same picture. */
  imageStillReferenced: boolean;
}

/** Name-confirmed hard delete of the whole group. */
export async function deleteBanner(
  scope: BannerAppScope,
  id: number,
  confirm: unknown,
): Promise<DeleteResult> {
  const group = await model.findGroup(scope, id);
  if (!group) throw AppError.notFound(`No banner #${id}.`);

  const title = resolveLabel(group.rows, id);
  const typed = asText(confirm).trim();
  if (!typed || typed !== title) {
    throw AppError.badRequest(`Type “${title}” exactly to delete this banner.`);
  }

  const image = group.template.image;
  const imageStillReferenced =
    image !== "" && (await model.countImageRefsOutsideGroup(scope, image, id)) > 0;
  const rowsRemoved = await model.deleteGroup(scope, id);
  return { title, rowsRemoved, image, imageStillReferenced };
}
