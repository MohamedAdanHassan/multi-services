import { AppError } from "../../../errors/AppError";
import * as model from "../models/adBannersModel";
import type {
  AdBannerRow,
  AdBannerStatus,
  ImpressionMode,
  ValidityMode,
} from "../models/adBannersModel";

/**
 * Business rules for advertisement banners (Marketing Tools → Advertisement
 * Banners, #sub-109, legacy `advertise_banners`).
 *
 * The two coupled field pairs are enforced here so the stored row can never
 * contradict itself:
 *  - `eImpression` = Limited ⇒ `iImpression` is a positive cap; Unlimited ⇒
 *    the cap is stored as 0 (any value sent by the client is ignored).
 *  - `eValidityType` = Custom ⇒ both `dStartDate` and `dExpiryDate` are real
 *    dates with expiry ≥ start; Permanent ⇒ the expiry column (which cannot be
 *    NULL) holds the 9999-12-31 sentinel and the DTO reports no expiry.
 *
 * The status is owned by the listing toggle and the image by the multipart
 * upload route, so neither is part of the create/edit payload. Omitted modes
 * fall back to the column defaults (`eImpression` 'Limited', `eValidityType`
 * 'Custom'), so their paired value then becomes required too.
 */

const MAX_TITLE_LEN = 255; // vBannerTitle
const MAX_URL_LEN = 2_000; // tRedirectUrl is TEXT — a practical cap instead

/** API shape for one banner. */
export interface BannerDto {
  id: number;
  title: string;
  image: string;
  redirectUrl: string;
  position: string;
  impressionMode: ImpressionMode;
  impressionCap: number;
  impressionsServed: number;
  validityMode: ValidityMode;
  startDate: string;
  /** '' for Permanent banners (the stored value is a sentinel, not a date). */
  expiryDate: string;
  displayOrder: number;
  addedDate: string;
  status: AdBannerStatus;
}

function toDto(row: AdBannerRow): BannerDto {
  const permanent = row.validityMode === "Permanent";
  return {
    id: row.id,
    title: row.title,
    image: row.image,
    redirectUrl: row.redirectUrl,
    position: row.position,
    impressionMode: row.impressionMode,
    impressionCap: row.impressionMode === "Limited" ? row.impressionCap : 0,
    impressionsServed: row.impressionsServed,
    validityMode: row.validityMode,
    startDate: row.startDate,
    expiryDate: permanent ? "" : row.expiryDate,
    displayOrder: row.displayOrder,
    addedDate: row.addedDate,
    status: row.status,
  };
}

function cleanTitle(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw AppError.badRequest("Title is required.");
  if (text.length > MAX_TITLE_LEN) {
    throw AppError.badRequest(`Title must be at most ${MAX_TITLE_LEN} characters.`);
  }
  return text;
}

function cleanUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) {
    throw AppError.badRequest("Redirect URL must start with http:// or https://");
  }
  if (text.length > MAX_URL_LEN) {
    throw AppError.badRequest(`Redirect URL must be at most ${MAX_URL_LEN} characters.`);
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

function cleanOrder(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), 9999);
}

function cleanImpressionMode(value: unknown): ImpressionMode {
  return value === "Unlimited" ? "Unlimited" : "Limited";
}

function cleanValidityMode(value: unknown): ValidityMode {
  return value === "Permanent" ? "Permanent" : "Custom";
}

function cleanStatus(value: unknown): AdBannerStatus {
  return value === "Inactive" ? "Inactive" : "Active";
}

/** Cap + mode resolved together: Unlimited always stores 0. */
function resolveImpression(mode: ImpressionMode, rawCap: unknown): number {
  if (mode === "Unlimited") return 0;
  const n = Number(rawCap);
  if (!Number.isFinite(n) || Math.trunc(n) < 1) {
    throw AppError.badRequest(
      "Impression limit must be a whole number of at least 1 when impressions are Limited.",
    );
  }
  return Math.min(Math.trunc(n), 10_000_000);
}

