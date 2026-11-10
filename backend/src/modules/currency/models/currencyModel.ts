import { execute, query } from "../../../db/mysql";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";

/**
 * Data access for the legacy `currency` table (MyISAM, no primary key; the
 * logical `iCurrencyId` is unique in practice). The catalog is a fixed set
 * seeded from `master_currency`, so this feature edits rows and toggles their
 * status / default flag — it never inserts or deletes. We only ever mutate
 * admin-owned columns, leaving `vName` (the ISO-style code) as a stable key so
 * the unchanged PHP app keeps resolving currencies correctly.
 */

export type CurrencyStatus = "Active" | "Inactive";
export type YesNo = "Yes" | "No";

/** A full `currency` row, mapped to a camelCase shape. */
export interface CurrencyRow {
  id: number; // iCurrencyId
  code: string; // vName (read-only identifier, e.g. "USD")
  symbol: string; // vSymbol
  ratio: number; // Ratio (value of 1 unit relative to the base)
  displayOrder: number; // iDispOrder
  threshold: number; // fThresholdAmount
  isDefault: boolean; // eDefault
  status: CurrencyStatus; // eStatus
  reverseFormatting: boolean; // eReverseformattingEnable
  reverseSymbol: boolean; // eReverseSymbolEnable
  roundingOff: boolean; // eRoundingOffEnable
  firstRange: number; // fFirstRangeValue
  middleRange: number; // fMiddleRangeValue
  secondRange: number; // fSecRangeValue
}

/** Admin-editable fields (excludes code / default / status, handled separately). */
export interface CurrencyInput {
  symbol: string;
  ratio: number;
  displayOrder: number;
  threshold: number;
  reverseFormatting: boolean;
  reverseSymbol: boolean;
  roundingOff: boolean;
  firstRange: number;
  middleRange: number;
  secondRange: number;
}

const SELECT_COLUMNS = `iCurrencyId, vName, vSymbol, Ratio, iDispOrder, fThresholdAmount,
  eDefault, eStatus, eReverseformattingEnable, eReverseSymbolEnable, eRoundingOffEnable,
  fFirstRangeValue, fMiddleRangeValue, fSecRangeValue`;

function yn(v: boolean): YesNo {
  return v ? "Yes" : "No";
}

function mapRow(r: Record<string, string | number | null>): CurrencyRow {
  return {
    id: Number(r.iCurrencyId),
    code: String(r.vName ?? ""),
    symbol: String(r.vSymbol ?? ""),
    ratio: Number(r.Ratio) || 0,
    displayOrder: Number(r.iDispOrder) || 0,
    threshold: Number(r.fThresholdAmount) || 0,
    isDefault: String(r.eDefault) === "Yes",
    status: String(r.eStatus) === "Inactive" ? "Inactive" : "Active",
    reverseFormatting: String(r.eReverseformattingEnable) === "Yes",
    reverseSymbol: String(r.eReverseSymbolEnable) === "Yes",
    roundingOff: String(r.eRoundingOffEnable) === "Yes",
    firstRange: Number(r.fFirstRangeValue) || 0,
    middleRange: Number(r.fMiddleRangeValue) || 0,
    secondRange: Number(r.fSecRangeValue) || 0,
  };
}

/** All currencies, ordered by display order then id (both Active and Inactive). */
export async function listCurrencies(): Promise<CurrencyRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM currency ORDER BY iDispOrder, iCurrencyId`,
  );
  return rows.map(mapRow);
}

/** Look up a single currency by id (or null if absent). */
export async function findCurrency(id: number): Promise<CurrencyRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM currency WHERE iCurrencyId = ? LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Persist the admin-editable fields of one currency. */
export async function updateCurrency(id: number, input: CurrencyInput, conn?: PoolConnection): Promise<number> {
  const sql = `UPDATE currency
     SET vSymbol = ?, Ratio = ?, iDispOrder = ?, fThresholdAmount = ?,
         eReverseformattingEnable = ?, eReverseSymbolEnable = ?, eRoundingOffEnable = ?,
         fFirstRangeValue = ?, fMiddleRangeValue = ?, fSecRangeValue = ?
   WHERE iCurrencyId = ?`;
  const params = [
    input.symbol,
    input.ratio,
    input.displayOrder,
    input.threshold,
    yn(input.reverseFormatting),
    yn(input.reverseSymbol),
    yn(input.roundingOff),
    input.firstRange,
    input.middleRange,
    input.secondRange,
    id,
  ];
  if (conn) {
    const [res] = await conn.execute<ResultSetHeader>(sql, params);
    return res.affectedRows;
  }
  const res = await execute(sql, params);
  return res.affectedRows;
}

/** Activate / deactivate a currency. */
export async function setStatus(id: number, status: CurrencyStatus): Promise<number> {
  const res = await execute("UPDATE currency SET eStatus = ? WHERE iCurrencyId = ?", [status, id]);
  return res.affectedRows;
}

/**
 * Make one currency the default. Order matters: set the target first, then clear
 * every other row, so there is never a moment with zero defaults (MyISAM gives us
 * no transaction rollback to fall back on).
 */
export async function makeDefault(id: number): Promise<void> {
  await execute("UPDATE currency SET eDefault = 'Yes' WHERE iCurrencyId = ?", [id]);
  await execute("UPDATE currency SET eDefault = 'No' WHERE iCurrencyId <> ?", [id]);
}
