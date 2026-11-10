import { AppError } from "../../../errors/AppError";
import * as model from "../models/giftCardImagesModel";
import type { GiftCardImageRow, ImageStatus } from "../models/giftCardImagesModel";

/**
 * Business rules for the gift card artwork (#sub-111, `*-giftcard-image`).
 *
 * The table is a design × language matrix and the same file is named by every
 * language's row for a design, so two things follow: an image row is edited as
 * one cell of that matrix (the panel picks the language first), and a file may
 * only leave the disk when no row still names it. Deleting a row is soft and
 * keeps its `vImage`, so the delete path never touches a file at all.
 */

const MAX_ORDER = 9_999;

export interface GiftCardImageDto {
  id: number;
  image: string;
  hasFile: boolean;
  status: string;
  displayOrder: number;
  addedDate: string;
  code: string;
  /** How many live cards are printed with this design. */
  usedBy: number;
}

function toDto(r: GiftCardImageRow, usedBy: number): GiftCardImageDto {
  return {
    id: r.id,
    image: r.image,
    hasFile: r.image !== "",
    status: r.status,
    displayOrder: r.displayOrder,
    addedDate: r.addedDate,
    code: r.code,
    usedBy,
  };
}

async function cleanCode(value: unknown): Promise<string> {
  const wanted = String(value ?? "").trim().toUpperCase();
  if (!wanted) throw AppError.badRequest("Choose which language's design set this row belongs to.");
  const known = await languageOptions();
  const match = known.find((l) => l.code.toUpperCase() === wanted);
  if (!match) {
    throw AppError.badRequest(`"${wanted}" is not a language this installation knows.`);
  }
  // Matched case-insensitively, stored with the source's own spelling, so the
  // value keeps agreeing with what the apps already write into `vCode`.
  return match.code;
}

function cleanOrder(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) throw AppError.badRequest("Display order is required. It decides the slot this design fills.");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.badRequest("Display order must be a whole number starting at 1.");
  }
  if (n > MAX_ORDER) throw AppError.badRequest(`Display order must be at most ${MAX_ORDER}.`);
  return n;
}

async function mustFind(id: number): Promise<GiftCardImageRow> {
  const row = await model.findImage(id);
  if (!row) throw AppError.notFound(`Gift card image #${id} not found.`);
  return row;
}

/** A picker entry: `language_master` plus any slice only the matrix knows. */
export interface PageLanguage extends model.LanguageOption {
  /** False when the code exists only in `gift_card_images` (SL in this dataset). */
  inMaster: boolean;
}

/**
 * Every language the artwork matrix can be filtered by. The master drives the
 * order and the labels, but the table itself is consulted too — otherwise a code
 * with no master row would have designs that can never be listed or corrected.
 */
async function languageOptions(): Promise<PageLanguage[]> {
  const master = await model.listLanguages();
  const seen = new Set(master.map((l) => l.code.toUpperCase()));
  const matrix = await model.listMatrixCodes();
  const orphans = matrix
    .filter((c) => !seen.has(c.toUpperCase()))
    .map((c) => ({ code: c, title: c, titleEn: c, active: false, isDefault: false, inMaster: false }));
  return [...master.map((l) => ({ ...l, inMaster: true })), ...orphans];
}

/** One language's slice of the matrix, plus the picker's language list. */
export async function getPage(code?: string): Promise<{
  code: string;
  languages: PageLanguage[];
  images: GiftCardImageDto[];
}> {
  const languages = await languageOptions();
  const wanted = String(code ?? "").trim().toUpperCase();
  const active =
    languages.find((l) => l.code.toUpperCase() === wanted)?.code ??
    languages.find((l) => l.isDefault)?.code ??
    languages[0]?.code ??
    "EN";
  const [used, rows] = await Promise.all([model.cardUsageCounts(), model.listImages(active)]);
  return {
    code: active,
    languages,
    images: rows.map((r) => toDto(r, Number(used[r.id] ?? 0))),
  };
}

export async function getImage(id: number): Promise<GiftCardImageDto> {
  const row = await mustFind(id);
  const used = await model.cardUsageCounts();
  return toDto(row, Number(used[row.id] ?? 0));
}

export async function createImage(input: {
  code: unknown;
  displayOrder: unknown;
  status?: unknown;
}): Promise<GiftCardImageDto> {
  const code = await cleanCode(input.code);
  const displayOrder = cleanOrder(input.displayOrder);
  const status: ImageStatus = String(input.status ?? "").trim() === "Inactive" ? "Inactive" : "Active";
  const id = await model.nextImageId();
  await model.createImage(id, { code, displayOrder, image: "" }, status);
  return getImage(id);
}

export async function updateImage(
  id: number,
  input: { code: unknown; displayOrder: unknown },
): Promise<GiftCardImageDto> {
  const current = await mustFind(id);
  const code = await cleanCode(input.code);
  const displayOrder = cleanOrder(input.displayOrder);
  await model.updateImage(id, { code, displayOrder, image: current.image });
  return getImage(id);
}

export async function changeStatus(id: number, status: ImageStatus): Promise<GiftCardImageDto> {
  await mustFind(id);
  await model.setImageStatus(id, status);
  return getImage(id);
}

/**
 * Soft delete. The file stays: the row keeps naming it, so a retired design is
 * still a valid reference for anything that already points at it.
 */
export async function deleteImage(id: number): Promise<void> {
  await mustFind(id);
  await model.deleteImage(id);
}

/**
 * Point a row at a newly uploaded file. Returns the filename the row used before
 * and whether that file may be removed from disk — it may not while another
 * language's row shares the same artwork.
 */
export async function replaceFile(
  id: number,
  filename: string,
): Promise<{ previous: string; removable: boolean }> {
  const row = await mustFind(id);
  if (row.image === filename) return { previous: "", removable: false };
  await model.setImageFile(id, filename);
  if (!row.image) return { previous: "", removable: false };
  const others = await model.countFileReferences(row.image, id);
  return { previous: row.image, removable: others === 0 };
}
