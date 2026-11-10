import { AppError } from "../../../errors/AppError";
import { findContentViolation } from "../../../utils/contentSanitizer";
import { mergeTranslationBlob, parseTranslationBlob } from "../../../utils/translatedBlob";
import * as model from "../models/rideProfileModel";
import {
  BLOB_BY_KEY,
  MEDIA_COLUMNS,
  PRIMARY_LANGUAGE,
  PROFILE_LANGUAGES,
  PROFILE_LANGUAGE_CODES,
  TEXT_BLOBS,
} from "../models/rideProfileModel";
import type { MediaSpec, ProfileStatus } from "../models/rideProfileModel";

/**
 * Business rules for ride profiles (group 7 → Manage Ride Profiles → #sub-17-p91).
 *
 * A profile is eight translated columns, so the service works in three steps for
 * every save: resolve the field key to its physical column, validate only the
 * languages the editor actually changed, then merge them over the stored JSON object
 * so the 26-key shape the apps read survives intact. Nothing is written until every
 * value has passed, and the write itself is one UPDATE — the table has no primary
 * key and three live tables point at its rows.
 *
 * Artwork columns hold a bare file name, exactly as the legacy panel wrote one: the
 * apps concatenate it into an image URL. A name can be corrected through the `files`
 * map of a save, and a new picture arrives through its own multipart endpoint (see
 * `getMediaFilename` / `setMediaFilename`), which writes into `backend/uploads` via
 * the media helpers and never into the read-only legacy directory.
 */

/** One language of one field, as the editor sees it. */
export interface ProfileLanguageField {
  code: string;
  label: string;
  text: string;
}

/** One translated column with all its languages. */
export interface ProfileFieldDto {
  key: string;
  column: string;
  label: string;
  kind: "text" | "html";
  max: number;
  multiline: boolean;
  /** How many of the languages carry text. */
  filled: number;
  languages: ProfileLanguageField[];
  /** Blob keys that belong to no known language, reported but never written. */
  extraKeys: string[];
}

/** One artwork column. */
export interface ProfileFileDto {
  key: string;
  column: string;
  label: string;
  value: string;
}

/** A profile as the form receives it. */
export interface RideProfileDto {
  id: number;
  status: ProfileStatus;
  /** Primary-language profile name; the listing and delete prompt show this. */
  name: string;
  shortName: string;
  languages: { code: string; label: string }[];
  fields: ProfileFieldDto[];
  files: ProfileFileDto[];
}

/** A listing row. */
export type RideProfileListItem = model.ProfileSummaryRow;

/** `{ profileName: { EN: "Business", AR: "…" } }` for the columns that changed. */
export interface ProfileTextChange {
  [fieldKey: string]: Record<string, unknown>;
}

export interface RideProfileCreate {
  texts?: unknown;
  files?: unknown;
  status?: unknown;
}

