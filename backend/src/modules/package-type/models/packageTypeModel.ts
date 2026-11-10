import { execute, query } from "../../../db/mysql";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";

/**
 * Data access for the legacy `package_type` table (Parcel Delivery → Package Type,
 * #sub-139). One row is one choice the sender picks in the parcel app's order form
 * ("Documents", "Chilled Parcel", "Crate or Box"), and it belongs to the delivery
 * field that renders it: `iDeliveryFieldId` names a `delivery_fields` row whose
 * `eInputType` is `Select`.
 *
 * Three quirks of the legacy DDL shape everything below:
 *
 * - the table is MyISAM with no primary key, no index and no auto-increment, so a
 *   new id comes from `MAX(iPackageTypeId)+1` and each statement stands alone;
 * - the name is not one column but 27: `vName_EN`, `vName_FR` … for all 26 legacy
 *   languages, plus the unsuffixed `vName` every installed row keeps equal to the
 *   English one. The legacy apps still read `vName`, so a save that touches English
 *   writes both — the same mirror `vehicle_type` keeps on `vVehicleType`;
 * - every one of those columns is `NOT NULL` without a default, so a create names
 *   all of them, and `iDeliveryFieldId` has to be supplied too.
 *
 * `trips`, `cab_booking`, `cab_request_now` and `trips_delivery_locations` all store
 * `iPackageTypeId`, and the `eStatus` enum includes `Deleted`, so deletes here are
 * soft: the choice disappears from the app while the orders that used it keep it.
 */

export type PackageStatus = "Active" | "Inactive";

/** Live package types; `Deleted` rows are hidden everywhere. */
const SCOPE = "eStatus <> 'Deleted'";
/**
 * The same rule for the statements that alias `package_type` to `p`. The list joins
 * `delivery_fields f`, which owns an `eStatus` too, so the unqualified column would
 * be ambiguous there — MySQL refuses it rather than guessing.
 */
const SCOPE_P = "p.eStatus <> 'Deleted'";

/** Base of the per-language name columns; `<base>_<LANG>` is one column per language. */
export const NAME_BASE = "vName";
/** Unsuffixed sibling the legacy apps read, kept equal to the English name. */
export const NAME_MIRROR = "vName";
/** Column of the delivery field this choice belongs to. */
export const FIELD_COLUMN = "iDeliveryFieldId";

/** Languages the legacy table pre-allocates a column for. */
export const PACKAGE_LANGUAGES = TRANSLATION_LANGUAGES;
/** Language a row must be readable in even when nothing else is translated. */
export const PRIMARY_LANGUAGE = "EN";
/** Every language code of this screen, in the order the editor lists them. */
export const PACKAGE_LANGUAGE_CODES: readonly string[] = PACKAGE_LANGUAGES.map((l) => l.code);

/** The 26 name columns, in `<base>_<LANG>` form. */
export const NAME_COLUMNS: readonly string[] = PACKAGE_LANGUAGE_CODES.map(
  (code) => `${NAME_BASE}_${code}`,
);

/** Listing shape: the English name, the field it belongs to, translation coverage. */
export interface PackageSummaryRow {
  id: number;
  name: string;
  status: PackageStatus;
  fieldId: number;
  /** Label of that delivery field, or an empty string when the row is gone. */
  fieldName: string;
  /** How many of the 26 name columns carry text. */
  translationsFilled: number;
}

/** Detail shape: every stored language plus the field link. */
export interface PackageRow {
  id: number;
  status: PackageStatus;
  fieldId: number;
  /** Language code → text, for every language in `PACKAGE_LANGUAGES`. */
  texts: Record<string, string>;
}

/** A delivery field a package type can belong to (`delivery_fields`). */
export interface FieldOption {
  id: number;
  name: string;
  /** `Text` / `Textarea` / `Select` / `Number`; only `Select` takes options. */
  inputType: string;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): PackageStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

const LIST_COLUMNS = `SELECT p.iPackageTypeId AS id, p.vName_EN AS name, p.eStatus,
         p.${FIELD_COLUMN} AS field_id, f.vFieldName_EN AS field_name,
         ${PACKAGE_LANGUAGE_CODES.map(
           (code) => `CHAR_LENGTH(p.${NAME_BASE}_${code}) AS filled_${code}`,
         ).join(",\n         ")}
       FROM package_type p
       LEFT JOIN delivery_fields f ON f.iDeliveryFieldId = p.${FIELD_COLUMN}`;

