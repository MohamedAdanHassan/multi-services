import { AppError } from "../../../errors/AppError";
import * as model from "../models/promoCodesModel";
import type {
  DiscountType,
  OptionRow,
  PromoRow,
  PromoStatusCode,
  PromoType,
  PromoValidity,
  StoreScope,
  SystemType,
} from "../models/promoCodesModel";

/**
 * Business rules for promo codes (Marketing Tools → Promocode, #sub-110, legacy
 * `coupon`).
 *
 * Coupled field pairs enforced here so a stored row can never contradict
 * itself:
 *  - `eValidityType` = Permanent ⇒ both `dActiveDate` and `dExpiryDate` are the
 *    legacy zero date (the DDL default, and what all four shipped rows use);
 *    Defined ⇒ both are real dates with expiry ≥ active. The DTO reports ''
 *    for a zero date, which the UI words as "No start" / "No end".
 *  - `eType` = percentage ⇒ 0 < `fDiscount` ≤ 100; cash ⇒ 0 < `fDiscount` ≤
 *    9,999,999.99 (the float(10,2) ceiling). Always rounded to 2 decimals.
 *  - `eStoreType` = StoreSpecific ⇒ `iCompanyId` must name an active store;
 *    '' and 'All' ⇒ the company id is stored as 0 (any client value ignored).
 *  - `iUsageLimit` = 0 means unlimited, matching the column default; the
 *    redemption count stays the legacy `iUsed` column, which this module never
 *    writes (the apps increment it).
 *
 * The code itself is normalised to upper case and must be unique across every
 * row INCLUDING soft-deleted ones — redemptions in `trips` / `orders` /
 * `payment_mode_user_log` store the code string, so re-issuing a retired code
 * would hand that coupon's whole redemption history to the newcomer. This is a
 * deliberate departure from the users/drivers lists, which ignore 'Deleted'
 * rows when checking an email.
 *
 * Status belongs to the PATCH /status route (and 'Deleted' to DELETE), so the
 * create/edit payload never carries it beyond the create-time default.
 */

const MAX_CODE_LEN = 50; // vCouponCode varchar(50)
const MAX_DESC_LEN = 2_000; // tDescription is longtext; keep it sane
/** float(10,2): eight integer digits and two decimals. */
const MAX_CASH_DISCOUNT = 9_999_999.99;

/** Language texts keyed by code ("EN" → text), parsed from a legacy blob. */
type TextMap = Record<string, string>;

/** Same read-modify-write shape the donation blobs use (donationService). */
function parseMultilingual(raw: string, prefix: string): TextMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: TextMap = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith(`${prefix}_`)) out[key.slice(prefix.length + 1)] = String(value ?? "");
    }
    return out;
  } catch {
    // Defensive: a plain-text (non-JSON) legacy value is treated as English.
    return { EN: raw };
  }
}

function serializeMultilingual(texts: TextMap, prefix: string): string {
  const obj: Record<string, string> = {};
  for (const [code, text] of Object.entries(texts)) {
    if (code) obj[`${prefix}_${code}`] = text;
  }
  return JSON.stringify(obj);
}

/** API shape for one promo code. */
export interface PromoDto {
  id: number;
  code: string;
  /** English text pulled out of the multilingual `tDescription` blob. */
  description: string;
  discount: number;
  discountType: DiscountType;
  validity: PromoValidity;
  /** '' for Permanent codes (the stored value is the legacy zero date). */
  activeDate: string;
  expiryDate: string;
  usageLimit: number;
  used: number;
  /** False when unlimited; true once `used` has reached a finite limit. */
  exhausted: boolean;
  status: PromoStatusCode;
  systemType: SystemType;
  fly: boolean;
  promoType: PromoType;
  storeScope: StoreScope;
  companyId: number;
  storeName: string;
  serviceId: number;
  serviceName: string;
  locationId: number;
  locationName: string;
  freeDelivery: boolean;
}

function toDto(row: PromoRow): PromoDto {
  return {
    id: row.id,
    code: row.code,
    description: (parseMultilingual(row.rawDescription, "tDescription")["EN"] ?? "").trim(),
    discount: row.discount,
    discountType: row.discountType,
    validity: row.validity,
    activeDate: row.validity === "Permanent" ? "" : row.activeDate,
    expiryDate: row.validity === "Permanent" ? "" : row.expiryDate,
    usageLimit: row.usageLimit,
    used: row.used,
    exhausted: row.usageLimit > 0 && row.used >= row.usageLimit,
    status: row.status === "Inactive" ? "Inactive" : "Active",
    systemType: row.systemType,
    fly: row.fly,
    promoType: row.promoType,
    storeScope: row.storeScope,
    companyId: row.storeScope === "StoreSpecific" ? row.companyId : 0,
    storeName: row.storeScope === "StoreSpecific" ? row.storeName : "",
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    locationId: row.locationId,
    locationName: row.locationId === 0 ? "" : row.locationName,
    freeDelivery: row.freeDelivery,
  };
}

