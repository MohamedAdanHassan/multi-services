import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import { parseTranslationBlob, primaryText } from "../../../utils/translatedBlob";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `user_profile_master` table (Taxi Service → Manage
 * Ride Profiles → Profiles, #sub-17-p91). One row is a ride profile — the "Business"
 * profile today — which is the grouping a corporate account books under: the apps
 * show its screen copy, and `organization`, `user_profile` and `trip_reason` all
 * file their rows against `iUserProfileMasterId`.
 *
 * Everything this screen owns is a translated blob: eight `longtext` columns each
 * hold one JSON object of 26 `<column>_<LANG>` keys (`vTitle_EN`, `vTitle_AR`, …),
 * so the whole copy set of a row is eight columns, not 208. Only the languages the
 * editor touched are merged; see `src/utils/translatedBlob.ts`.
 *
 * As on the sibling Ride tables there is no primary key and no auto-increment —
 * ids come from `MAX(iUserProfileMasterId)+1` — and three live tables point at
 * these rows, so a delete is soft (`eStatus='Deleted'`) and guarded.
 */

export type ProfileStatus = "Active" | "Inactive";

/** Live profiles; `Deleted` rows are hidden everywhere. */
const SCOPE = "eStatus <> 'Deleted'";

/** Languages the legacy blobs pre-allocate a key for. */
export const PROFILE_LANGUAGES = TRANSLATION_LANGUAGES;
export const PRIMARY_LANGUAGE = "EN";
export const PROFILE_LANGUAGE_CODES: readonly string[] = PROFILE_LANGUAGES.map((l) => l.code);

/** One translated column of this table. */
export interface BlobSpec {
  /** Physical `longtext` column holding the JSON object. */
  column: string;
  /** Payload / DTO key the screen uses for it. */
  key: string;
  label: string;
  /** `html` copy is app-rendered markup; `text` is a single line. */
  kind: "text" | "html";
  max: number;
  multiline: boolean;
}

/**
 * The eight blob columns, in the order the legacy screen groups them: the name the
 * apps file bookings under, then the welcome and pick-screen copy.
 */
export const TEXT_BLOBS: readonly BlobSpec[] = [
  { column: "vProfileName", key: "profileName", label: "Profile name", kind: "text", max: 100, multiline: false },
  { column: "vShortProfileName", key: "shortProfileName", label: "Short profile name", kind: "text", max: 100, multiline: false },
  { column: "vTitle", key: "title", label: "List title", kind: "text", max: 200, multiline: false },
  { column: "vSubTitle", key: "subTitle", label: "List subtitle", kind: "text", max: 300, multiline: false },
  { column: "vScreenHeading", key: "screenHeading", label: "Screen heading", kind: "text", max: 200, multiline: false },
  { column: "vScreenTitle", key: "screenTitle", label: "Screen title", kind: "text", max: 200, multiline: false },
  { column: "vScreenButtonText", key: "screenButtonText", label: "Screen button text", kind: "text", max: 200, multiline: false },
  { column: "tDescription", key: "description", label: "Description", kind: "html", max: 2000, multiline: true },
];

export const BLOB_BY_KEY: Record<string, BlobSpec> = Object.assign(
  Object.create(null) as Record<string, BlobSpec>,
  Object.fromEntries(TEXT_BLOBS.map((b) => [b.key, b])),
);

export const BLOB_BY_COLUMN: Record<string, BlobSpec> = Object.assign(
  Object.create(null) as Record<string, BlobSpec>,
  Object.fromEntries(TEXT_BLOBS.map((b) => [b.column, b])),
);

/** Artwork columns: bare file names the apps concatenate into an image URL. */
export interface MediaSpec {
  column: string;
  key: string;
  label: string;
}

export const MEDIA_COLUMNS: readonly MediaSpec[] = [
  { column: "vImage", key: "image", label: "Profile icon" },
  { column: "vWelcomeImage", key: "welcomeImage", label: "Welcome image" },
];

/**
 * Every NOT NULL column without a DB default. The strict server fills nothing in,
 * so a create names each one: the eight blobs and two file columns start empty, and
 * the status comes from the request.
 */
export const CREATE_DEFAULTS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  { eStatus: "Active" },
  Object.fromEntries(TEXT_BLOBS.map((b) => [b.column, ""])),
  Object.fromEntries(MEDIA_COLUMNS.map((m) => [m.column, ""])),
);

