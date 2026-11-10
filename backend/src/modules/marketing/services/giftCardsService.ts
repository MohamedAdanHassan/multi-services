import { AppError } from "../../../errors/AppError";
import * as model from "../models/giftCardsModel";
import type {
  GiftCardAudience,
  GiftCardRow,
  GiftCardStatus,
  GiftCardWrite,
  ReceiverKind,
} from "../models/giftCardsModel";
import * as images from "../models/giftCardImagesModel";

/**
 * Business rules for gift cards (#sub-111). The legacy table ships empty, so
 * these rules are written from the column types plus the behaviour the sibling
 * marketing modules already established: refuse what the storage would silently
 * mutate, never invent a value the apps own, and keep retired rows' identifiers
 * reserved.
 */

const MAX_CODE_LEN = 255; // vGiftCardCode varchar(255)
const MAX_TEXT_LEN = 2_000; // tReceiverDetails / tDescription are `text`
/** decimal(10,4): ten digits in total, four after the point, so six integer ones. */
const MAX_AMOUNT = 999_999.9999;
const MAX_AMOUNT_DECIMALS = 4;

export interface GiftCardDto {
  id: number;
  code: string;
  amount: number;
  status: string;
  addedDate: string;
  createdById: number;
  createdBy: string;
  receiverDetails: string;
  description: string;
  imageId: number;
  imageName: string;
  imageCode: string;
  audience: GiftCardAudience;
  memberId: number;
  memberName: string;
  receiverId: number;
  receiverName: string;
  receiverKind: ReceiverKind;
  /** Who the card is aimed at, in the words the listing shows. */
  recipientLabel: string;
  paymentId: number;
  paymentOption: string;
  redeemed: boolean;
  redeemedDate: string;
}

function toDto(r: GiftCardRow): GiftCardDto {
  const recipientLabel =
    r.audience === "UserSpecific"
      ? r.memberName || `Rider #${r.memberId}`
      : r.audience === "DriverSpecific"
        ? r.receiverName || `Driver #${r.receiverId}`
        : "Anyone";
  return { ...r, recipientLabel };
}

function cleanCode(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) throw AppError.badRequest("Gift card code is required.");
  if (/\s/.test(text)) {
    throw AppError.badRequest("Gift card code cannot contain spaces — users type it at checkout.");
  }
  if (text.length > MAX_CODE_LEN) {
    throw AppError.badRequest(`Gift card code must be at most ${MAX_CODE_LEN} characters.`);
  }
  return text;
}

/**
 * Amounts keep exactly what was typed. The column is decimal(10,4), so a fifth
 * decimal would be silently rounded by MySQL and a larger value truncated —
 * both are refused instead of stored wrong.
 */
function cleanAmount(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw AppError.badRequest(
      "Amount is required. Enter 0 to issue a card with no value yet.",
    );
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || Number.isNaN(amount)) {
    throw AppError.badRequest("Amount must be a number.");
  }
  if (amount < 0) throw AppError.badRequest("Amount cannot be negative.");
  if (amount > MAX_AMOUNT) {
    throw AppError.badRequest(`Amount must be at most ${MAX_AMOUNT} (the column is decimal(10,4)).`);
  }
  const decimals = (raw.split(".")[1] ?? "").length;
  if (decimals > MAX_AMOUNT_DECIMALS) {
    throw AppError.badRequest(
      `Amount can have at most ${MAX_AMOUNT_DECIMALS} decimal places (the column is decimal(10,4)).`,
    );
  }
  return amount;
}

function cleanText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (text.length > MAX_TEXT_LEN) {
    throw AppError.badRequest(`${label} must be at most ${MAX_TEXT_LEN} characters.`);
  }
  return text;
}

