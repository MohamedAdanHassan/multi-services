import { execute, query } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";

/**
 * Data access for the legacy `organization` table (Taxi Service → Manage Ride
 * Profiles → Organizations, #sub-17-p90). One row is a business account that books
 * rides for its staff: the company details, the contact, the payout bank block, and
 * the ride profile its bookings are filed under.
 *
 * Two facts drive the shape of everything here:
 *
 * - the table has no primary key and no auto-increment, so a new id comes from
 *   `MAX(iOrganizationId)+1` and each statement is a single one;
 * - it mixes profile data with login credentials (`vLoginId`, `vPassword`, two
 *   password-reset tokens, an email-verification code, device and session ids). Those
 *   columns are never selected and never returned: a listing or export that reads
 *   `SELECT *` would leak live password hashes, so every statement names its columns
 *   explicitly and `SAFE_COLUMNS` is the only source. The one credential write this
 *   screen makes is `setOrganizationLogin`, which stores a new login name and its
 *   bcrypt digest together — it never reads a hash back out.
 *
 * `trips`, `cab_booking`, `cab_request_now`, `user_profile` and
 * `trip_outstanding_amount` all store `iOrganizationId`, so deletes are soft
 * (`eStatus='Deleted'`) — the ledger and the trip history keep their owner.
 */

export type OrganizationStatus = "Active" | "Inactive";

/** Live organizations; `Deleted` rows are hidden everywhere. */
const SCOPE = "eStatus <> 'Deleted'";

/**
 * Listing + detail columns. Credentials are simply not named here: `vLoginId`,
 * `vPassword`, both password-reset tokens, the email-verification code, the device
 * and session ids and the push token stay out of every statement this module builds,
 * so no listing, detail or export can leak them.
 *
 * The payout block (`vAcctNo`, `vSwiftCode`, …) IS read, because the admin edits the
 * organization's own bank details here; it is kept out of the CSV export.
 */
const SAFE_COLUMNS = `o.iOrganizationId AS id, o.iUserProfileMasterId AS profileId,
       o.vCompany AS company, o.vCaddress AS address, o.vCity AS city,
       o.vState AS state, o.vZip AS zip, o.vCountry AS country,
       o.vCode AS phoneCode, o.vPhone AS phone, o.vEmail AS email,
       o.vImage AS image, o.vCoverImage AS coverImage,
       o.vLocation AS location, o.vLocationLat AS latitude, o.vLocationLong AS longitude,
       o.vLang AS language, o.vCurrency AS currency, o.vRadius AS radius,
       o.eStatus, o.ePaymentBy AS paymentBy,
       o.eEmailVerified AS emailVerified, o.ePhoneVerified AS phoneVerified,
       o.vPaymentEmail AS paymentEmail, o.vAcctHolderName AS accountHolder,
       o.vAcctNo AS accountNumber, o.vBankName AS bankName,
       o.vBankLocation AS bankLocation, o.vSwiftCode AS swiftCode,
       DATE_FORMAT(o.tRegistrationDate, '%Y-%m-%d') AS registeredAt` as const;

/**
 * Who pays for the organization's rides. The reports module splits the outstanding
 * ledger on exactly this column, so it is editable but bounded to the DDL enum.
 */
export const PAYMENT_OWNERS = ["Passenger", "Organization"] as const;
export type PaymentOwner = (typeof PAYMENT_OWNERS)[number];

/** Listing shape — no payout block, so a list payload can never carry bank details. */
export interface OrganizationSummaryRow {
  id: number;
  company: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  country: string;
  status: OrganizationStatus;
  paymentBy: string;
  profileId: number;
  image: string;
  registeredAt: string | null;
}