/** Columns this screen may write: the blobs, the artwork, and nothing else. */
export const EDITABLE_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  Object.fromEntries(
    [...TEXT_BLOBS.map((b) => b.column), ...MEDIA_COLUMNS.map((m) => m.column)].map((column) => [
      column,
      true as const,
    ]),
  ),
);

/** Columns an INSERT may name. The id is supplied by the caller, never a client. */
export const INSERT_COLUMNS: Record<string, true> = Object.assign(
  Object.create(null) as Record<string, true>,
  { iUserProfileMasterId: true as const },
  Object.fromEntries(Object.keys(CREATE_DEFAULTS).map((column) => [column, true as const])),
);

/** Listing shape. */
export interface ProfileSummaryRow {
  id: number;
  /** Primary-language profile name — what the apps file bookings under. */
  name: string;
  shortName: string;
  status: ProfileStatus;
  image: string;
  /** How many of the eight copy columns carry any text. */
  blobsFilled: number;
  /** How many languages the profile name is translated into. */
  namesFilled: number;
}

/** Detail shape: every column, still in its stored form. */
export interface ProfileRow {
  id: number;
  status: ProfileStatus;
  /** Blob column → raw stored text (JSON object or legacy plain text). */
  blobs: Record<string, string>;
  /** Media column → file name. */
  files: Record<string, string>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): ProfileStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

const LIST_ORDER = "ORDER BY iUserProfileMasterId";

function mapProfileSummary(r: Record<string, unknown>): ProfileSummaryRow {
  const nameRaw = str(r.name_raw);
  const parsed = parseTranslationBlob(nameRaw);
  return {
    id: num(r.id),
    name: primaryText(nameRaw, "vProfileName", PRIMARY_LANGUAGE),
    shortName: primaryText(str(r.short_raw), "vShortProfileName", PRIMARY_LANGUAGE),
    status: mapStatus(r.eStatus),
    image: str(r.vImage).trim(),
    blobsFilled: TEXT_BLOBS.filter((b) => num(r[`len_${b.column}`]) > 0).length,
    namesFilled: parsed
      ? PROFILE_LANGUAGE_CODES.filter((c) => (parsed[`vProfileName_${c}`] ?? "").trim() !== "").length
      : nameRaw.trim() === ""
        ? 0
        : 1,
  };
}

/**
 * The listing reads the blobs it needs labels from, plus `CHAR_LENGTH` of each copy
 * column so "how much of this profile is filled in" costs no extra round trip.
 */
const LIST_COLUMNS = `SELECT iUserProfileMasterId AS id, vProfileName AS name_raw,
         vShortProfileName AS short_raw, eStatus, vImage,
         ${TEXT_BLOBS.map((b) => `CHAR_LENGTH(${b.column}) AS \`len_${b.column}\``).join(",\n         ")}
       FROM user_profile_master`;

/** All live profiles, oldest first. */
export async function listProfileRows(): Promise<ProfileSummaryRow[]> {
  const rows = await query<Record<string, unknown>>(`${LIST_COLUMNS} WHERE ${SCOPE} ${LIST_ORDER}`);
  return rows.map(mapProfileSummary);
}

/** One filtered page of profiles. */
export async function listProfilePage(filters: {
  search: string;
  status?: ProfileStatus;
  limit: number;
  offset: number;
}): Promise<ProfileSummaryRow[]> {
  const { where, params } = buildFilters(filters);
  const rows = await query<Record<string, unknown>>(
    `${LIST_COLUMNS} ${where} ${LIST_ORDER} LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return rows.map(mapProfileSummary);
}

