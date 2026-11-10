import { AppError } from "../../../errors/AppError";
import { contentFieldLimit, findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/tripReasonModel";
import {
  PRIMARY_LANGUAGE,
  REASON_LANGUAGES,
  REASON_LANGUAGE_CODES,
} from "../models/tripReasonModel";
import type { ProfileOption, ReasonRow, ReasonStatus, ReasonSummaryRow } from "../models/tripReasonModel";

/**
 * Business rules for trip reasons (group 7 → Manage Ride Profiles → #sub-17-p96).
 *
 * The one column that carries copy, `vReasonTitle`, is a JSON object of 26
 * `<column>_<LANG>` keys, so this service:
 *
 * - validates only what the editor changed, and merges it over the stored object —
 *   a save from this screen can never blank a language it does not show;
 * - requires the primary language (English) to be non-empty on create, because
 *   rows with no readable name are invisible in the listing and unusable in the app;
 * - treats a legacy value that is not JSON at all as the English text, so the
 *   handful of plain-text rows the old panel wrote stay editable.
 *
 * Rows are soft-deleted only: `trips`, `cab_booking` and `cab_request_now` store
 * `iTripReasonId`, and there are no foreign keys to catch a stray id.
 */

/** One language of a reason, as the editor sees it. */
export interface ReasonLanguageField {
  code: string;
  label: string;
  text: string;
}

/** A reason with every stored language, for the edit form. */
export interface TripReasonDto {
  id: number;
  status: ReasonStatus;
  /** Primary-language text; what the listing and delete confirmation show. */
  title: string;
  profileId: number;
  /** Label of the profile the reason is filed under, or an empty string. */
  profileName: string;
  /** How many of the 26 languages carry text. */
  translationsFilled: number;
  /** Every language, in the order the form lists them. */
  languages: ReasonLanguageField[];
  /** Blob keys that belong to no known language, reported but never written. */
  extraKeys: string[];
  /** Longest text a single language may hold. */
  maxTextLength: number;
}

/** A row of the listing. */
export type TripReasonListItem = ReasonSummaryRow;

/** A language tab of the form. */
export interface ReasonLanguageOption {
  code: string;
  label: string;
}

/** What may be sent when adding a reason. */
export interface TripReasonCreate {
  texts?: Record<string, unknown>;
  profileId?: unknown;
  status?: unknown;
}

/** What may be sent when editing one. Only supplied languages are merged. */
export interface TripReasonUpdate {
  texts?: Record<string, unknown>;
  profileId?: unknown;
}

/** A reason title is app-rendered plain copy, kept well under the column limit. */
const TITLE_MAX = 200;

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Validate one supplied language map and return the changes in blob order.
 * Unknown language codes are refused rather than ignored — a typo in a client
 * would otherwise look like a save that did nothing.
 */
function readTexts(input: Record<string, unknown> | undefined, required: boolean): {
  code: string;
  text: string;
}[] {
  const entries = Object.entries(input ?? {});
  if (required && entries.length === 0) {
    throw AppError.badRequest("Send at least the English text of the reason.");
  }
  // Tested before the loop, not inside it: a create that omits English entirely
  // would otherwise store a row the listing shows as a blank title.
  if (required && asText(input?.[PRIMARY_LANGUAGE]).trim() === "") {
    throw AppError.badRequest("The English reason title cannot be empty.");
  }
  const changes: { code: string; text: string }[] = [];
  for (const [code, raw] of entries) {
    if (!REASON_LANGUAGE_CODES.includes(code)) {
      throw AppError.badRequest(`Unknown language: “${code}”.`);
    }
    const text = asText(raw).trim();
    if (text.length > TITLE_MAX) {
      throw AppError.badRequest(
        `A reason title must be at most ${TITLE_MAX} characters (got ${text.length}).`,
      );
    }
    // Same write-boundary guard every other app-rendered copy column uses.
    const violation = findContentViolation("text", text);
    if (violation) {
      throw AppError.badRequest(`The ${code} reason title ${violation}.`);
    }
    changes.push({ code, text });
  }
  return changes;
}

function readStatus(value: unknown): ReasonStatus {
  if (value === undefined) return "Active";
  if (value !== "Active" && value !== "Inactive") {
    throw AppError.badRequest("Status must be Active or Inactive.");
  }
  return value;
}

/** Bound a profile id, and refuse one that does not exist (no foreign keys here). */
async function readProfileId(value: unknown, fallback: number | null): Promise<number> {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) {
      throw AppError.badRequest("There is no ride profile to file a reason under yet.");
    }
    return fallback;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("Invalid ride profile.");
  if (!(await model.profileExists(id))) throw AppError.badRequest("That ride profile does not exist.");
  return id;
}

/** The whole live list, oldest first. */
export async function listReasons(): Promise<TripReasonListItem[]> {
  return model.listReasonRows();
}

/** Rows per page ceiling; the legacy table is tiny, but the pager bounds it. */
const MAX_LIMIT = 200;

