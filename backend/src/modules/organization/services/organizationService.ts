import { AppError } from "../../../errors/AppError";
import { findContentViolation } from "../../../utils/contentSanitizer";
import { hashPassword } from "../../auth/services/passwordService";
import { listProfiles } from "../../ride-profile/services/rideProfileService";
import * as model from "../models/organizationModel";
import type { OrganizationStatus, PaymentOwner } from "../models/organizationModel";

/**
 * Business rules for organizations (group 7 → Manage Ride Profiles → #sub-17-p90).
 *
 * A row is a business account that books rides for its staff, so the screen touches
 * three groups at once: the company profile, where its bookings are filed (a ride
 * profile), and the payout block. The ceilings below are the real column widths of the
 * legacy table: the server runs under STRICT_TRANS_TABLES, so a longer value would be
 * refused by MySQL — the service refuses it first, with a message naming the field.
 *
 * Two things are deliberately absent: login credentials are never read back (only
 * written, as a new login pair), and the payout block never reaches the list payload or
 * the CSV export.
 */

/** Column widths of `organization`, read from information_schema. */
export const LIMITS = {
  company: 255,
  address: 255,
  city: 255,
  state: 255,
  zip: 255,
  country: 200,
  phone: 11,
  phoneCode: 10,
  email: 1000,
  paymentEmail: 500,
  accountHolder: 500,
  accountNumber: 500,
  bankName: 500,
  bankLocation: 500,
  swiftCode: 500,
  language: 10,
  currency: 10,
  location: 500,
  latitude: 50,
  longitude: 50,
  image: 255,
  coverImage: 255,
  loginId: 100,
} as const;