/** Detail shape: the listing block plus the location block and the payout block. */
export interface OrganizationRow extends OrganizationSummaryRow {
  state: string;
  zip: string;
  latitude: string;
  longitude: string;
  location: string;
  language: string;
  currency: string;
  radius: number;
  emailVerified: string;
  phoneVerified: string;
  coverImage: string;
  /** Payout block — read and edited here, but never part of the CSV export. */
  paymentEmail: string;
  accountHolder: string;
  accountNumber: string;
  bankName: string;
  bankLocation: string;
  swiftCode: string;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(value: unknown): OrganizationStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/** Zero-dates and NULLs both read as "no date" to this screen. */
function cleanDate(value: unknown): string | null {
  const text = str(value).trim();
  if (!text || text.startsWith("0000")) return null;
  return text;
}

function mapOrganization(r: Record<string, unknown>): OrganizationRow {
  return {
    id: num(r.id),
    company: str(r.company).trim(),
    email: str(r.email).trim(),
    phone: str(r.phone).trim(),
    phoneCode: str(r.phoneCode).trim(),
    city: str(r.city).trim(),
    country: str(r.country).trim(),
    status: mapStatus(r.eStatus),
    paymentBy: str(r.paymentBy),
    image: str(r.image).trim(),
    coverImage: str(r.coverImage).trim(),
    registeredAt: cleanDate(r.registeredAt),
    address: str(r.address).trim(),
    state: str(r.state).trim(),
    zip: str(r.zip).trim(),
    latitude: str(r.latitude).trim(),
    longitude: str(r.longitude).trim(),
    location: str(r.location).trim(),
    language: str(r.language).trim(),
    currency: str(r.currency).trim(),
    radius: num(r.radius),
    profileId: num(r.profileId),
    emailVerified: str(r.emailVerified),
    phoneVerified: str(r.phoneVerified),
    paymentEmail: str(r.paymentEmail).trim(),
    accountHolder: str(r.accountHolder).trim(),
    accountNumber: str(r.accountNumber).trim(),
    bankName: str(r.bankName).trim(),
    bankLocation: str(r.bankLocation).trim(),
    swiftCode: str(r.swiftCode).trim(),
  };
}

const LIST_ORDER = "ORDER BY o.iOrganizationId";

/** All live organizations, oldest first. */
export async function listOrganizations(): Promise<OrganizationRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SAFE_COLUMNS} FROM organization o WHERE ${SCOPE} ${LIST_ORDER}`,
  );
  return rows.map(mapOrganization);
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Shared WHERE fragment + params for page/count so they never drift. Search covers
 * the company name, email and phone — the three things an admin remembers.
 */
function buildFilters(f: { search: string; status?: OrganizationStatus }): {
  where: string;
  params: unknown[];
} {
  const clauses = [SCOPE];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("o.eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push("(o.vCompany LIKE ? OR o.vEmail LIKE ? OR o.vPhone LIKE ?)");
    const p = likePattern(f.search);
    params.push(p, p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One filtered page of organizations. */
export async function listOrganizationPage(filters: {
  search: string;
  status?: OrganizationStatus;
  limit: number;
  offset: number;
}): Promise<OrganizationRow[]> {
  const { where, params } = buildFilters(filters);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SAFE_COLUMNS} FROM organization o ${where} ${LIST_ORDER} LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return rows.map(mapOrganization);
}

/** Total live organizations matching the same filters. */
export async function countOrganizations(filters: {
  search: string;
  status?: OrganizationStatus;
}): Promise<number> {
  const { where, params } = buildFilters(filters);
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM organization o ${where}`,
    params,
  );
  return num(rows[0]?.n);
}

/** One live organization, or null. */
export async function findOrganization(id: number): Promise<OrganizationRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SAFE_COLUMNS} FROM organization o WHERE o.iOrganizationId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
  return rows.length ? mapOrganization(rows[0]) : null;
}

/** There is no auto-increment, so the new id is the highest one in use, plus one. */
export async function nextOrganizationId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT COALESCE(MAX(iOrganizationId), 0) AS max FROM organization",
  );
  return num(rows[0]?.max) + 1;
}

/**
 * Every NOT NULL column of `organization` that lacks a DB default. The server runs
 * under STRICT_TRANS_TABLES (with NO_ZERO_DATE), so an INSERT must supply each one —
 * and a zero date is refused, which is why the legacy placeholder `1000-01-01` is
 * used for the one date column a new organization has.
 */