export interface RideProfileUpdate {
  texts?: unknown;
  files?: unknown;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readStatus(value: unknown): ProfileStatus {
  if (value === undefined) return "Active";
  if (value !== "Active" && value !== "Inactive") {
    throw AppError.badRequest("Status must be Active or Inactive.");
  }
  return value;
}

/** A bare file name, exactly as the legacy columns store it. */
function readFileName(value: unknown, label: string): string {
  const name = asText(value).trim();
  if (name.length > 255) throw AppError.badRequest(`${label} file name is too long.`);
  if (name && (name.includes("/") || name.includes("\\") || name.includes(".."))) {
    throw AppError.badRequest(`${label} must be a bare file name, not a path.`);
  }
  return name;
}

/**
 * Validate one `texts` group and resolve it to physical columns. Returns the column
 * → merged-blob plan; `existing` supplies the values a merge must preserve.
 */
function planTextChanges(
  input: unknown,
  existing: Record<string, string> | null,
  required: boolean,
): { column: string; value: string }[] {
  const groups = input as Record<string, Record<string, unknown>> | undefined;
  const keys = Object.keys(groups ?? {});
  if (!keys.length) {
    if (required) throw AppError.badRequest("Send the copy of the new profile.");
    return [];
  }
  const unknown = keys.find((k) => !Object.prototype.hasOwnProperty.call(BLOB_BY_KEY, k));
  if (unknown) throw AppError.badRequest(`Unknown text field: “${unknown}”.`);

  // Checked here rather than per field: a create that never names `profileName` at
  // all would otherwise sail through the loop and store a profile no app can label.
  if (required && !asText(groups?.["profileName"]?.[PRIMARY_LANGUAGE]).trim()) {
    throw AppError.badRequest("A new profile needs an English profile name.");
  }

  const plan: { column: string; value: string }[] = [];
  for (const key of keys) {
    const spec = BLOB_BY_KEY[key];
    const changes: { code: string; text: string }[] = [];
    for (const [code, raw] of Object.entries(groups![key] ?? {})) {
      if (!PROFILE_LANGUAGE_CODES.includes(code)) {
        throw AppError.badRequest(`Unknown language “${code}” in ${spec.label}.`);
      }
      const text = asText(raw).trim();
      if (text.length > spec.max) {
        throw AppError.badRequest(
          `${spec.label} (${code}) must be at most ${spec.max} characters (got ${text.length}).`,
        );
      }
      const violation = findContentViolation(spec.kind, text);
      if (violation) throw AppError.badRequest(`${spec.label} (${code}) ${violation}.`);
      changes.push({ code, text });
    }
    if (!changes.length) {
      throw AppError.badRequest(`${spec.label} must name at least one language that changed.`);
    }
    const raw = existing?.[spec.column] ?? "";
    plan.push({ column: spec.column, value: mergeTranslationBlob(raw, spec.column, PROFILE_LANGUAGE_CODES, changes) });
  }
  return plan;
}

/** Merge plan for the artwork columns. */
function planFileChanges(input: unknown): { column: string; value: string }[] {
  const files = input as Record<string, unknown> | undefined;
  const keys = Object.keys(files ?? {});
  if (!keys.length) return [];
  const plan: { column: string; value: string }[] = [];
  for (const key of keys) {
    const spec = MEDIA_COLUMNS.find((m) => m.key === key);
    if (!spec) throw AppError.badRequest(`Unknown image field: “${key}”.`);
    plan.push({ column: spec.column, value: readFileName(files![key], spec.label) });
  }
  return plan;
}

function toDto(row: model.ProfileRow): RideProfileDto {
  const fields: ProfileFieldDto[] = TEXT_BLOBS.map((spec) => {
    const raw = row.blobs[spec.column] ?? "";
    const parsed = parseTranslationBlob(raw);
    const languages: ProfileLanguageField[] = PROFILE_LANGUAGES.map((l) => ({
      code: l.code,
      label: l.label,
      text: parsed?.[`${spec.column}_${l.code}`] ?? "",
    }));
    const known = new Set(PROFILE_LANGUAGE_CODES.map((c) => `${spec.column}_${c}`));
    return {
      key: spec.key,
      column: spec.column,
      label: spec.label,
      kind: spec.kind,
      max: spec.max,
      multiline: spec.multiline,
      filled: languages.filter((l) => l.text.trim() !== "").length,
      languages,
      extraKeys: parsed
        ? Object.keys(parsed).filter((k) => !known.has(k) && !k.startsWith(`${spec.column}_`))
        : [],
    };
  });

  const files: ProfileFileDto[] = MEDIA_COLUMNS.map((spec) => ({
    key: spec.key,
    column: spec.column,
    label: spec.label,
    value: row.files[spec.column] ?? "",
  }));

  const nameField = fields.find((f) => f.key === "profileName");
  const shortField = fields.find((f) => f.key === "shortProfileName");
  const textOf = (f: ProfileFieldDto | undefined) =>
    f?.languages.find((l) => l.code === PRIMARY_LANGUAGE)?.text.trim() ||
    f?.languages.find((l) => l.text.trim() !== "")?.text.trim() ||
    "";

  return {
    id: row.id,
    status: row.status,
    name: textOf(nameField) || `Profile #${row.id}`,
    shortName: textOf(shortField),
    languages: PROFILE_LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
    fields,
    files,
  };
}

/** All live profiles, oldest first. */
export async function listProfiles(): Promise<RideProfileListItem[]> {
  return model.listProfileRows();
}

const MAX_LIMIT = 200;

export interface RideProfilePage {
  rows: RideProfileListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One filtered page, with the totals the pager needs. */
export async function listProfilesPaged(raw: {
  search?: unknown;
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<RideProfilePage> {
  const search = asText(raw.search).trim();
  const status =
    raw.status === "Active" || raw.status === "Inactive" ? (raw.status as ProfileStatus) : undefined;
  const page = Math.max(Math.trunc(Number(raw.page ?? 1)) || 1, 1);
  const limit = Math.min(Math.max(Math.trunc(Number(raw.limit ?? 50)) || 50, 1), MAX_LIMIT);

  const total = await model.countProfiles({ search, status });
  const rows = await model.listProfilePage({ search, status, limit, offset: (page - 1) * limit });
  return { rows, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
}

/** One profile with every stored language. */
export async function getProfile(id: number): Promise<RideProfileDto> {
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);
  return toDto(row);
}

/** A blank record: what the add form starts from (every column empty, 26 tabs). */
export async function blankRecord(): Promise<RideProfileDto> {
  const blobs = Object.create(null) as Record<string, string>;
  for (const spec of TEXT_BLOBS) blobs[spec.column] = "";
  const files = Object.create(null) as Record<string, string>;
  for (const spec of MEDIA_COLUMNS) files[spec.column] = "";
  return toDto({ id: 0, status: "Active", blobs, files });
}

/** Add a profile from scratch: nothing to merge, so only supplied texts are stored. */
export async function createProfile(input: RideProfileCreate): Promise<RideProfileDto> {
  const plan = planTextChanges(input.texts, null, true);
  const filePlan = planFileChanges(input.files);
  const status = readStatus(input.status);

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const { column, value } of [...plan, ...filePlan]) values[column] = value;

  const id = await model.nextProfileId();
  await model.insertProfileRow(id, { ...values, eStatus: status });
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound("The new ride profile could not be read back.");
  return toDto(row);
}

/** Edit a profile: merge the changed languages, leave every other key untouched. */
export async function updateProfile(id: number, input: RideProfileUpdate): Promise<RideProfileDto> {
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);

  const sets = [...planTextChanges(input.texts, row.blobs, false), ...planFileChanges(input.files)];
  if (!sets.length) throw AppError.badRequest("Send the copy or artwork that changed.");

  await model.updateProfileColumns(id, sets);
  const after = await model.findProfileRow(id);
  if (!after) throw AppError.notFound(`No ride profile #${id}.`);
  return toDto(after);
}

/** Activate / deactivate: an Inactive profile is not offered by the apps. */
export async function changeStatus(id: number, status: ProfileStatus): Promise<RideProfileDto> {
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);
  await model.setProfileStatus(id, readStatus(status));
  return getProfile(id);
}

export interface DeleteResult {
  name: string;
  organizations: number;
  members: number;
  tripReasons: number;
}

/**
 * Name-confirmed soft delete, refused while anything still files rows under the
 * profile — hiding it would leave organizations and reasons pointing at a profile
 * no screen can show.
 */
export async function deleteProfile(id: number, confirm: unknown): Promise<DeleteResult> {
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);