/** Start/expiry resolved with the validity mode. */
function resolveValidity(mode: ValidityMode, rawStart: unknown, rawExpiry: unknown) {
  const startDate = cleanDate("Start date", rawStart);
  if (mode === "Permanent") {
    return { startDate, expiryDate: model.PERMANENT_EXPIRY };
  }
  const expiryDate = cleanDate("Expiry date", rawExpiry);
  if (expiryDate < startDate) {
    throw AppError.badRequest("Expiry date cannot be before the start date.");
  }
  return { startDate, expiryDate };
}

async function mustFind(id: number): Promise<AdBannerRow> {
  const row = await model.findBanner(id);
  if (!row) throw AppError.notFound(`Banner #${id} not found.`);
  return row;
}

export async function listBanners(): Promise<BannerDto[]> {
  const rows = await model.listBanners();
  return rows.map(toDto);
}

export async function getBanner(id: number): Promise<BannerDto> {
  return toDto(await mustFind(id));
}

/** Normalised write payload shared by create and edit (throws on bad input). */
interface ResolvedWrite {
  title: string;
  redirectUrl: string;
  impressionMode: ImpressionMode;
  impressionCap: number;
  validityMode: ValidityMode;
  startDate: string;
  expiryDate: string;
  displayOrder: number;
}

function resolveWrite(input: {
  title: unknown;
  redirectUrl?: unknown;
  impressionMode?: unknown;
  impressionCap?: unknown;
  validityMode?: unknown;
  startDate?: unknown;
  expiryDate?: unknown;
  displayOrder?: unknown;
}): ResolvedWrite {
  const title = cleanTitle(input.title);
  const redirectUrl = cleanUrl(input.redirectUrl);
  const validityMode = cleanValidityMode(input.validityMode);
  // The dates are resolved before the impression cap: an omitted `impressionMode`
  // falls back to the column default ('Limited'), and its missing cap must not
  // mask a date problem in the same payload.
  const validity = resolveValidity(validityMode, input.startDate, input.expiryDate);
  const impressionMode = cleanImpressionMode(input.impressionMode);
  const impressionCap = resolveImpression(impressionMode, input.impressionCap);
  return {
    title,
    redirectUrl,
    impressionMode,
    impressionCap,
    validityMode,
    ...validity,
    displayOrder: cleanOrder(input.displayOrder),
  };
}

export async function createBanner(input: {
  title: unknown;
  redirectUrl?: unknown;
  impressionMode?: unknown;
  impressionCap?: unknown;
  validityMode?: unknown;
  startDate?: unknown;
  expiryDate?: unknown;
  displayOrder?: unknown;
  status?: unknown;
}): Promise<BannerDto> {
  const write = resolveWrite(input);
  const id = await model.nextBannerId();
  await model.createBanner(id, { ...write, image: "", status: cleanStatus(input.status) });
  return toDto(await mustFind(id));
}

/** Edit: everything except the stored image and the status. */
export async function updateBanner(
  id: number,
  input: {
    title: unknown;
    redirectUrl?: unknown;
    impressionMode?: unknown;
    impressionCap?: unknown;
    validityMode?: unknown;
    startDate?: unknown;
    expiryDate?: unknown;
    displayOrder?: unknown;
  },
): Promise<BannerDto> {
  await mustFind(id);
  await model.updateBanner(id, resolveWrite(input));
  return toDto(await mustFind(id));
}

export async function changeStatus(id: number, status: AdBannerStatus): Promise<BannerDto> {
  const row = await mustFind(id);
  if (row.status !== status) await model.setBannerStatus(id, status);
  return toDto(await mustFind(id));
}

/** Hard delete (the enum has no 'Deleted' member) — banner_impression rows stay. */
export async function deleteBanner(id: number): Promise<void> {
  await mustFind(id);
  await model.deleteBanner(id);
}
