import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import { mergeTranslationBlob, parseTranslationBlob, primaryText } from "../../../utils/translatedBlob";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `trip_reason` table (Taxi Service → Manage Ride
 * Profiles → Trip Reason, #sub-17-p96). One row is a reason a rider gives when
 * booking ("Airport/Station Ride", "Office to/from Home"), which the apps list on
 * the ride screen and the corporate booking flow files the trip under.
 *
 * Three quirks of the legacy DDL shape everything below:
 *
 * - the table has no primary key, no index and no auto-increment, so a new id
 *   comes from `MAX(iTripReasonId)+1` and each statement is a single one;
 * - `iUserProfileMasterId` is NOT NULL without a default, so a create must name
 *   the ride profile the reason belongs to — the STRICT_TRANS_TABLES server this
 *   runs against fills nothing in;
 * - `vReasonTitle` is not a name but a JSON object of 26 `<column>_<LANG>` keys,
 *   so a save merges the languages the editor touched and leaves the rest intact.
 *   See `src/utils/translatedBlob.ts`.
 *
 * `trips`, `cab_booking` and `cab_request_now` all store `iTripReasonId`, and the
 * table's `eStatus` enum includes `Deleted`, so deletes here are soft: the reason
 * disappears from this screen and from the apps while the history keeps its label.
 */

export type ReasonStatus = "Active" | "Inactive";

/** Live reasons; `Deleted` rows are hidden everywhere. */
const SCOPE = "eStatus <> 'Deleted'";

/** The single translated-blob column of this table. */
export const TITLE_COLUMN = "vReasonTitle";
/** Blob column of a profile's own name, read here for labels. */
const PROFILE_NAME_COLUMN = "vProfileName";

/** Languages the legacy blob pre-allocates a key for. */
export const REASON_LANGUAGES = TRANSLATION_LANGUAGES;
/** Language a row must be readable in even when nothing else is translated. */
export const PRIMARY_LANGUAGE = "EN";
/** Every language code of this screen, in the order the editor lists them. */
export const REASON_LANGUAGE_CODES: readonly string[] = REASON_LANGUAGES.map((l) => l.code);

/** Listing shape: the primary-language text plus how much is translated. */
export interface ReasonSummaryRow {
  id: number;
  title: string;
  status: ReasonStatus;
  /** Which ride profile the reason is grouped under. */
  profileId: number;
  /** How many of the 26 language keys carry text. */
  translationsFilled: number;
}

/** Detail shape: every stored language, plus keys this screen does not know. */
export interface ReasonRow {
  id: number;
  status: ReasonStatus;
  profileId: number;
  /** Raw column value, kept so a merge can preserve what is not shown. */
  titleBlob: string;
  /** Language code → text, for every language in `REASON_LANGUAGES`. */
  texts: Record<string, string>;
  /** Keys in the blob that belong to no language this screen knows. */
  extraKeys: string[];
}

/** The ride profiles a reason can be filed under (`user_profile_master`). */
export interface ProfileOption {
  id: number;
  name: string;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): ReasonStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/** Primary-language label of any translated blob of these tables. */
function labelOf(blob: unknown, column: string): string {
  return primaryText(blob, column, PRIMARY_LANGUAGE);
}

function countFilled(blob: string): number {
  const parsed = parseTranslationBlob(blob);
  if (!parsed) return blob.trim() === "" ? 0 : 1;
  return REASON_LANGUAGE_CODES.filter(
    (code) => (parsed[`${TITLE_COLUMN}_${code}`] ?? "").trim() !== "",
  ).length;
}

const LIST_ORDER = "ORDER BY iTripReasonId";

function mapReasonSummary(r: Record<string, unknown>): ReasonSummaryRow {
  const blob = str(r.title_raw);
  return {
    id: num(r.id),
    title: labelOf(blob, TITLE_COLUMN),
    status: mapStatus(r.eStatus),
    profileId: num(r.profileId),
    translationsFilled: countFilled(blob),
  };
}

/** All live reasons, oldest first (the order the legacy screen shows). */
export async function listReasonRows(): Promise<ReasonSummaryRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT iTripReasonId AS id, eStatus, iUserProfileMasterId AS profileId, vReasonTitle AS title_raw
       FROM trip_reason
      WHERE ${SCOPE} ${LIST_ORDER}`,
  );
  return rows.map(mapReasonSummary);
}

/** One filtered page of reasons; `limit`/`offset` bound the result. */
export async function listReasonPage(filters: {
  search: string;
  status?: ReasonStatus;
  limit: number;
  offset: number;
}): Promise<ReasonSummaryRow[]> {
  const clauses = [SCOPE];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push("eStatus = ?");
    params.push(filters.status);
  }
  if (filters.search) {
    // The English key is what the screen lists, so that is what search matches.
    clauses.push("vReasonTitle LIKE ?");
    params.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT iTripReasonId AS id, eStatus, iUserProfileMasterId AS profileId, vReasonTitle AS title_raw
       FROM trip_reason
      WHERE ${clauses.join(" AND ")}
      ${LIST_ORDER} LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return rows.map(mapReasonSummary);
}

/** Total live reasons matching the same filters. */
export async function countReasons(filters: {
  search: string;
  status?: ReasonStatus;
}): Promise<number> {
  const clauses = [SCOPE];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push("eStatus = ?");
    params.push(filters.status);
  }
  if (filters.search) {
    clauses.push("vReasonTitle LIKE ?");
    params.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM trip_reason WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return num(rows[0]?.n);
}

/**
 * One live reason with every stored language. `vReasonTitle` is read whole rather
 * than column-by-column because the 26 translations live inside it.
 */
export async function findReasonRow(id: number): Promise<ReasonRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT iTripReasonId AS id, iUserProfileMasterId AS profile_id, eStatus, vReasonTitle
       FROM trip_reason
      WHERE iTripReasonId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const blob = str(r.vReasonTitle);
  const parsed = parseTranslationBlob(blob);

  const texts = Object.create(null) as Record<string, string>;
  for (const code of REASON_LANGUAGE_CODES) {
    texts[code] = parsed?.[`${TITLE_COLUMN}_${code}`] ?? "";
  }
  const known = new Set(REASON_LANGUAGE_CODES.map((code) => `${TITLE_COLUMN}_${code}`));
  const extraKeys = parsed
    ? Object.keys(parsed).filter((key) => !known.has(key) && !key.startsWith(`${TITLE_COLUMN}_`))
    : [];

  return {
    id: num(r.id),
    status: mapStatus(r.eStatus),
    profileId: num(r.profile_id),
    titleBlob: blob,
    texts,
    extraKeys,
  };
}

/** There is no auto-increment, so the new id is the highest one in use, plus one. */
export async function nextReasonId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iTripReasonId), 0) + 1 AS nid FROM trip_reason",
  );
  return Number(rows[0]?.nid ?? 1);
}

/** Add a reason. The blob comes from `blobForNewReason`, built by the service. */
export async function insertReason(
  id: number,
  profileId: number,
  titleBlob: string,
  status: ReasonStatus,
): Promise<void> {
  await execute(
    `INSERT INTO trip_reason (iTripReasonId, iUserProfileMasterId, vReasonTitle, eStatus)
     VALUES (?, ?, ?, ?)`,
    [id, profileId, titleBlob, status],
  );
}

/** Write the merged blob, and move the reason to another profile when asked. */
export async function updateReason(
  id: number,
  sets: { titleBlob?: string; profileId?: number },
): Promise<void> {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (sets.titleBlob !== undefined) {
    parts.push("vReasonTitle = ?");
    params.push(sets.titleBlob);
  }
  if (sets.profileId !== undefined) {
    parts.push("iUserProfileMasterId = ?");
    params.push(sets.profileId);
  }
  if (!parts.length) return;
  params.push(id);
  await execute(
    `UPDATE trip_reason SET ${parts.join(", ")} WHERE iTripReasonId = ? AND ${SCOPE} LIMIT 1`,
    params,
  );
}

export async function setReasonStatus(id: number, status: ReasonStatus): Promise<void> {
  await execute(
    `UPDATE trip_reason SET eStatus = ? WHERE iTripReasonId = ? AND ${SCOPE} LIMIT 1`,
    [status, id],
  );
}

/** Soft delete: the apps stop offering the reason, the trips keep their label. */
export async function softDeleteReason(id: number): Promise<void> {
  await execute(
    `UPDATE trip_reason SET eStatus = 'Deleted' WHERE iTripReasonId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
}