export interface TripReasonPage {
  rows: TripReasonListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One filtered page, with the totals the pager needs. */
export async function listReasonsPaged(raw: {
  search?: unknown;
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<TripReasonPage> {
  const search = asText(raw.search).trim();
  const status =
    raw.status === "Active" || raw.status === "Inactive" ? (raw.status as ReasonStatus) : undefined;
  const page = Math.max(Math.trunc(Number(raw.page ?? 1)) || 1, 1);
  const limit = Math.min(Math.max(Math.trunc(Number(raw.limit ?? 50)) || 50, 1), MAX_LIMIT);

  const total = await model.countReasons({ search, status });
  const rows = await model.listReasonPage({
    search,
    status,
    limit,
    offset: (page - 1) * limit,
  });
  return { rows, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
}

/** The ride profiles a reason can be filed under. */
export async function listProfileOptions(): Promise<ProfileOption[]> {
  return model.listProfileOptions();
}

/** One reason with every stored language. */
export async function getReason(id: number): Promise<TripReasonDto> {
  const row = await model.findReasonRow(id);
  if (!row) throw AppError.notFound(`No trip reason #${id}.`);
  return toDto(row);
}

async function toDto(row: ReasonRow): Promise<TripReasonDto> {
  const profileName = row.profileId > 0 ? await model.findProfileName(row.profileId) : "";
  return {
    id: row.id,
    status: row.status,
    title: row.texts[PRIMARY_LANGUAGE]?.trim() || firstText(row) || `Reason #${row.id}`,
    profileId: row.profileId,
    profileName,
    translationsFilled: REASON_LANGUAGE_CODES.filter((c) => row.texts[c].trim() !== "").length,
    languages: REASON_LANGUAGES.map((l) => ({ code: l.code, label: l.label, text: row.texts[l.code] })),
    extraKeys: row.extraKeys,
    maxTextLength: TITLE_MAX,
  };
}

/** English missing? Any translated text still names the row for the header. */
function firstText(row: { texts: Record<string, string> }): string {
  const found = REASON_LANGUAGE_CODES.map((c) => row.texts[c].trim()).find((t) => t !== "");
  return found ?? "";
}

/** A blank record: what the add form starts from, including the default profile. */
export async function blankRecord(): Promise<TripReasonDto> {
  const options = await listProfileOptions();
  const texts = Object.create(null) as Record<string, string>;
  for (const code of REASON_LANGUAGE_CODES) texts[code] = "";
  return toDto({
    id: 0,
    status: "Active" as ReasonStatus,
    profileId: options[0]?.id ?? 0,
    titleBlob: "",
    texts,
    extraKeys: [] as string[],
  });
}

/** Add a reason: the blob is built from scratch, every language the editor left blank stays blank. */
export async function createReason(input: TripReasonCreate): Promise<TripReasonDto> {
  const changes = readTexts(input.texts as Record<string, unknown> | undefined, true);
  const status = readStatus(input.status);
  const profileId = await readProfileId(input.profileId, await model.firstProfileId());

  const texts = Object.create(null) as Record<string, string>;
  for (const code of REASON_LANGUAGE_CODES) texts[code] = "";
  for (const { code, text } of changes) texts[code] = text;

  const id = await model.nextReasonId();
  await model.insertReason(id, profileId, model.blobForNewReason(texts), status);
  const row = await model.findReasonRow(id);
  if (!row) throw AppError.notFound("The new trip reason could not be read back.");
  return toDto(row);
}

/** Edit a reason: merge only the supplied languages over what is stored. */
export async function updateReason(id: number, input: TripReasonUpdate): Promise<TripReasonDto> {
  const row = await model.findReasonRow(id);
  if (!row) throw AppError.notFound(`No trip reason #${id}.`);

  const changes = readTexts(input.texts as Record<string, unknown> | undefined, false);
  const sets: { titleBlob?: string; profileId?: number } = {};

  if (changes.length) {
    sets.titleBlob = model.mergeReasonBlob(row.titleBlob, changes);
  }
  if (input.profileId !== undefined) {
    const profileId = await readProfileId(input.profileId, row.profileId);
    if (profileId !== row.profileId) sets.profileId = profileId;
  }
  if (!sets.titleBlob && sets.profileId === undefined) {
    throw AppError.badRequest("Send the languages that changed, or a new ride profile.");
  }

  await model.updateReason(id, sets);
  const after = await model.findReasonRow(id);
  if (!after) throw AppError.notFound(`No trip reason #${id}.`);
  return toDto(after);
}

/** Activate / deactivate: the apps stop offering an Inactive reason. */
export async function changeStatus(id: number, status: ReasonStatus): Promise<TripReasonDto> {
  const row = await model.findReasonRow(id);
  if (!row) throw AppError.notFound(`No trip reason #${id}.`);
  await model.setReasonStatus(id, readStatus(status));
  return getReason(id);
}

export interface DeleteResult {
  name: string;
  ongoingTrips: number;
  openBookings: number;
  openRequests: number;
  tripRecords: number;
}

/**
 * Name-confirmed soft delete. Live work referencing the reason is refused, because
 * hiding it would take the label off a trip the driver is still working.
 */
export async function deleteReason(id: number, confirm: unknown): Promise<DeleteResult> {
  const row = await model.findReasonRow(id);
  if (!row) throw AppError.notFound(`No trip reason #${id}.`);

  const name = row.texts[PRIMARY_LANGUAGE]?.trim() || firstText(row) || `Reason #${row.id}`;
  const typed = asText(confirm).trim();
  if (!typed || typed !== name) {
    throw AppError.badRequest(`Type “${name}” exactly to delete this reason.`);
  }

  const usage = await model.countReasonUsage(id);
  const live = usage.ongoingTrips + usage.openBookings + usage.openRequests;
  if (live > 0) {
    throw AppError.badRequest(
      `This reason is on ${live} live trip(s) or open booking(s); deactivate it instead of deleting it.`,
    );
  }

  await model.softDeleteReason(id);
  return { name, ...usage };
}

/** What the form and the route agree the language set is. */
export const REASON_FORM_LANGUAGES: ReasonLanguageOption[] = REASON_LANGUAGES.map((l) => ({
  code: l.code,
  label: l.label,
}));

/** Column limit the shared sanitizer would enforce, surfaced for docs and clients. */
export const REASON_TEXT_CEILING = contentFieldLimit("text");