export const REQUIRED_COLUMNS: { col: string; def: string }[] = [
  { col: "iUserProfileMasterId", def: "0" },
  { col: "vLoginId", def: "''" },
  { col: "vPassword", def: "''" },
  { col: "vImage", def: "''" },
  { col: "vCoverImage", def: "''" },
  { col: "vCompany", def: "''" },
  { col: "vCaddress", def: "''" },
  { col: "vCity", def: "''" },
  { col: "vState", def: "''" },
  { col: "vZip", def: "''" },
  { col: "vInviteCode", def: "''" },
  { col: "dBirthDate", def: "'1000-01-01'" },
  { col: "vBackCheck", def: "''" },
  { col: "vEmail", def: "''" },
  { col: "vPhone", def: "''" },
  { col: "vLang", def: "''" },
  { col: "vCurrency", def: "''" },
  { col: "vCountry", def: "''" },
  { col: "vCode", def: "''" },
  { col: "vLocation", def: "''" },
  { col: "vLocationLat", def: "''" },
  { col: "vLocationLong", def: "''" },
  { col: "vNoc", def: "''" },
  { col: "vCerti", def: "''" },
  { col: "vPasswordToken", def: "''" },
  { col: "vPassword_token", def: "''" },
  { col: "vRadius", def: "0" },
  { col: "vPaymentEmail", def: "''" },
  { col: "vAcctHolderName", def: "''" },
  { col: "vAcctNo", def: "''" },
  { col: "vBankName", def: "''" },
  { col: "vBankLocation", def: "''" },
  { col: "vSwiftCode", def: "''" },
  { col: "vAvgRating", def: "''" },
  { col: "iGcmRegId", def: "''" },
  { col: "vFirebaseDeviceToken", def: "''" },
  { col: "vTimeZone", def: "''" },
  { col: "tSessionId", def: "''" },
  { col: "tDeviceSessionId", def: "''" },
  { col: "iAppVersion", def: "0" },
  { col: "dSendverificationDate", def: "NOW()" },
  { col: "vEmailVarificationCode", def: "''" },
];

/** Columns a create may take from the request, mapped to their physical names. */
export interface CreateOrganizationInput {
  id: number;
  status: OrganizationStatus;
  profileId: number;
  company: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  language: string;
  currency: string;
  location: string;
  latitude: string;
  longitude: string;
  radius: number;
  image: string;
  coverImage: string;
  paymentBy: PaymentOwner;
  /** Login name for the legacy organization panel; empty leaves the account unable to sign in. */
  loginId: string;
  /** Already-hashed bcrypt digest, or empty when no password was supplied. */
  passwordHash: string;
}

/**
 * Insert a new organization, filling every strict-mode NOT NULL column explicitly.
 * The credential columns the admin did not supply keep their legacy empty defaults,
 * which leaves the account unable to log in rather than able to log in weakly.
 */