/**
 * What still references the reason. Only live work blocks a delete: a trip that is
 * running or a booking/request still open. Finished history is reported, not guarded.
 */
export async function countReasonUsage(id: number): Promise<{
  ongoingTrips: number;
  openBookings: number;
  openRequests: number;
  tripRecords: number;
}> {
  const rows = await query<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM trips WHERE iTripReasonId = ? AND iActive IN ('On Going Trip', 'Arrived')) AS ongoing_trips,
       (SELECT COUNT(*) FROM cab_booking WHERE iTripReasonId = ? AND eStatus IN ('Pending', 'Assign', 'Accepted')) AS open_bookings,
       (SELECT COUNT(*) FROM cab_request_now WHERE iTripReasonId = ? AND eStatus IN ('Requesting', 'Pending')) AS open_requests,
       (SELECT COUNT(*) FROM trips WHERE iTripReasonId = ?) AS trip_records`,
    [id, id, id, id],
  );
  const r = rows[0] ?? {};
  return {
    ongoingTrips: num(r.ongoing_trips),
    openBookings: num(r.open_bookings),
    openRequests: num(r.open_requests),
    tripRecords: num(r.trip_records),
  };
}

/**
 * Live ride profiles a reason can belong to. Their names are translated blobs too,
 * so the label comes from the primary-language key of `vProfileName`.
 */
export async function listProfileOptions(): Promise<ProfileOption[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT iUserProfileMasterId AS id, vProfileName
       FROM user_profile_master
      WHERE eStatus <> 'Deleted'
      ORDER BY iUserProfileMasterId`,
  );
  return rows.map((r) => ({ id: num(r.id), name: labelOf(r.vProfileName, PROFILE_NAME_COLUMN) }));
}

