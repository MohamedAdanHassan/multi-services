import { AppError } from "../../../errors/AppError";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";
import * as model from "../models/donationModel";
import type { DonationRow, DonationStatus } from "../models/donationModel";

/**
 * Business rules for donations (Utility → Donation, #sub-160).
 *
 * The legacy columns `tTitle` / `tDescription` hold per-language JSON maps
 * (`{"tTitle_EN":"…","tTitle_AR":"…"}`). Edits from the main form only ever
 * touch the English entries; everything else is preserved on read-modify-
 * write. The translation editor merges whole batches by language code.
 */

const MAX_TITLE_LEN = 500;
const MAX_DESC_LEN = 5_000;
const MAX_LINK_LEN = 2_000;

/** Language texts keyed by code ("EN" → text), parsed from a legacy blob. */
export type TextMap = Record<string, string>;

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

function cleanText(name: string, value: unknown, maxLen: number, required: boolean): string {
  const text = String(value ?? "").trim();
  if (required && !text) throw AppError.badRequest(`${name} is required.`);
  if (text.length > maxLen) {
    throw AppError.badRequest(`${name} must be at most ${maxLen} characters.`);
  }
  return text;
}

function cleanOrder(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), 9999);
}

async function mustFind(id: number): Promise<DonationRow> {
  const row = await model.findDonation(id);
  if (!row) throw AppError.notFound(`Donation #${id} not found.`);
  return row;
}

/** API shape: English texts extracted from the multilingual blobs. */
export interface DonationDto {
  id: number;
  title: string;
  description: string;
  link: string;
  image: string;
  displayOrder: number;
  status: DonationStatus;
  createdAt: string | null;
}

function toDto(row: DonationRow): DonationDto {
  return {
    id: row.id,
    title: (parseMultilingual(row.rawTitle, "tTitle")["EN"] ?? "").trim(),
    description: (parseMultilingual(row.rawDescription, "tDescription")["EN"] ?? "").trim(),
    link: row.link,
    image: row.image,
    displayOrder: row.displayOrder,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function listDonations(): Promise<DonationDto[]> {
  const rows = await model.listDonations();
  return rows.map(toDto);
}

export async function getDonation(id: number): Promise<DonationDto> {
  return toDto(await mustFind(id));
}

export async function createDonation(input: {
  title: unknown;
  description: unknown;
  link?: unknown;
  displayOrder?: unknown;
  status?: DonationStatus;
}): Promise<DonationDto> {
  const title = cleanText("Title", input.title, MAX_TITLE_LEN, true);
  const description = cleanText("Description", input.description, MAX_DESC_LEN, false);
  const link = cleanText("Link", input.link, MAX_LINK_LEN, false);
  const id = await model.nextDonationId();
  await model.createDonation(id, {
    // Seed only the English entries; other languages come via the editor.
    title: serializeMultilingual({ EN: title }, "tTitle"),
    description: serializeMultilingual({ EN: description }, "tDescription"),
    link,
    image: "",
    displayOrder: cleanOrder(input.displayOrder),
    status: input.status === "Inactive" ? "Inactive" : "Active",
  });
  return toDto(await mustFind(id));
}

/** Main-form edit: overwrite the English texts, keep every other language. */
export async function updateDonation(
  id: number,
  input: { title: unknown; description: unknown; link?: unknown; displayOrder?: unknown },
): Promise<DonationDto> {
  const row = await mustFind(id);
  const title = cleanText("Title", input.title, MAX_TITLE_LEN, true);
  const description = cleanText("Description", input.description, MAX_DESC_LEN, false);
  const link = cleanText("Link", input.link, MAX_LINK_LEN, false);

  const titles = parseMultilingual(row.rawTitle, "tTitle");
  titles["EN"] = title;
  const descriptions = parseMultilingual(row.rawDescription, "tDescription");
  descriptions["EN"] = description;

  await model.updateDonation(id, {
    title: serializeMultilingual(titles, "tTitle"),
    description: serializeMultilingual(descriptions, "tDescription"),
    link,
    displayOrder: cleanOrder(input.displayOrder),
  });
  return toDto(await mustFind(id));
}

export interface DonationTranslation {
  code: string;
  label: string;
  title: string;
  description: string;
}

/**
 * All per-language texts, ordered by the shared translation language list.
 * Codes present in the stored JSON but unknown to that list are appended so
 * no legacy translation becomes uneditable.
 */
export async function getTranslations(id: number): Promise<DonationTranslation[]> {
  const row = await mustFind(id);
  const titles = parseMultilingual(row.rawTitle, "tTitle");
  const descriptions = parseMultilingual(row.rawDescription, "tDescription");
  const known = new Set<string>(TRANSLATION_LANGUAGES.map((l) => l.code as string));

  const items: DonationTranslation[] = TRANSLATION_LANGUAGES.map(({ code, label }) => ({
    code,
    label,
    title: (titles[code] ?? "").trim(),
    description: (descriptions[code] ?? "").trim(),
  }));
  const labels = new Map<string, string>(TRANSLATION_LANGUAGES.map((l) => [l.code as string, l.label]));
  for (const code of new Set([...Object.keys(titles), ...Object.keys(descriptions)])) {
    if (!known.has(code)) {
      items.push({
        code,
        label: labels.get(code) ?? code,
        title: (titles[code] ?? "").trim(),
        description: (descriptions[code] ?? "").trim(),
      });
    }
  }
  return items;
}

/** Merge a batch of per-language texts; empty strings clear a language. */
export async function updateTranslations(
  id: number,
  batch: { titles?: Record<string, unknown>; descriptions?: Record<string, unknown> },
): Promise<DonationDto> {
  const row = await mustFind(id);
  const titles = parseMultilingual(row.rawTitle, "tTitle");
  const descriptions = parseMultilingual(row.rawDescription, "tDescription");

  for (const [code, value] of Object.entries(batch.titles ?? {})) {
    if (!code || code.includes("_")) throw AppError.badRequest(`Invalid language code: “${code}”.`);
    const text = cleanText(`Title (${code})`, value, MAX_TITLE_LEN, false);
    if (text || titles[code] === undefined) titles[code] = text;
    else delete titles[code];
  }
  for (const [code, value] of Object.entries(batch.descriptions ?? {})) {
    if (!code || code.includes("_")) throw AppError.badRequest(`Invalid language code: “${code}”.`);
    const text = cleanText(`Description (${code})`, value, MAX_DESC_LEN, false);
    if (text || descriptions[code] === undefined) descriptions[code] = text;
    else delete descriptions[code];
  }
  if (!(titles["EN"] ?? "").trim()) throw AppError.badRequest("English title must stay non-empty.");

  await model.updateRawTexts(
    id,
    serializeMultilingual(titles, "tTitle"),
    serializeMultilingual(descriptions, "tDescription"),
  );
  return toDto(await mustFind(id));
}

export async function changeStatus(id: number, status: DonationStatus): Promise<DonationDto> {
  const row = await mustFind(id);
  if (row.status !== status) await model.setDonationStatus(id, status);
  return toDto(await mustFind(id));
}

/** Donations are terminal content (nothing references their ids) — soft delete. */
export async function deleteDonation(id: number): Promise<void> {
  await mustFind(id);
  await model.softDeleteDonation(id);
}
