import { AppError } from "../../../errors/AppError";
import { TRANSLATION_LANGUAGES } from "../../documents/models/documentsModel";
import * as model from "../models/newsModel";
import type { NewsAudience, NewsRow, NewsStatus, NewsType } from "../models/newsModel";

/**
 * Business rules for News (Marketing Tools → News, #sub-112).
 *
 * `vTitle` and `tDescription` are per-language JSON maps
 * (`{"vTitle_EN":"…","vTitle_AR":"…"}`), one row carrying all 26 languages this
 * installation ships. The main form only ever replaces the English entries;
 * everything else on the row is carried over on read-modify-write, and the
 * translation editor merges whole batches by language code. The helpers are the
 * same shape the donation and promo modules use for their blobs.
 */

const MAX_TITLE_LEN = 500;
const MAX_DESC_LEN = 5_000;
/** `vNewfeedImage` is varchar(250) — a generated name never gets near it. */
const MAX_IMAGE_LEN = 250;

const TITLE_PREFIX = "vTitle";
const DESC_PREFIX = "tDescription";

type TextMap = Record<string, string>;

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

/** Enum guards: an unknown value is a client bug, never a silent default. */
function cleanStatus(name: string, value: unknown): NewsStatus {
  if (value === undefined || value === null) return "Active";
  if (value !== "Active" && value !== "Inactive") {
    throw AppError.badRequest(`${name} must be Active or Inactive.`);
  }
  return value;
}

function cleanType(value: unknown): NewsType {
  if (value === undefined || value === null) return "News";
  if (value !== "News" && value !== "Notification") {
    throw AppError.badRequest("Type must be News or Notification.");
  }
  return value;
}