/** No display-order column exists, so the legacy screen's own order is the id. */
const LIST_ORDER = "ORDER BY p.iPackageTypeId";

function mapPackageSummary(r: Record<string, unknown>): PackageSummaryRow {
  return {
    id: num(r.id),
    name: str(r.name).trim(),
    status: mapStatus(r.eStatus),
    fieldId: num(r.field_id),
    fieldName: str(r.field_name).trim(),
    translationsFilled: PACKAGE_LANGUAGE_CODES.filter((code) => num(r[`filled_${code}`]) > 0).length,
  };
}

/** Filters shared by the page and the count, so the two can never disagree. */
function whereParts(filters: { search: string; status?: PackageStatus }): {
  sql: string;
  params: unknown[];
} {
  const clauses = [SCOPE_P];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push("p.eStatus = ?");
    params.push(filters.status);
  }
  if (filters.search) {
    // The English column is what the list shows, so that is what search matches.
    clauses.push("p.vName_EN LIKE ?");
    params.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  return { sql: clauses.join(" AND "), params };
}

/** All live package types, oldest first. */
export async function listPackageRows(): Promise<PackageSummaryRow[]> {
  const rows = await query<Record<string, unknown>>(
    `${LIST_COLUMNS} WHERE ${SCOPE_P} ${LIST_ORDER}`,
  );
  return rows.map(mapPackageSummary);
}

/** One filtered page of package types; `limit`/`offset` bound the result. */
export async function listPackagePage(filters: {
  search: string;
  status?: PackageStatus;
  limit: number;
  offset: number;
}): Promise<PackageSummaryRow[]> {
  const where = whereParts(filters);
  const rows = await query<Record<string, unknown>>(
    `${LIST_COLUMNS} WHERE ${where.sql} ${LIST_ORDER} LIMIT ? OFFSET ?`,
    [...where.params, filters.limit, filters.offset],
  );
  return rows.map(mapPackageSummary);
}

/** Total live package types matching the same filters. */
export async function countPackages(filters: {
  search: string;
  status?: PackageStatus;
}): Promise<number> {
  const where = whereParts(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM package_type p WHERE ${where.sql}`,
    where.params,
  );
  return num(rows[0]?.n);
}

/**
 * One live package type with every stored language. The 26 columns are read by
 * name because, unlike `trip_reason`, this table keeps one column per language.
 */
export async function findPackageRow(id: number): Promise<PackageRow | null> {
  const columns = [
    "iPackageTypeId AS id",
    "eStatus",
    `${FIELD_COLUMN} AS field_id`,
    ...PACKAGE_LANGUAGE_CODES.map((code) => `${NAME_BASE}_${code} AS ${code}`),
  ].join(", ");
  const rows = await query<Record<string, unknown>>(
    `SELECT ${columns} FROM package_type WHERE iPackageTypeId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];

  const texts = Object.create(null) as Record<string, string>;
  for (const code of PACKAGE_LANGUAGE_CODES) texts[code] = str(r[code]);

  return { id: num(r.id), status: mapStatus(r.eStatus), fieldId: num(r.field_id), texts };
}

/** There is no auto-increment, so the new id is the highest one in use, plus one. */
export async function nextPackageId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iPackageTypeId), 0) + 1 AS nid FROM package_type",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * Add a package type. Every NOT NULL column is named: `text` columns cannot carry
 * a DDL default and the STRICT_TRANS_TABLES server this runs against fills nothing
 * in, so a language the editor left blank is written as an empty string.
 */