  const dto = toDto(row);
  const typed = asText(confirm).trim();
  if (!typed || typed !== dto.name) {
    throw AppError.badRequest(`Type “${dto.name}” exactly to delete this profile.`);
  }

  const usage = await model.countProfileUsage(id);
  const blocking = usage.organizations + usage.members + usage.tripReasons;
  if (blocking > 0) {
    throw AppError.badRequest(
      `This profile still has ${usage.organizations} organization(s), ${usage.members} member profile(s) and ` +
        `${usage.tripReasons} trip reason(s) filed under it; deactivate it instead of deleting it.`,
    );
  }

  await model.softDeleteProfile(id);
  return { name: dto.name, ...usage };
}

/**
 * Resolve an artwork field key to its column specification. An unknown key is a 400
 * rather than something to ignore, so a typo in the editor cannot look like an upload
 * that silently went nowhere.
 */
function mediaSpec(key: unknown): MediaSpec {
  const wanted = asText(key).trim();
  const spec = MEDIA_COLUMNS.find((m) => m.key === wanted);
  if (!spec) throw AppError.badRequest(`Unknown image field: “${wanted}”.`);
  return spec;
}

/**
 * The bare file name one artwork column currently holds. Reading it through the row
 * also scope-checks the id, so the stream endpoint 404s for a deleted profile before
 * it touches the disk. An empty string means the profile has no picture.
 */
export async function getMediaFilename(id: number, key: unknown): Promise<string> {
  const spec = mediaSpec(key);
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);
  return (row.files[spec.column] ?? "").trim();
}

/**
 * Point one artwork column at a newly stored file name. The upload endpoint owns this
 * write: the file is already on disk by the time it is called, and it rolls the file
 * back if this statement fails.
 */
export async function setMediaFilename(
  id: number,
  key: unknown,
  filename: string,
): Promise<RideProfileDto> {
  const spec = mediaSpec(key);
  const row = await model.findProfileRow(id);
  if (!row) throw AppError.notFound(`No ride profile #${id}.`);

  await model.updateProfileColumns(id, [{ column: spec.column, value: filename }]);
  const after = await model.findProfileRow(id);
  if (!after) throw AppError.notFound(`No ride profile #${id}.`);
  return toDto(after);
}

/** The field keys and language codes the route agrees the payload may name. */
export const PROFILE_FIELD_KEYS = TEXT_BLOBS.map((b) => b.key);
export const PROFILE_FILE_KEYS = MEDIA_COLUMNS.map((m) => m.key);