function cleanId(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function cleanAudience(value: unknown): GiftCardAudience {
  const raw = String(value ?? "").trim();
  if (raw === "" || raw === "Anyone") return "Anyone";
  if (raw === "UserSpecific" || raw === "DriverSpecific") return raw;
  throw AppError.badRequest("Audience must be Anyone, a specific rider or a specific driver.");
}

/**
 * One recipient rule drives three columns, so they are resolved together:
 * the audience decides which id is filled, and the account kind follows.
 * `eReceiverUserType` has no "not applicable" member, so Anyone keeps the
 * legacy 'Passenger' value and nothing reads it unless the audience is specific.
 */
async function resolveRecipient(audience: GiftCardAudience, memberId: number, receiverId: number) {
  if (audience === "UserSpecific") {
    if (!memberId) throw AppError.badRequest("Choose the rider this card is reserved for.");
    const member = await model.findMember(memberId);
    if (!member) throw AppError.badRequest(`Rider #${memberId} does not exist.`);
    return { memberId, receiverId: 0, receiverKind: "Passenger" as ReceiverKind };
  }
  if (audience === "DriverSpecific") {
    if (!receiverId) throw AppError.badRequest("Choose the driver this card is reserved for.");
    const driver = await model.findDriver(receiverId);
    if (!driver) throw AppError.badRequest(`Driver #${receiverId} does not exist.`);
    return { memberId: 0, receiverId, receiverKind: "Driver" as ReceiverKind };
  }
  return { memberId: 0, receiverId: 0, receiverKind: "Passenger" as ReceiverKind };
}

async function cleanImageId(value: unknown): Promise<number> {
  const id = cleanId(value);
  if (!id) return 0;
  const row = await model.findImageRow(id);
  if (!row) throw AppError.badRequest(`Card artwork #${id} does not exist.`);
  if (row.status === "Deleted") {
    throw AppError.badRequest(`Card artwork #${id} is retired. Pick another design.`);
  }
  return id;
}

/** A code is reserved for as long as its row exists — a soft-deleted card still
 *  blocks it, because redemptions reference the code string. */
async function assertCodeFree(code: string, selfId: number): Promise<void> {
  const existing = await model.findCardByCode(code);
  if (existing && existing.id !== selfId) {
    const state = existing.status === "Deleted" ? " (a retired card still reserves it)" : "";
    throw AppError.badRequest(
      `Gift card code "${code}" is already used by card #${existing.id}${state}.`,
    );
  }
}

/** Raw request fields — every one is validated and coerced below. */
export interface CardInput {
  code: unknown;
  amount: unknown;
  audience?: unknown;
  memberId?: unknown;
  receiverId?: unknown;
  receiverDetails?: unknown;
  description?: unknown;
  imageId?: unknown;
}

async function resolveWrite(input: CardInput, selfId: number): Promise<GiftCardWrite> {
  const code = cleanCode(input.code);
  const amount = cleanAmount(input.amount);
  const audience = cleanAudience(input.audience);
  const recipient = await resolveRecipient(
    audience,
    cleanId(input.memberId),
    cleanId(input.receiverId),
  );
  await assertCodeFree(code, selfId);
  return {
    code,
    amount,
    audience,
    ...recipient,
    receiverDetails: cleanText(input.receiverDetails, "Recipient details"),
    description: cleanText(input.description, "Message on the card"),
    imageId: await cleanImageId(input.imageId),
  };
}

export interface CardFilters {
  status?: string;
  redeemed?: string;
  search?: string;
}

/** Every card the admin can act on. */
export async function listCards(): Promise<GiftCardDto[]> {
  return (await model.listCards()).map(toDto);
}

export async function getCard(id: number): Promise<GiftCardDto> {
  return toDto(await mustFind(id));
}

/** Applied in the service so the listing and the CSV path stay in sync. The
 *  table holds one row per issued card, which is admin-scale filtering in memory. */
export function filterCards(dtos: GiftCardDto[], filters: CardFilters): GiftCardDto[] {
  const status = String(filters.status ?? "all").trim();
  const redeemed = String(filters.redeemed ?? "all").trim();
  const term = String(filters.search ?? "").trim().toLowerCase();
  return dtos.filter((c) => {
    if (status !== "all" && c.status !== status) return false;
    if (redeemed === "Yes" && !c.redeemed) return false;
    if (redeemed === "No" && c.redeemed) return false;
    if (term) {
      const haystack = `${c.code} ${c.recipientLabel} ${c.receiverDetails} ${c.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

async function mustFind(id: number): Promise<GiftCardRow> {
  const row = await model.findCard(id);
  if (!row) throw AppError.notFound(`Gift card #${id} not found.`);
  return row;
}

export async function createCard(
  input: CardInput,
  status: GiftCardStatus,
  createdById: number,
): Promise<GiftCardDto> {
  const write = await resolveWrite(input, 0);
  const id = await model.nextCardId();
  await model.createCard(id, write, { status, createdById });
  return toDto(await mustFind(id));
}

export async function updateCard(id: number, input: CardInput): Promise<GiftCardDto> {
  await mustFind(id);
  const write = await resolveWrite(input, id);
  await model.updateCard(id, write);
  return toDto(await mustFind(id));
}

export async function changeStatus(id: number, status: GiftCardStatus): Promise<GiftCardDto> {
  await mustFind(id);
  await model.setCardStatus(id, status);
  return toDto(await mustFind(id));
}

/** Soft delete. A redeemed card can still be retired; the row keeps the history. */
export async function deleteCard(id: number): Promise<void> {
  await mustFind(id);
  await model.deleteCard(id);
}

/**
 * What the card form needs to render its selects. `currentImageId` is the design
 * a card being edited already points at, so that row stays in the option list
 * even when it belongs to another language's slice of the artwork matrix.
 */
export async function getCardOptions(currentImageId = 0) {
  const designs = await images.listDesignOptions(cleanId(currentImageId));
  return {
    designs: designs.map((d) => ({
      id: d.id,
      image: d.image,
      code: d.code,
      displayOrder: d.displayOrder,
    })),
  };
}