/** Total live profiles matching the same filters. */
export async function countProfiles(filters: {
  search: string;
  status?: ProfileStatus;
}): Promise<number> {
  const { where, params } = buildFilters(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM user_profile_master ${where}`,
    params,
  );
  return num(rows[0]?.n);
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Shared WHERE fragment + params for page/count so they never drift. Search matches
 * the raw column because the English text lives inside the JSON blob.
 */
function buildFilters(f: { search: string; status?: ProfileStatus }): {
  where: string;
  params: unknown[];
} {
  const clauses = [SCOPE];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push("(vProfileName LIKE ? OR vShortProfileName LIKE ?)");
    params.push(likePattern(f.search), likePattern(f.search));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One live profile with every stored column. */
export async function findProfileRow(id: number): Promise<ProfileRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM user_profile_master WHERE iUserProfileMasterId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];

  const blobs = Object.create(null) as Record<string, string>;
  for (const spec of TEXT_BLOBS) blobs[spec.column] = str(r[spec.column]);
  const files = Object.create(null) as Record<string, string>;
  for (const spec of MEDIA_COLUMNS) files[spec.column] = str(r[spec.column]).trim();

  return { id: num(r.iUserProfileMasterId), status: mapStatus(r.eStatus), blobs, files };
}

/** There is no auto-increment, so the new id is the highest one in use, plus one. */
export async function nextProfileId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iUserProfileMasterId), 0) + 1 AS nid FROM user_profile_master",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * Write several columns of one profile in a single statement. Column names cannot be
 * bound, so each must pass the `EDITABLE_COLUMNS` whitelist — anything else is
 * refused before SQL is built.
 */
export async function updateProfileColumns(
  id: number,
  sets: { column: string; value: string }[],
): Promise<void> {
  if (!sets.length) return;
  for (const { column } of sets) {
    if (!Object.prototype.hasOwnProperty.call(EDITABLE_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” is not editable here.`);
    }
  }
  await execute(
    `UPDATE user_profile_master SET ${sets.map((s) => `${s.column} = ?`).join(", ")}
      WHERE iUserProfileMasterId = ? AND ${SCOPE} LIMIT 1`,
    [...sets.map((s) => s.value), id],
  );
}

/**
 * Add a profile. `values` is merged over `CREATE_DEFAULTS`, and because the column
 * names are interpolated every key is re-checked against `INSERT_COLUMNS`.
 */
export async function insertProfileRow(
  id: number,
  values: Record<string, string>,
): Promise<void> {
  const row = Object.assign({}, CREATE_DEFAULTS, values);
  if (num(row.iUserProfileMasterId) !== id) row.iUserProfileMasterId = String(id);

  const columns = Object.keys(row);
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(INSERT_COLUMNS, column)) {
      throw AppError.badRequest(`Column “${column}” cannot be set on a new ride profile.`);
    }
  }
  if (!columns.includes("iUserProfileMasterId")) columns.unshift("iUserProfileMasterId");

  await execute(
    `INSERT INTO user_profile_master (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
}

export async function setProfileStatus(id: number, status: ProfileStatus): Promise<void> {
  await execute(
    `UPDATE user_profile_master SET eStatus = ? WHERE iUserProfileMasterId = ? AND ${SCOPE} LIMIT 1`,
    [status, id],
  );
}

/** Soft delete: the apps stop offering the profile; the rows filed under it survive. */
export async function softDeleteProfile(id: number): Promise<void> {
  await execute(
    `UPDATE user_profile_master SET eStatus = 'Deleted'
      WHERE iUserProfileMasterId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
}

/**
 * What still files rows under this profile. A profile with live organizations,
 * members or trip reasons cannot be hidden without stranding them, so the count is
 * reported and the delete refused while any remain.
 */
export async function countProfileUsage(id: number): Promise<{
  organizations: number;
  members: number;
  tripReasons: number;
}> {
  const rows = await query<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM organization WHERE iUserProfileMasterId = ? AND eStatus <> 'Deleted') AS orgs,
       (SELECT COUNT(*) FROM user_profile WHERE iUserProfileMasterId = ? AND eStatus <> 'Deleted') AS members,
       (SELECT COUNT(*) FROM trip_reason WHERE iUserProfileMasterId = ? AND eStatus <> 'Deleted') AS reasons`,
    [id, id, id],
  );
  const r = rows[0] ?? {};
  return {
    organizations: num(r.orgs),
    members: num(r.members),
    tripReasons: num(r.reasons),
  };
}