export async function createOrganization(input: CreateOrganizationInput): Promise<void> {
  const overrides: Record<string, string | number> = {
    iUserProfileMasterId: input.profileId,
    vCompany: input.company,
    vEmail: input.email,
    vPhone: input.phone,
    vCode: input.phoneCode,
    vCaddress: input.address,
    vCity: input.city,
    vState: input.state,
    vZip: input.zip,
    vCountry: input.country,
    vLang: input.language,
    vCurrency: input.currency,
    vLocation: input.location,
    vLocationLat: input.latitude,
    vLocationLong: input.longitude,
    vRadius: input.radius,
    vImage: input.image,
    vCoverImage: input.coverImage,
    vLoginId: input.loginId,
    vPassword: input.passwordHash,
  };

  const cols = ["iOrganizationId", "eStatus", "ePaymentBy", ...REQUIRED_COLUMNS.map((c) => c.col)];
  const placeholders: string[] = ["?", "?", "?"];
  const params: (string | number)[] = [input.id, input.status, input.paymentBy];

  for (const c of REQUIRED_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(overrides, c.col)) {
      placeholders.push("?");
      params.push(overrides[c.col]);
    } else {
      placeholders.push(c.def);
    }
  }

  await execute(
    `INSERT INTO organization (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
    params,
  );
}

/** Editable profile + payout columns, keyed by DTO name. Never credentials. */
export const WRITABLE_COLUMNS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    company: "vCompany",
    address: "vCaddress",
    city: "vCity",
    state: "vState",
    zip: "vZip",
    country: "vCountry",
    phoneCode: "vCode",
    phone: "vPhone",
    email: "vEmail",
    location: "vLocation",
    latitude: "vLocationLat",
    longitude: "vLocationLong",
    language: "vLang",
    currency: "vCurrency",
    radius: "vRadius",
    image: "vImage",
    coverImage: "vCoverImage",
    paymentEmail: "vPaymentEmail",
    accountHolder: "vAcctHolderName",
    accountNumber: "vAcctNo",
    bankName: "vBankName",
    bankLocation: "vBankLocation",
    swiftCode: "vSwiftCode",
  },
);

export interface UpdateOrganizationInput {
  [key: string]: unknown;
  sets?: Record<string, string | number>;
  profileId?: number;
  paymentBy?: PaymentOwner;
}

/**
 * Write the changed columns in one UPDATE. `sets` keys must be DTO names in
 * `WRITABLE_COLUMNS`, so a client can neither reach a credential column nor invent
 * one: the physical name is looked up here, never taken from the request.
 */
export async function updateOrganization(
  id: number,
  input: UpdateOrganizationInput,
): Promise<void> {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  for (const [key, value] of Object.entries(input.sets ?? {})) {
    const column = WRITABLE_COLUMNS[key];
    if (!column) throw AppError.badRequest(`Field “${key}” is not editable here.`);
    parts.push(`${column} = ?`);
    params.push(value);
  }
  if (input.profileId !== undefined) {
    parts.push("iUserProfileMasterId = ?");
    params.push(input.profileId);
  }
  if (input.paymentBy !== undefined) {
    parts.push("ePaymentBy = ?");
    params.push(input.paymentBy);
  }
  if (!parts.length) return;

  params.push(id);
  await execute(
    `UPDATE organization SET ${parts.join(", ")} WHERE iOrganizationId = ? AND ${SCOPE} LIMIT 1`,
    params,
  );
}

export async function setOrganizationStatus(
  id: number,
  status: OrganizationStatus,
): Promise<void> {
  await execute(
    `UPDATE organization SET eStatus = ? WHERE iOrganizationId = ? AND ${SCOPE} LIMIT 1`,
    [status, id],
  );
}

/**
 * Set a new login for the organization. Both columns move together: a password with
 * no login name could not be signed in with, and the digest is never read back by any
 * statement in this module.
 */
export async function setOrganizationLogin(
  id: number,
  loginId: string,
  passwordHash: string,
): Promise<void> {
  await execute(
    `UPDATE organization SET vLoginId = ?, vPassword = ? WHERE iOrganizationId = ? AND ${SCOPE} LIMIT 1`,
    [loginId, passwordHash, id],
  );
}

/** Soft delete: the ledger and trips keep pointing at the organization. */
export async function softDeleteOrganization(id: number): Promise<void> {
  await execute(
    `UPDATE organization SET eStatus = 'Deleted' WHERE iOrganizationId = ? AND ${SCOPE} LIMIT 1`,
    [id],
  );
}

/**
 * What still references the organization. Only live work blocks a delete; finished
 * trips and the outstanding balance are reported so the admin knows what the row is
 * holding up before hiding it.
 */
export async function countOrganizationUsage(id: number): Promise<{
  ongoingTrips: number;
  openBookings: number;
  tripRecords: number;
  outstandingRows: number;
}> {
  const rows = await query<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM trips WHERE iOrganizationId = ? AND iActive IN ('On Going Trip', 'Arrived')) AS ongoing_trips,
       (SELECT COUNT(*) FROM cab_booking WHERE iOrganizationId = ? AND eStatus IN ('Pending', 'Assign', 'Accepted')) AS open_bookings,
       (SELECT COUNT(*) FROM trips WHERE iOrganizationId = ?) AS trip_records,
       (SELECT COUNT(*) FROM trip_outstanding_amount WHERE iOrganizationId = ?) AS outstanding_rows`,
    [id, id, id, id],
  );
  const r = rows[0] ?? {};
  return {
    ongoingTrips: num(r.ongoing_trips),
    openBookings: num(r.open_bookings),
    tripRecords: num(r.trip_records),
    outstandingRows: num(r.outstanding_rows),
  };
}

/** True when a live organization already owns this email (blank emails never clash). */
export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptId
    ? `SELECT 1 AS hit FROM organization WHERE vEmail = ? AND ${SCOPE} AND iOrganizationId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM organization WHERE vEmail = ? AND ${SCOPE} LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}