/** How each writable column is checked. `shape` narrows the allowed characters. */
interface FieldSpec {
  key: string;
  label: string;
  max: number;
  /** `text` is sanitized for invisible/injected content like any other admin copy. */
  kind: "text" | "email" | "phone" | "coord" | "file";
  required?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { key: "company", label: "Company name", max: LIMITS.company, kind: "text", required: true },
  { key: "email", label: "Email", max: LIMITS.email, kind: "email", required: true },
  { key: "phoneCode", label: "Phone code", max: LIMITS.phoneCode, kind: "phone" },
  { key: "phone", label: "Phone", max: LIMITS.phone, kind: "phone" },
  { key: "address", label: "Address", max: LIMITS.address, kind: "text" },
  { key: "city", label: "City", max: LIMITS.city, kind: "text" },
  { key: "state", label: "State", max: LIMITS.state, kind: "text" },
  { key: "zip", label: "ZIP / postal code", max: LIMITS.zip, kind: "text" },
  { key: "country", label: "Country", max: LIMITS.country, kind: "text" },
  { key: "language", label: "Language", max: LIMITS.language, kind: "text" },
  { key: "currency", label: "Currency", max: LIMITS.currency, kind: "text" },
  { key: "location", label: "Location", max: LIMITS.location, kind: "text" },
  { key: "latitude", label: "Latitude", max: LIMITS.latitude, kind: "coord" },
  { key: "longitude", label: "Longitude", max: LIMITS.longitude, kind: "coord" },
  { key: "image", label: "Logo", max: LIMITS.image, kind: "file" },
  { key: "coverImage", label: "Cover image", max: LIMITS.coverImage, kind: "file" },
  { key: "paymentEmail", label: "Payment email", max: LIMITS.paymentEmail, kind: "email" },
  { key: "accountHolder", label: "Account holder name", max: LIMITS.accountHolder, kind: "text" },
  { key: "accountNumber", label: "Account number", max: LIMITS.accountNumber, kind: "text" },
  { key: "bankName", label: "Bank name", max: LIMITS.bankName, kind: "text" },
  { key: "bankLocation", label: "Bank location", max: LIMITS.bankLocation, kind: "text" },
  { key: "swiftCode", label: "SWIFT code", max: LIMITS.swiftCode, kind: "text" },
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_SHAPE = /^[0-9+ ()-]+$/;
const COORD_SHAPE = /^-?[0-9]{1,3}(\.[0-9]{1,10})?$/;

/** A writable field, as the form sends it. */
export interface OrganizationInput {
  [key: string]: unknown;
  profileId?: unknown;
  paymentBy?: unknown;
  status?: unknown;
  password?: unknown;
  loginId?: unknown;
}

/** An organization as the screen sees it: the row, plus the profile's label. */
export interface OrganizationDto extends model.OrganizationRow {
  profileName: string;
}

/** A list row: no payout block, plus the profile's label. */
export type OrganizationListItem = model.OrganizationSummaryRow & { profileName: string };

/** One ride profile an organization can be filed under. */
export interface ProfileOption {
  id: number;
  name: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Reject anything that could escape the file-name column. */
function checkFileShape(name: string, label: string): string {
  if (name && (name.includes("/") || name.includes("\\") || name.includes(".."))) {
    throw AppError.badRequest(`${label} must be a bare file name, not a path.`);
  }
  return name;
}

/**
 * Validate one writable field. Absent keys are never returned, which is what makes a
 * patch a patch: an omitted field keeps its stored value instead of being blanked.
 */
function checkField(spec: FieldSpec, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const value = asText(raw).trim();
  if (value.length > spec.max) {
    throw AppError.badRequest(`${spec.label} must be at most ${spec.max} characters (got ${value.length}).`);
  }
  if (!value) {
    if (spec.required) throw AppError.badRequest(`${spec.label} is required.`);
    return "";
  }
  const violation = findContentViolation("text", value);
  if (violation) throw AppError.badRequest(`${spec.label} ${violation}.`);

  switch (spec.kind) {
    case "email":
      if (!EMAIL_SHAPE.test(value)) throw AppError.badRequest(`${spec.label} is not a valid email address.`);
      return value.toLowerCase();
    case "phone":
      if (!PHONE_SHAPE.test(value)) {
        throw AppError.badRequest(`${spec.label} may only contain digits and + ( ) - or a space.`);
      }
      return value;
    case "coord": {
      if (!COORD_SHAPE.test(value)) {
        throw AppError.badRequest(`${spec.label} must be a plain decimal coordinate, e.g. 12.9716.`);
      }
      const n = Number(value);
      const bound = spec.key === "latitude" ? 90 : 180;
      if (!Number.isFinite(n) || Math.abs(n) > bound) {
        throw AppError.badRequest(`${spec.label} must be between -${bound} and ${bound}.`);
      }
      return value;
    }
    case "file":
      return checkFileShape(value, spec.label);
    default:
      return value;
  }
}

/** Radius is an int column: clamp it rather than let MySQL truncate a float. */
function checkRadius(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0 || n > 100_000) {
    throw AppError.badRequest("Search radius must be a whole number of metres between 0 and 100000.");
  }
  return n;
}

function checkStatus(raw: unknown, fallback: OrganizationStatus): OrganizationStatus {
  if (raw === undefined) return fallback;
  if (raw !== "Active" && raw !== "Inactive") throw AppError.badRequest("Status must be Active or Inactive.");
  return raw;
}

function checkPaymentBy(raw: unknown, fallback: PaymentOwner): PaymentOwner {
  if (raw === undefined) return fallback;
  if (!model.PAYMENT_OWNERS.includes(raw as PaymentOwner)) {
    throw AppError.badRequest("Payment must be paid by Passenger or Organization.");
  }
  return raw as PaymentOwner;
}

/**
 * Resolve the ride profile an organization books under. The legacy column has no
 * foreign key, so existence is checked against the live profile list; `current` lets an
 * edit that never touched the picker keep a link that may since have been deleted,
 * rather than silently rewriting it.
 */
async function resolveProfile(raw: unknown, options: ProfileOption[], current: number): Promise<number> {
  if (raw === undefined || raw === null || raw === "") {
    if (!options.length) {
      throw AppError.badRequest("There is no ride profile to file an organization under yet.");
    }
    if (current > 0 && options.some((o) => o.id === current)) return current;
    return options[0].id;
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("Invalid ride profile.");
  if (!options.some((o) => o.id === id)) {
    throw AppError.badRequest("That ride profile does not exist or is deleted.");
  }
  return id;
}

/** Live ride profiles, for the picker and for validating a chosen one. */
async function profileOptions(): Promise<ProfileOption[]> {
  const rows = await listProfiles();
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

function labelFor(options: ProfileOption[], id: number): string {
  return options.find((o) => o.id === id)?.name || (id > 0 ? `Profile #${id}` : "— no profile —");
}

/** Project a full row down to a list item. Only the named fields leave, so a list
 * payload can never carry the payout block. */
function toListItem(row: model.OrganizationRow, options: ProfileOption[]): OrganizationListItem {
  return {
    id: row.id,
    company: row.company,
    email: row.email,
    phone: row.phone,
    phoneCode: row.phoneCode,
    address: row.address,
    city: row.city,
    country: row.country,
    status: row.status,
    paymentBy: row.paymentBy,
    profileId: row.profileId,
    image: row.image,
    registeredAt: row.registeredAt,
    profileName: labelFor(options, row.profileId),
  };
}

/** All live organizations, oldest first. */
export async function listOrganizations(): Promise<OrganizationListItem[]> {
  const [rows, options] = await Promise.all([model.listOrganizations(), profileOptions()]);
  return rows.map((r) => toListItem(r, options));
}

const MAX_LIMIT = 200;

export interface OrganizationPage {
  rows: OrganizationListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One filtered page, with the totals the pager needs. */
export async function listOrganizationsPaged(raw: {
  search?: unknown;
  status?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<OrganizationPage> {
  const search = asText(raw.search).trim();
  const status =
    raw.status === "Active" || raw.status === "Inactive" ? (raw.status as OrganizationStatus) : undefined;
  const page = Math.max(Math.trunc(Number(raw.page ?? 1)) || 1, 1);
  const limit = Math.min(Math.max(Math.trunc(Number(raw.limit ?? 50)) || 50, 1), MAX_LIMIT);

  const [total, rows, options] = await Promise.all([
    model.countOrganizations({ search, status }),
    model.listOrganizationPage({ search, status, limit, offset: (page - 1) * limit }),
    profileOptions(),
  ]);
  return {
    rows: rows.map((r) => toListItem(r, options)),
    total,
    page,
    limit,
    pages: Math.max(Math.ceil(total / limit), 1),
  };
}

/** One organization, payout block included (the edit form needs it). */
export async function getOrganization(id: number): Promise<OrganizationDto> {
  const [row, options] = await Promise.all([model.findOrganization(id), profileOptions()]);
  if (!row) throw AppError.notFound(`No organization #${id}.`);
  return { ...row, profileName: labelFor(options, row.profileId) };
}

/** Ride profiles, for the picker on both the add and the edit form. */
export async function listProfileOptions(): Promise<ProfileOption[]> {
  return profileOptions();
}

/** What the add form starts from, so the defaults are the DB's own. */
export async function blankRecord(): Promise<OrganizationDto> {
  const options = await profileOptions();
  return {
    id: 0,
    company: "",
    email: "",
    phone: "",
    phoneCode: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    country: "",
    status: "Active",
    paymentBy: "Passenger",
    profileId: options[0]?.id ?? 0,
    image: "",
    coverImage: "",
    location: "",
    latitude: "",
    longitude: "",
    language: "EN",
    currency: "",
    radius: 0,
    emailVerified: "No",
    phoneVerified: "No",
    paymentEmail: "",
    accountHolder: "",
    accountNumber: "",
    bankName: "",
    bankLocation: "",
    swiftCode: "",
    registeredAt: null,
    profileName: labelFor(options, options[0]?.id ?? 0),
  };
}

/** Add an organization. Everything not sent keeps its legacy empty default. */
export async function createOrganization(input: OrganizationInput): Promise<OrganizationDto> {
  const sets = readFields(input, true);
  const radius = checkRadius(input.radius) ?? 0;

  const options = await profileOptions();
  const profileId = await resolveProfile(input.profileId, options, 0);
  const status = checkStatus(input.status, "Active");
  const paymentBy = checkPaymentBy(input.paymentBy, "Passenger");

  const email = String(sets.email);
  if (await model.emailTaken(email)) {
    throw AppError.badRequest("That email is already used by an organization.");
  }

  const password = asText(input.password);
  const passwordHash = password ? await hashPassword(password) : "";
  // A password is useless without a login name, so the two move together. The legacy
  // panel signs organizations in with `vLoginId`, and the email is the only identifier
  // this screen has to offer; without a password both columns stay empty, which leaves
  // the new account able to be managed but not able to sign in.
  const loginId = password ? checkField(LOGIN_SPEC, input.loginId ?? email) ?? "" : "";

  const text = (key: string): string => (sets[key] === undefined ? "" : String(sets[key]));
  const id = await model.nextOrganizationId();
  await model.createOrganization({
    id,
    status,
    profileId,
    paymentBy,
    loginId,
    passwordHash,
    company: text("company"),
    email,
    phone: text("phone"),
    phoneCode: text("phoneCode"),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    country: text("country"),
    language: text("language"),
    currency: text("currency"),
    location: text("location"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    radius,
    image: text("image"),
    coverImage: text("coverImage"),
  });

  return getOrganization(id);
}

/** The login name column is writable only alongside a password. */
const LOGIN_SPEC: FieldSpec = {
  key: "loginId",
  label: "Login name",
  max: LIMITS.loginId,
  kind: "text",
};

/** Validate every writable field the request names, keyed by DTO name. */
function readFields(input: OrganizationInput, required: boolean): Record<string, string | number> {
  const sets: Record<string, string | number> = {};
  for (const spec of FIELDS) {
    const value = checkField(spec, input[spec.key]);
    if (value === undefined) {
      if (required && spec.required) throw AppError.badRequest(`${spec.label} is required.`);
      continue;
    }
    sets[spec.key] = value;
  }
  return sets;
}

/**
 * Edit an organization: only the fields the request names are written, in one UPDATE.
 * A password (and its login name) moves through its own statement, so the generic
 * column map can never be used to reach a credential column.
 */
export async function updateOrganization(id: number, input: OrganizationInput): Promise<OrganizationDto> {
  const current = await model.findOrganization(id);
  if (!current) throw AppError.notFound(`No organization #${id}.`);

  const sets = readFields(input, false);
  const radius = checkRadius(input.radius);
  if (radius !== undefined) sets.radius = radius;

  const options = await profileOptions();
  // A patch that does not name a profile leaves the filing alone. Legacy rows include
  // accounts filed under no profile (id 0) or a since-deleted one, and resolving an
  // absent value would silently move them onto the first live profile.
  const profileId =
    input.profileId === undefined
      ? current.profileId
      : await resolveProfile(input.profileId, options, current.profileId);
  const paymentBy = checkPaymentBy(input.paymentBy, current.paymentBy as PaymentOwner);
  const status = input.status === undefined ? undefined : checkStatus(input.status, current.status);

  if (sets.email !== undefined && (await model.emailTaken(String(sets.email), id))) {
    throw AppError.badRequest("That email is already used by another organization.");
  }

  const changed =
    Object.keys(sets).length > 0 || profileId !== current.profileId || paymentBy !== current.paymentBy;
  if (changed) {
    await model.updateOrganization(id, {
      sets,
      profileId: profileId === current.profileId ? undefined : profileId,
      paymentBy: paymentBy === current.paymentBy ? undefined : paymentBy,
    });
  }
  if (status !== undefined && status !== current.status) {
    await model.setOrganizationStatus(id, status);
  }

  const password = asText(input.password);
  if (password) {
    const hash = await hashPassword(password);
    const login = checkField(LOGIN_SPEC, input.loginId ?? current.email) ?? "";
    await model.setOrganizationLogin(id, login, hash);
  }

  return getOrganization(id);
}

/** Activate / deactivate an organization account. */
export async function changeStatus(id: number, status: OrganizationStatus): Promise<OrganizationDto> {
  const row = await model.findOrganization(id);
  if (!row) throw AppError.notFound(`No organization #${id}.`);
  await model.setOrganizationStatus(id, checkStatus(status, row.status));
  return getOrganization(id);
}

export interface DeleteResult {
  name: string;
  ongoingTrips: number;
  openBookings: number;
  tripRecords: number;
  outstandingRows: number;
}

/**
 * Name-confirmed soft delete. Live work blocks it outright; finished trips and the
 * outstanding ledger are reported back so the admin sees what the row still anchors.
 */
export async function deleteOrganization(id: number, confirm: unknown): Promise<DeleteResult> {
  const row = await model.findOrganization(id);
  if (!row) throw AppError.notFound(`No organization #${id}.`);

  const typed = asText(confirm).trim();
  if (!typed || typed !== row.company) {
    throw AppError.badRequest(`Type “${row.company}” exactly to delete this organization.`);
  }

  const usage = await model.countOrganizationUsage(id);
  if (usage.ongoingTrips + usage.openBookings > 0) {
    throw AppError.badRequest(
      `This organization still has ${usage.ongoingTrips} ongoing trip(s) and ${usage.openBookings} open booking(s); ` +
        `deactivate it instead of deleting it.`,
    );
  }

  await model.softDeleteOrganization(id);
  return { name: row.company, ...usage };
}

/**
 * Export rows, mirroring the on-screen listing. The payout block is not part of it on
 * purpose: an exported file leaves the admin's control, and bank details do not need to
 * travel with a company directory.
 */
export const CSV_HEADER = [
  "ID",
  "Organization",
  "Email",
  "Phone",
  "Address",
  "City",
  "Country",
  "Ride Profile",
  "Paid By",
  "Status",
  "Registered",
] as const;

export async function csvRows(): Promise<string[][]> {
  const rows = await listOrganizations();
  return rows.map((r) => [
    String(r.id),
    r.company,
    r.email,
    `${r.phoneCode} ${r.phone}`.trim(),
    r.address,
    r.city,
    r.country,
    r.profileName,
    r.paymentBy,
    r.status,
    r.registeredAt ?? "",
  ]);
}

// ---------------------------------------------------------------------------
// Artwork. `image` and `coverImage` each store a bare file name the apps concatenate
// into an image URL, so an upload writes its bytes into this app's upload root (under the
// same folder name the legacy panel used) and points the column at the new name. A name
// that came from the old panel still reads — the media helper falls back to the read-only
// legacy directory — and is never deleted from disk.
// ---------------------------------------------------------------------------

/** The two artwork columns, named exactly as the DTO names them. */
export const ORGANIZATION_MEDIA_KEYS = ["image", "coverImage"] as const;
export type OrganizationMediaKey = (typeof ORGANIZATION_MEDIA_KEYS)[number];

/** An unknown column name is a 400, not something to ignore. */
function mediaKey(key: unknown): OrganizationMediaKey {
  const wanted = asText(key).trim();
  if (!(ORGANIZATION_MEDIA_KEYS as readonly string[]).includes(wanted)) {
    throw AppError.badRequest(`Unknown image field: “${wanted}”.`);
  }
  return wanted as OrganizationMediaKey;
}

/**
 * The bare file name one artwork column currently holds. Reading it through the row
 * scope-checks the id, so the stream endpoint 404s for a deleted organization before it
 * touches the disk; an empty string means no picture.
 */
export async function getMediaFilename(id: number, key: unknown): Promise<string> {
  const field = mediaKey(key);
  const row = await model.findOrganization(id);
  if (!row) throw AppError.notFound(`No organization #${id}.`);
  return asText(row[field]).trim();
}

/** Point one artwork column at a newly stored file name. */
export async function setMediaFilename(
  id: number,
  key: unknown,
  filename: string,
): Promise<OrganizationDto> {
  const field = mediaKey(key);
  const row = await model.findOrganization(id);
  if (!row) throw AppError.notFound(`No organization #${id}.`);
  if (filename.length > LIMITS[field]) {
    throw AppError.badRequest(
      `An image file name must be at most ${LIMITS[field]} characters (got ${filename.length}).`,
    );
  }

  await model.updateOrganization(id, { sets: { [field]: filename } });
  return getOrganization(id);
}

/** The writable keys the route agrees to accept. */
export const ORGANIZATION_FIELD_KEYS = FIELDS.map((f) => f.key);