/** Existence check for a chosen profile — the legacy column has no foreign key. */
export async function profileExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM user_profile_master
      WHERE iUserProfileMasterId = ? AND eStatus <> 'Deleted'`,
    [id],
  );
  return num(rows[0]?.n) > 0;
}

/**
 * Label of one profile, existence not filtered: a reason may still point at a
 * profile that was deleted after linking, and the screen must show what is stored
 * rather than pretend the link is empty.
 */
export async function findProfileName(id: number): Promise<string> {
  const rows = await query<{ vProfileName: string | null }>(
    "SELECT vProfileName FROM user_profile_master WHERE iUserProfileMasterId = ? LIMIT 1",
    [id],
  );
  return labelOf(rows[0]?.vProfileName, PROFILE_NAME_COLUMN);
}

/** The profile a new reason lands on when the editor does not choose one. */
export async function firstProfileId(): Promise<number | null> {
  const options = await listProfileOptions();
  return options.length ? options[0].id : null;
}

/** Merge changed languages into one stored blob, preserving every other key. */
export function mergeReasonBlob(
  raw: string,
  changed: readonly { code: string; text: string }[],
): string {
  const merged = mergeTranslationBlob(raw, TITLE_COLUMN, REASON_LANGUAGE_CODES, changed);
  if (Buffer.byteLength(merged, "utf8") > MAX_TITLE_BLOB_BYTES) {
    throw AppError.badRequest(`The translated reason would grow past ${MAX_TITLE_BLOB_BYTES} bytes.`);
  }
  return merged;
}

/** A `vReasonTitle` column is `longtext`, but 26 names should never near this. */
const MAX_TITLE_BLOB_BYTES = 65_536;

/** Build the blob of a new reason from the texts the editor supplied. */
export function blobForNewReason(texts: Record<string, string>): string {
  return mergeReasonBlob(
    "",
    REASON_LANGUAGE_CODES.map((code) => ({ code, text: texts[code] ?? "" })),
  );
}
