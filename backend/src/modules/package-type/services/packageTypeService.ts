import { AppError } from "../../../errors/AppError";
import { contentFieldLimit, findContentViolation } from "../../../utils/contentSanitizer";
import * as model from "../models/packageTypeModel";
import {
  PACKAGE_LANGUAGES,
  PACKAGE_LANGUAGE_CODES,
  PRIMARY_LANGUAGE,
} from "../models/packageTypeModel";
import type { FieldOption, PackageRow, PackageStatus, PackageSummaryRow } from "../models/packageTypeModel";

/**
 * Business rules for package types (Parcel Delivery → Package Type, #sub-139).
 *
 * The name lives in 26 per-language columns plus the unsuffixed `vName` mirror, so
 * this service validates only the languages the editor sent and lets the model
 * write exactly those columns — a save from this screen can never blank a language
 * it does not show. English additionally moves the mirror, because that is what the
 * installed rows do and what the legacy apps still read.
 *
 * A package type also belongs to the delivery field that renders it
 * (`iDeliveryFieldId` → `delivery_fields`), and the shipped data proves the link is
 * loose: one row names a field that no longer exists. So the stored id is always
 * labelled rather than swallowed, while anything the editor *picks* has to exist.
 *
 * Rows are soft-deleted only: `trips`, `cab_booking`, `cab_request_now` and
 * `trips_delivery_locations` store `iPackageTypeId`, and there are no foreign keys
 * to catch a stray id.
 */

/** One language of a package type, as the editor sees it. */
export interface PackageLanguageField {
  code: string;
  label: string;
  text: string;
}

/** A package type with every stored language, for the edit form. */
export interface PackageTypeDto {
  id: number;
  status: PackageStatus;
  /** Primary-language text; what the listing and the delete confirmation show. */
  name: string;
  fieldId: number;
  /** Label of the field it belongs to, or an empty string when that row is gone. */
  fieldName: string;
  /** Fields the editor may move this type to. */
  fieldOptions: FieldOption[];
  /** How many of the 26 languages carry text. */
  translationsFilled: number;
  /** Every language, in the order the form lists them. */
  languages: PackageLanguageField[];
  /** Longest text a single language column may hold. */
  maxNameLength: number;
}

/** A row of the listing. */
export type PackageTypeListItem = PackageSummaryRow;

/** What may be sent when adding a package type. */
export interface PackageTypeCreate {
  texts?: Record<string, unknown>;
  fieldId?: unknown;
  status?: unknown;
}

/** What may be sent when editing one. Only supplied languages are written. */
export interface PackageTypeUpdate {
  texts?: Record<string, unknown>;
  fieldId?: unknown;
}

/**
 * The name columns are `text`, but a package type is a short label the app shows in
 * a picker — 100 characters, the same ceiling `vehicle_type` gives its names.
 */
const NAME_MAX = 100;

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Validate the supplied language map and return the changes in column order.
 * Unknown codes are refused rather than ignored — a typo in a client would
 * otherwise look like a save that did nothing.
 */
function readTexts(
  input: Record<string, unknown> | undefined,
  required: boolean,
): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (required && entries.length === 0) {
    throw AppError.badRequest("Send at least the English name of the package type.");
  }
  // Tested before the loop, not inside it: a create that omits English entirely
  // would otherwise store a row the listing shows as a blank name.
  if (required && asText(input?.[PRIMARY_LANGUAGE]).trim() === "") {
    throw AppError.badRequest("The English package type name cannot be empty.");
  }

  const changes: Record<string, string> = {};
  for (const [code, raw] of entries) {
    if (!PACKAGE_LANGUAGE_CODES.includes(code)) {
      throw AppError.badRequest(`Unknown language: “${code}”.`);
    }
    const text = asText(raw).trim();
    if (text.length > NAME_MAX) {
      throw AppError.badRequest(
        `A package type name must be at most ${NAME_MAX} characters (got ${text.length}).`,
      );
    }
    // Same write-boundary guard every other app-rendered copy column uses.
    const violation = findContentViolation("text", text);
    if (violation) {
      throw AppError.badRequest(`The ${code} package type name ${violation}.`);
    }
    changes[code] = text;
  }
  return changes;
}

function readStatus(value: unknown): PackageStatus {
  if (value === undefined) return "Active";
  if (value !== "Active" && value !== "Inactive") {
    throw AppError.badRequest("Status must be Active or Inactive.");
  }
  return value;
}

/**
 * Bound the field link, and refuse one that names no `delivery_fields` row at all.
 * The stored id is accepted unchanged, even when its field has since been deleted
 * or retyped: the screen shows what the row really points at.
 */
async function readFieldId(value: unknown, fallback: number | null): Promise<number> {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) {
      throw AppError.badRequest(
        "There is no Select delivery field to attach a package type to yet.",
      );
    }
    return fallback;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) throw AppError.badRequest("Invalid delivery field.");
  if (id === 0) return 0;
  if (!(await model.fieldExists(id))) throw AppError.badRequest("That delivery field does not exist.");
  return id;
}

/** The whole live list, oldest first. */
export async function listPackageTypes(): Promise<PackageTypeListItem[]> {
  return model.listPackageRows();
}

/** Rows per page ceiling; the legacy table is tiny, but the pager bounds it. */
const MAX_LIMIT = 200;