function cleanAudience(name: string, value: unknown): NewsAudience {
  const allowed: NewsAudience[] = ["driver", "rider", "company", "all"];
  if (value === undefined || value === null) return "all";
  if (!allowed.includes(value as NewsAudience)) {
    throw AppError.badRequest(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as NewsAudience;
}

async function mustFind(id: number): Promise<NewsRow> {
  const row = await model.findNews(id);
  if (!row) throw AppError.notFound(`News #${id} not found.`);
  return row;
}

/** API shape: English texts pulled out of the multilingual blobs. */
export interface NewsDto {
  id: number;
  title: string;
  description: string;
  image: string;
  publishDate: string;
  status: NewsStatus;
  type: NewsType;
  audience: NewsAudience;
}

function toDto(row: NewsRow): NewsDto {
  return {
    id: row.id,
    title: (parseMultilingual(row.rawTitle, TITLE_PREFIX)["EN"] ?? "").trim(),
    description: (parseMultilingual(row.rawDescription, DESC_PREFIX)["EN"] ?? "").trim(),
    image: row.image,
    publishDate: row.publishDate,
    status: row.status,
    type: row.type,
    audience: row.audience,
  };
}

export async function listNews(): Promise<NewsDto[]> {
  const rows = await model.listNews();
  return rows.map(toDto);
}

export async function getNews(id: number): Promise<NewsDto> {
  return toDto(await mustFind(id));
}

export async function createNews(input: {
  title: unknown;
  description?: unknown;
  type?: NewsType;
  audience?: NewsAudience;
  status?: NewsStatus;
}): Promise<NewsDto> {
  const title = cleanText("Title", input.title, MAX_TITLE_LEN, true);
  const description = cleanText("Description", input.description, MAX_DESC_LEN, false);
  const id = await model.nextNewsId();
  await model.createNews(id, {
    // Seed only the English entries; the other languages come from the editor.
    title: serializeMultilingual({ EN: title }, TITLE_PREFIX),
    description: serializeMultilingual({ EN: description }, DESC_PREFIX),
    image: "",
    status: cleanStatus("Status", input.status),
    type: cleanType(input.type),
    audience: cleanAudience("Audience", input.audience),
  });
  return toDto(await mustFind(id));
}

/** Main-form edit: overwrite the English texts and the two enums, keep the rest. */
export async function updateNews(
  id: number,
  input: {
    title: unknown;
    description?: unknown;
    type?: NewsType;
    audience?: NewsAudience;
  },
): Promise<NewsDto> {
  const row = await mustFind(id);
  const title = cleanText("Title", input.title, MAX_TITLE_LEN, true);
  const description = cleanText("Description", input.description, MAX_DESC_LEN, false);

  // An omitted type/audience means "leave as stored", so a partial edit from an
  // older client cannot quietly reclassify who sees the article.
  const type = input.type === undefined ? row.type : cleanType(input.type);
  const audience =
    input.audience === undefined ? row.audience : cleanAudience("Audience", input.audience);

  const titles = parseMultilingual(row.rawTitle, TITLE_PREFIX);
  titles["EN"] = title;
  const descriptions = parseMultilingual(row.rawDescription, DESC_PREFIX);
  descriptions["EN"] = description;

  await model.updateNews(id, {
    title: serializeMultilingual(titles, TITLE_PREFIX),
    description: serializeMultilingual(descriptions, DESC_PREFIX),
    type,
    audience,
  });
  return toDto(await mustFind(id));
}

export interface NewsTranslation {
  code: string;
  label: string;
  title: string;
  description: string;
}

/**
 * All per-language texts, ordered by the shared translation language list.
 * Codes stored on the row but unknown to that list are appended, so no legacy
 * translation becomes uneditable.
 */
export async function getTranslations(id: number): Promise<NewsTranslation[]> {
  const row = await mustFind(id);
  const titles = parseMultilingual(row.rawTitle, TITLE_PREFIX);
  const descriptions = parseMultilingual(row.rawDescription, DESC_PREFIX);
  const known = new Set<string>(TRANSLATION_LANGUAGES.map((l) => l.code as string));

  const items: NewsTranslation[] = TRANSLATION_LANGUAGES.map(({ code, label }) => ({
    code,
    label,
    title: (titles[code] ?? "").trim(),
    description: (descriptions[code] ?? "").trim(),
  }));
  for (const code of new Set([...Object.keys(titles), ...Object.keys(descriptions)])) {
    if (!known.has(code)) {
      items.push({
        code,
        label: code,
        title: (titles[code] ?? "").trim(),
        description: (descriptions[code] ?? "").trim(),
      });
    }
  }
  return items;
}

/** Merge a batch of per-language texts; an empty string clears that language. */
export async function updateTranslations(
  id: number,
  batch: { titles?: Record<string, unknown>; descriptions?: Record<string, unknown> },
): Promise<NewsDto> {
  const row = await mustFind(id);
  const titles = parseMultilingual(row.rawTitle, TITLE_PREFIX);
  const descriptions = parseMultilingual(row.rawDescription, DESC_PREFIX);

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
  // The apps fall back to English, so a row without one would show nothing.
  if (!(titles["EN"] ?? "").trim()) throw AppError.badRequest("English title must stay non-empty.");

  await model.updateRawTexts(
    id,
    serializeMultilingual(titles, TITLE_PREFIX),
    serializeMultilingual(descriptions, DESC_PREFIX),
  );
  return toDto(await mustFind(id));
}

export async function changeStatus(id: number, status: NewsStatus): Promise<NewsDto> {
  const row = await mustFind(id);
  const next = cleanStatus("Status", status);
  if (row.status !== next) await model.setNewsStatus(id, next);
  return toDto(await mustFind(id));
}

/**
 * Attach or replace the stored image (the upload itself is the controller's
 * job; this only records the filename). The replaced file is deliberately left
 * on disk: other rows — including soft-deleted ones — can name the same image,
 * and nothing here is qualified to decide who else still uses it.
 */
export async function attachImage(id: number, filename: string): Promise<NewsDto> {
  const clean = cleanText("Image filename", filename, MAX_IMAGE_LEN, true);
  await mustFind(id);
  await model.updateImage(id, clean);
  return toDto(await mustFind(id));
}

/** News rows are terminal content (nothing references their ids) — soft delete. */
export async function deleteNews(id: number): Promise<void> {
  await mustFind(id);
  await model.softDeleteNews(id);
}