export async function insertPackage(
  id: number,
  texts: Record<string, string>,
  status: PackageStatus,
  fieldId: number,
): Promise<void> {
  const columns = ["iPackageTypeId", ...NAME_COLUMNS, NAME_MIRROR, FIELD_COLUMN, "eStatus"];
  const values = [
    id,
    ...PACKAGE_LANGUAGE_CODES.map((code) => texts[code] ?? ""),
    texts[PRIMARY_LANGUAGE] ?? "",
    fieldId,
    status,
  ];
  await execute(
    `INSERT INTO package_type (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values,
  );
}

/**
 * Write the languages that changed — and only those, so a save from this screen
 * cannot blank a translation it never showed. English also moves the unsuffixed
 * mirror the legacy apps read, and the field link moves when the editor moved it.
 */
export async function updatePackage(
  id: number,
  sets: { texts?: Record<string, string>; fieldId?: number },
): Promise<void> {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  for (const [code, text] of Object.entries(sets.texts ?? {})) {
    parts.push(`${NAME_BASE}_${code} = ?`);
    params.push(text);
    // The mirror follows English alone: it is the legacy apps' fallback name.
    if (code === PRIMARY_LANGUAGE) {
      parts.push(`${NAME_MIRROR} = ?`);
      params.push(text);
    }
  }
  if (sets.fieldId !== undefined) {
    parts.push(`${FIELD_COLUMN} = ?`);
    params.push(sets.fieldId);
  }
  if (!parts.length) return;

  params.push(id);
  await execute(
    `UPDATE package_type SET ${parts.join(", ")} WHERE iPackageTypeId = ? AND ${SCOPE} LIMIT 1`,
    params,
  );
}

export async function setPackageStatus(id: number, status: PackageStatus): Promise<void> {
  await execute(
    `UPDATE package_type SET eStatus = ? WHERE iPackageTypeId = ? AND ${SCOPE} LIMIT 1`,
    [status, id],
  );
}

/** Soft delete: the app stops offering the choice, the orders keep their label. */
export async function softDeletePackage(id: number): Promise<void> {
  await execute(
    `UPDATE package_type SET eStatus = 'Deleted' WHERE iPackageTypeId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
}

/**
 * What still references the package type. Only live work blocks a delete: a trip
 * that is running, or a booking / request still open. Finished history is
 * reported, not guarded.
 */
export async function countPackageUsage(id: number): Promise<{
  ongoingTrips: number;
  openBookings: number;
  openRequests: number;
  tripRecords: number;
}> {
  const rows = await query<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM trips WHERE iPackageTypeId = ? AND iActive IN ('On Going Trip', 'Arrived')) AS ongoing_trips,
       (SELECT COUNT(*) FROM cab_booking WHERE iPackageTypeId = ? AND eStatus IN ('Pending', 'Assign', 'Accepted')) AS open_bookings,
       (SELECT COUNT(*) FROM cab_request_now WHERE iPackageTypeId = ? AND eStatus IN ('Requesting', 'Pending')) AS open_requests,
       (SELECT COUNT(*) FROM trips WHERE iPackageTypeId = ?) AS trip_records`,
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
 * Delivery fields a package type can belong to. Only a `Select` field renders
 * options, which is what a package type is; they come back in the order the app
 * shows its form fields.
 */
export async function listFieldOptions(): Promise<FieldOption[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT iDeliveryFieldId AS id, vFieldName_EN AS name, eInputType
       FROM delivery_fields
      WHERE eStatus = 'Active' AND eInputType = 'Select'
      ORDER BY iOrder, iDeliveryFieldId`,
  );
  return rows.map((r) => ({
    id: num(r.id),
    name: str(r.name).trim(),
    inputType: str(r.eInputType),
  }));
}

/** Existence check for a chosen field — the legacy column has no foreign key. */
export async function fieldExists(id: number): Promise<boolean> {
  const rows = await query<{ n: number | null }>(
    "SELECT COUNT(*) AS n FROM delivery_fields WHERE iDeliveryFieldId = ?",
    [id],
  );
  return num(rows[0]?.n) > 0;
}

/**
 * Label of one field, existence and type not filtered: a package type may still
 * point at a field that was deleted or retyped after linking (row 8 of the shipped
 * data names field 6, which is gone), and the screen must show what is stored
 * rather than pretend the link is empty.
 */
export async function findFieldName(id: number): Promise<string> {
  const rows = await query<{ vFieldName_EN: string | null }>(
    "SELECT vFieldName_EN FROM delivery_fields WHERE iDeliveryFieldId = ? LIMIT 1",
    [id],
  );
  return str(rows[0]?.vFieldName_EN).trim();
}

/** The field a new package type lands on when the editor does not choose one. */
export async function firstFieldId(): Promise<number | null> {
  const options = await listFieldOptions();
  return options.length ? options[0].id : null;
}