export interface PackageTypePage {
  rows: PackageTypeListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One filtered page, with the totals the pager needs. */
export async function listPackageTypesPaged(raw: {
  search?: unknown;
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<PackageTypePage> {
  const search = asText(raw.search).trim();
  const status =
    raw.status === "Active" || raw.status === "Inactive" ? (raw.status as PackageStatus) : undefined;
  const page = Math.max(Math.trunc(Number(raw.page ?? 1)) || 1, 1);
  const limit = Math.min(Math.max(Math.trunc(Number(raw.limit ?? 50)) || 50, 1), MAX_LIMIT);

  const total = await model.countPackages({ search, status });
  const rows = await model.listPackagePage({
    search,
    status,
    limit,
    offset: (page - 1) * limit,
  });
  return { rows, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
}

/** Delivery fields a package type can belong to. */
export async function listFieldOptions(): Promise<FieldOption[]> {
  return model.listFieldOptions();
}

/** One package type with every stored language. */
export async function getPackageType(id: number): Promise<PackageTypeDto> {
  const row = await model.findPackageRow(id);
  if (!row) throw AppError.notFound(`No package type #${id}.`);
  return toDto(row);
}

async function toDto(row: PackageRow): Promise<PackageTypeDto> {
  const [fieldOptions, fieldName] = await Promise.all([
    model.listFieldOptions(),
    row.fieldId > 0 ? model.findFieldName(row.fieldId) : Promise.resolve(""),
  ]);
  return {
    id: row.id,
    status: row.status,
    name: row.texts[PRIMARY_LANGUAGE]?.trim() || firstText(row) || `Package type #${row.id}`,
    fieldId: row.fieldId,
    fieldName,
    fieldOptions,
    translationsFilled: PACKAGE_LANGUAGE_CODES.filter((c) => row.texts[c].trim() !== "").length,
    languages: PACKAGE_LANGUAGES.map((l) => ({ code: l.code, label: l.label, text: row.texts[l.code] })),
    maxNameLength: NAME_MAX,
  };
}

/** English missing? Any translated text still names the row for the header. */
function firstText(row: { texts: Record<string, string> }): string {
  const found = PACKAGE_LANGUAGE_CODES.map((c) => row.texts[c].trim()).find((t) => t !== "");
  return found ?? "";
}

/** A blank record: what the add form starts from, including the default field. */
export async function blankRecord(): Promise<PackageTypeDto> {
  const options = await model.listFieldOptions();
  const texts = Object.create(null) as Record<string, string>;
  for (const code of PACKAGE_LANGUAGE_CODES) texts[code] = "";
  return toDto({
    id: 0,
    status: "Active" as PackageStatus,
    fieldId: options[0]?.id ?? 0,
    texts,
  });
}

/** Add a package type: every language the editor left blank is stored blank. */
export async function createPackageType(input: PackageTypeCreate): Promise<PackageTypeDto> {
  const changes = readTexts(input.texts, true);
  const status = readStatus(input.status);
  const fieldId = await readFieldId(input.fieldId, await model.firstFieldId());

  const texts = Object.create(null) as Record<string, string>;
  for (const code of PACKAGE_LANGUAGE_CODES) texts[code] = "";
  for (const [code, text] of Object.entries(changes)) texts[code] = text;

  const id = await model.nextPackageId();
  await model.insertPackage(id, texts, status, fieldId);
  const row = await model.findPackageRow(id);
  if (!row) throw AppError.notFound("The new package type could not be read back.");
  return toDto(row);
}

/** Edit a package type: write only the languages that were supplied. */
export async function updatePackageType(
  id: number,
  input: PackageTypeUpdate,
): Promise<PackageTypeDto> {
  const row = await model.findPackageRow(id);
  if (!row) throw AppError.notFound(`No package type #${id}.`);

  const changes = readTexts(input.texts, false);
  const sets: { texts?: Record<string, string>; fieldId?: number } = {};

  if (Object.keys(changes).length) sets.texts = changes;
  if (input.fieldId !== undefined) {
    const fieldId = await readFieldId(input.fieldId, row.fieldId);
    if (fieldId !== row.fieldId) sets.fieldId = fieldId;
  }
  if (!sets.texts && sets.fieldId === undefined) {
    throw AppError.badRequest("Send the languages that changed, or a new delivery field.");
  }

  await model.updatePackage(id, sets);
  const after = await model.findPackageRow(id);
  if (!after) throw AppError.notFound(`No package type #${id}.`);
  return toDto(after);
}

/** Activate / deactivate: the apps stop offering an Inactive choice. */
export async function changeStatus(id: number, status: PackageStatus): Promise<PackageTypeDto> {
  const row = await model.findPackageRow(id);
  if (!row) throw AppError.notFound(`No package type #${id}.`);
  await model.setPackageStatus(id, readStatus(status));
  return getPackageType(id);
}

export interface DeleteResult {
  name: string;
  ongoingTrips: number;
  openBookings: number;
  openRequests: number;
  tripRecords: number;
}

/**
 * Name-confirmed soft delete. Live work referencing the type is refused, because
 * hiding it would take the label off an order the driver is still working.
 */
export async function deletePackageType(id: number, confirm: unknown): Promise<DeleteResult> {
  const row = await model.findPackageRow(id);
  if (!row) throw AppError.notFound(`No package type #${id}.`);

  const name = row.texts[PRIMARY_LANGUAGE]?.trim() || firstText(row) || `Package type #${row.id}`;
  const typed = asText(confirm).trim();
  if (!typed || typed !== name) {
    throw AppError.badRequest(`Type “${name}” exactly to delete this package type.`);
  }

  const usage = await model.countPackageUsage(id);
  const live = usage.ongoingTrips + usage.openBookings + usage.openRequests;
  if (live > 0) {
    throw AppError.badRequest(
      `This package type is on ${live} live trip(s) or open booking(s); deactivate it instead of deleting it.`,
    );
  }

  await model.softDeletePackage(id);
  return { name, ...usage };
}

/** Column limit the shared sanitizer would enforce, surfaced for docs and clients. */
export const PACKAGE_TEXT_CEILING = contentFieldLimit("text");