// ---------------------------------------------------------------------------
// Field cleaners
// ---------------------------------------------------------------------------

function cleanCode(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) throw AppError.badRequest("Promo code is required.");
  if (text.length > MAX_CODE_LEN) {
    throw AppError.badRequest(`Promo code must be at most ${MAX_CODE_LEN} characters.`);
  }
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(text)) {
    throw AppError.badRequest("Promo code may only contain letters, digits, hyphens and underscores, and must start with a letter or digit.");
  }
  return text;
}

function cleanDescription(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text.length > MAX_DESC_LEN) {
    throw AppError.badRequest(`Description must be at most ${MAX_DESC_LEN} characters.`);
  }
  return text;
}

function cleanDate(name: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw AppError.badRequest(`${name} is required.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${name} must be a YYYY-MM-DD date.`);
  }
  const [year, month, day] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw AppError.badRequest(`${name} is not a real calendar date.`);
  }
  return text;
}

/** Discount + its type resolved together, so a percentage can never exceed 100. */
function resolveDiscount(type: DiscountType, raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw AppError.badRequest("Discount must be a number greater than 0.");
  }
  const rounded = Math.round(n * 100) / 100;
  if (type === "percentage" && rounded > 100) {
    throw AppError.badRequest("A percentage discount cannot exceed 100.");
  }
  if (rounded > MAX_CASH_DISCOUNT) {
    throw AppError.badRequest(`Discount must be at most ${MAX_CASH_DISCOUNT}.`);
  }
  return rounded;
}

/** Usage limit: 0 = unlimited, matching the column default. */
function cleanUsageLimit(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw AppError.badRequest("Usage limit must be a whole number of uses, or 0 for unlimited.");
  }
  return Math.min(n, 1_000_000_000);
}

function cleanValidity(value: unknown): PromoValidity {
  return value === "Defined" ? "Defined" : "Permanent";
}

function cleanDiscountType(value: unknown): DiscountType {
  return value === "cash" ? "cash" : "percentage";
}

function cleanSystemType(value: unknown): SystemType {
  const known: SystemType[] = ["Ride", "Delivery", "UberX", "DeliverAll", "General"];
  return (known as string[]).includes(String(value)) ? (value as SystemType) : "General";
}

function cleanPromoType(value: unknown): PromoType {
  return value === "Private" ? "Private" : "Public";
}

function cleanStoreScope(value: unknown): StoreScope {
  return value === "All" || value === "StoreSpecific" ? (value as StoreScope) : "";
}

function cleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function cleanId(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Statuses a coupon can be shown/toggled as ('Deleted' is the delete path). */
function cleanStatus(value: unknown): PromoStatusCode {
  return value === "Inactive" ? "Inactive" : "Active";
}

/**
 * Validity pair. Permanent writes the legacy zero dates; Defined writes real
 * ones — both columns are NOT NULL, so neither may be left out.
 */
function resolveValidity(validity: PromoValidity, rawActive: unknown, rawExpiry: unknown) {
  if (validity === "Permanent") {
    return { activeDate: model.NO_DATE, expiryDate: model.NO_DATE };
  }
  const activeDate = cleanDate("Start date", rawActive);
  const expiryDate = cleanDate("Expiry date", rawExpiry);
  if (expiryDate < activeDate) {
    throw AppError.badRequest("Expiry date cannot be before the start date.");
  }
  return { activeDate, expiryDate };
}

async function mustFind(id: number): Promise<PromoRow> {
  const row = await model.findPromo(id);
  if (!row) throw AppError.notFound(`Promo code #${id} not found.`);
  return row;
}

/** Reject a code already taken, including by a soft-deleted coupon. */
async function assertCodeFree(code: string, selfId?: number): Promise<void> {
  const taken = await model.findPromoByCode(code);
  if (taken && taken.id !== selfId) {
    throw AppError.badRequest(
      `The code ${code} is already used by promo code #${taken.id}` +
        (taken.status === "Deleted" ? " (a deleted coupon)" : "") +
        ". Codes stay reserved because redemptions reference them.",
    );
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listPromos(): Promise<PromoDto[]> {
  return (await model.listPromos()).map(toDto);
}

export async function getPromo(id: number): Promise<PromoDto> {
  return toDto(await mustFind(id));
}

/** Reference lists for the form's scope selects. */
export async function getOptions(): Promise<{
  services: OptionRow[];
  locations: OptionRow[];
  stores: OptionRow[];
}> {
  const [services, locations, stores] = await Promise.all([
    model.listServiceOptions(),
    model.listLocationOptions(),
    model.listStoreOptions(),
  ]);
  return { services, locations, stores };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Raw create/edit payload, exactly as the route hands it over. */
export interface PromoInput {
  code: unknown;
  description?: unknown;
  discount?: unknown;
  discountType?: unknown;
  validity?: unknown;
  activeDate?: unknown;
  expiryDate?: unknown;
  usageLimit?: unknown;
  systemType?: unknown;
  fly?: unknown;
  promoType?: unknown;
  storeScope?: unknown;
  companyId?: unknown;
  serviceId?: unknown;
  freeDelivery?: unknown;
  locationId?: unknown;
}

/** Everything the model needs is validated and coerced by `resolveWrite`. */
type ResolvedWrite = model.PromoWrite;

/** `existingDescription` is the row's own blob, so other languages survive an edit. */
async function resolveWrite(
  input: PromoInput & { existingDescription?: string },
): Promise<ResolvedWrite> {
  const code = cleanCode(input.code);
  const discountType = cleanDiscountType(input.discountType);
  const discount = resolveDiscount(discountType, input.discount);
  // Validity before the ids: a payload with both a bad window and a bad scope
  // should report the window, which is the more specific mistake.
  const validity = cleanValidity(input.validity);
  const dates = resolveValidity(validity, input.activeDate, input.expiryDate);

  const serviceId = cleanId(input.serviceId);
  if (!serviceId || !(await model.serviceExists(serviceId))) {
    throw AppError.badRequest("Pick an active service for this promo code.");
  }

  const locationId = cleanId(input.locationId);
  if (locationId && !(await model.locationExists(locationId))) {
    throw AppError.badRequest("The selected location no longer exists.");
  }

  const storeScope = cleanStoreScope(input.storeScope);
  let companyId = 0;
  if (storeScope === "StoreSpecific") {
    companyId = cleanId(input.companyId);
    if (!companyId || !(await model.storeExists(companyId))) {
      throw AppError.badRequest("Pick an active store, or set the store scope to something else.");
    }
  }

  // English text replaces itself; every other language already on the row is
  // carried over untouched.
  const texts = parseMultilingual(input.existingDescription ?? "", "tDescription");
  texts["EN"] = cleanDescription(input.description);

  return {
    code,
    description: serializeMultilingual(texts, "tDescription"),
    discount,
    discountType,
    validity,
    ...dates,
    usageLimit: cleanUsageLimit(input.usageLimit),
    systemType: cleanSystemType(input.systemType),
    fly: cleanFlag(input.fly),
    promoType: cleanPromoType(input.promoType),
    storeScope,
    companyId,
    serviceId,
    freeDelivery: cleanFlag(input.freeDelivery),
    locationId,
  };
}

export async function createPromo(
  input: PromoInput & { status?: unknown },
): Promise<PromoDto> {
  const write = await resolveWrite(input);
  await assertCodeFree(write.code);
  const id = await model.nextPromoId();
  await model.createPromo(id, write, cleanStatus(input.status));
  return toDto(await mustFind(id));
}

/** Edit: everything except the status and the redemption counter. */
export async function updatePromo(
  id: number,
  input: PromoInput,
): Promise<PromoDto> {
  const current = await mustFind(id);
  const write = await resolveWrite({ ...input, existingDescription: current.rawDescription });
  await assertCodeFree(write.code, id);
  await model.updatePromo(id, write);
  return toDto(await mustFind(id));
}

export async function changeStatus(id: number, status: PromoStatusCode): Promise<PromoDto> {
  const row = await mustFind(id);
  if (row.status !== status) await model.setPromoStatus(id, status);
  return toDto(await mustFind(id));
}

/** Soft delete (the enum has a 'Deleted' member) — the row and its history stay. */
export async function deletePromo(id: number): Promise<void> {
  await mustFind(id);
  await model.deletePromo(id);
}

// ---------------------------------------------------------------------------
// Export (#sub-110 `export-promocode`)
// ---------------------------------------------------------------------------

export interface PromoFilters {
  status?: unknown;
  search?: unknown;
}

/**
 * Filter the DTOs the same way the listing does — the predicate is shared by
 * the on-screen table, so an exported CSV always matches what the admin sees.
 */
export function filterPromos(dtos: PromoDto[], filters: PromoFilters): PromoDto[] {
  const status = String(filters.status ?? "all").trim();
  const term = String(filters.search ?? "").trim().toLowerCase();
  return dtos.filter((p) => {
    if (status !== "all" && status !== "" && p.status !== status) return false;
    if (!term) return true;
    return (
      p.code.toLowerCase().includes(term) ||
      p.description.toLowerCase().includes(term) ||
      p.serviceName.toLowerCase().includes(term) ||
      p.locationName.toLowerCase().includes(term) ||
      p.storeName.toLowerCase().includes(term)
    );
  });
}

export async function exportPromos(filters: PromoFilters): Promise<PromoDto[]> {
  return filterPromos(await listPromos(), filters);
}
