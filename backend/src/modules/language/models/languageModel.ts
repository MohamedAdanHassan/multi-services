import { execute, query } from "../../../db/mysql";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";

/**
 * Data access for the legacy `language_master` table (MyISAM, no primary key;
 * the logical `iLanguageMasId` is unique in practice). Like the currency
 * catalog this is a fixed set of installed languages, so the feature edits
 * rows and toggles their status / default flag — it never inserts or deletes.
 * Only admin-owned columns are mutated; `vCode` stays a stable identifier
 * because the label tables (`language_label.vCode`) join against it.
 */

export type LanguageStatus = "Active" | "Inactive";
export type LanguageDirection = "rtl" | "ltr";

/** A full `language_master` row, mapped to a camelCase shape. */
export interface LanguageRow {
  id: number; // iLanguageMasId
  code: string; // vCode (read-only identifier, e.g. "EN")
  title: string; // vTitle (native name)
  titleEn: string; // vTitle_EN (English name)
  gmapLangCode: string; // vGMapLangCode (Google Maps language code)
  langCode: string; // vLangCode (app language code)
  currencyCode: string; // vCurrencyCode
  currencySymbol: string; // vCurrencySymbol
  displayOrder: number; // iDispOrder
  status: LanguageStatus; // eStatus
  isDefault: boolean; // eDefault
  direction: LanguageDirection; // eDirectionCode
}

/** Admin-editable fields (excludes code / default / status, handled separately). */
export interface LanguageInput {
  title: string;
  titleEn: string;
  gmapLangCode: string;
  langCode: string;
  currencyCode: string;
  currencySymbol: string;
  displayOrder: number;
  direction: LanguageDirection;
}

const SELECT_COLUMNS = `iLanguageMasId, vTitle, vTitle_EN, vCode, vGMapLangCode, vLangCode,
  vCurrencyCode, vCurrencySymbol, iDispOrder, eStatus, eDefault, eDirectionCode`;

function mapRow(r: Record<string, string | number | null>): LanguageRow {
  return {
    id: Number(r.iLanguageMasId),
    code: String(r.vCode ?? ""),
    title: String(r.vTitle ?? ""),
    titleEn: String(r.vTitle_EN ?? ""),
    gmapLangCode: String(r.vGMapLangCode ?? ""),
    langCode: String(r.vLangCode ?? ""),
    currencyCode: String(r.vCurrencyCode ?? ""),
    currencySymbol: String(r.vCurrencySymbol ?? ""),
    displayOrder: Number(r.iDispOrder) || 0,
    status: String(r.eStatus) === "Inactive" ? "Inactive" : "Active",
    isDefault: String(r.eDefault) === "Yes",
    direction: String(r.eDirectionCode) === "rtl" ? "rtl" : "ltr",
  };
}

/** All languages, ordered by display order then id (both Active and Inactive). */
export async function listLanguages(): Promise<LanguageRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM language_master ORDER BY iDispOrder, iLanguageMasId`,
  );
  return rows.map(mapRow);
}

/** Look up a single language by id (or null if absent). */
export async function findLanguage(id: number): Promise<LanguageRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM language_master WHERE iLanguageMasId = ? LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Persist the admin-editable fields of one language. */
export async function updateLanguage(id: number, input: LanguageInput, conn?: PoolConnection): Promise<number> {
  const sql = `UPDATE language_master
     SET vTitle = ?, vTitle_EN = ?, vGMapLangCode = ?, vLangCode = ?,
         vCurrencyCode = ?, vCurrencySymbol = ?, iDispOrder = ?, eDirectionCode = ?
   WHERE iLanguageMasId = ?`;
  const params = [
    input.title,
    input.titleEn,
    input.gmapLangCode,
    input.langCode,
    input.currencyCode,
    input.currencySymbol,
    input.displayOrder,
    input.direction,
    id,
  ];
  if (conn) {
    const [res] = await conn.execute<ResultSetHeader>(sql, params);
    return res.affectedRows;
  }
  const res = await execute(sql, params);
  return res.affectedRows;
}

/** Activate / deactivate a language. */
export async function setStatus(id: number, status: LanguageStatus): Promise<number> {
  const res = await execute("UPDATE language_master SET eStatus = ? WHERE iLanguageMasId = ?", [status, id]);
  return res.affectedRows;
}

/**
 * Make one language the default. Order matters: set the target first, then
 * clear every other row, so there is never a moment with zero defaults
 * (MyISAM gives us no transaction rollback to fall back on).
 */
export async function makeDefault(id: number): Promise<void> {
  await execute("UPDATE language_master SET eDefault = 'Yes' WHERE iLanguageMasId = ?", [id]);
  await execute("UPDATE language_master SET eDefault = 'No' WHERE iLanguageMasId <> ?", [id]);
}
