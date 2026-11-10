import { query, execute } from "../../../db/mysql";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";

/** Allowed `doc_usertype` values (mirrors the document_master ENUM). */
export const DOC_USERTYPES = [
  "company",
  "driver",
  "car",
  "store",
  "user",
  "trackcompany",
] as const;
export type DocUserType = (typeof DOC_USERTYPES)[number];

export type DocStatus = "Active" | "Inactive" | "Deleted";
export type ExStatus = "yes" | "no";

/** Allowed `eDocServiceType` values (mirrors the document_master ENUM). */
export const DOC_SERVICE_TYPES = ["General", "ServiceSpecific", "BiddingSpecific"] as const;
export type DocServiceType = (typeof DOC_SERVICE_TYPES)[number];

/** A `document_master` catalog row (document type definition). */
export interface DocumentRow {
  docMasterId: number;
  name: string;
  userType: string;
  serviceType: string;
  docServiceType: string;
  country: string;
  exStatus: string;
  status: string;
  displayOrder: number;
  inTime: string | null;
}

export interface DocumentInput {
  name: string;
  userType: DocUserType;
  docServiceType: DocServiceType;
  country: string;
  exStatus: ExStatus;
  status: Exclude<DocStatus, "Deleted">;
  displayOrder: number;
}

/**
 * The 26 `doc_name_XX` translation columns. All are NOT NULL without a DB
 * default, so an INSERT under STRICT mode must supply each one. We mirror the
 * primary name into English and blank the rest (core-fields-only editor).
 */
const TRANSLATION_COLUMNS = [
  "doc_name_EN",
  "doc_name_PTBR",
  "doc_name_ZHCN",
  "doc_name_CS",
  "doc_name_FR",
  "doc_name_HI",
  "doc_name_PL",
  "doc_name_RU",
  "doc_name_SK",
  "doc_name_SL",
  "doc_name_UK",
  "doc_name_KO",
  "doc_name_JA",
  "doc_name_RO",
  "doc_name_SW",
  "doc_name_HU",
  "doc_name_BG",
  "doc_name_EL",
  "doc_name_NL",
  "doc_name_AR",
  "doc_name_IT",
  "doc_name_SV",
  "doc_name_ES",
  "doc_name_LV",
  "doc_name_DE",
  "doc_name_ID",
] as const;

/** Language codes (the `XX` suffix) supported for `doc_name` translations. */
export const TRANSLATION_LANGUAGES = [
  { code: "EN", label: "English" },
  { code: "PTBR", label: "Portuguese (Brazil)" },
  { code: "ZHCN", label: "Chinese (Simplified)" },
  { code: "CS", label: "Czech" },
  { code: "FR", label: "French" },
  { code: "HI", label: "Hindi" },
  { code: "PL", label: "Polish" },
  { code: "RU", label: "Russian" },
  { code: "SK", label: "Slovak" },
  { code: "SL", label: "Slovenian" },
  { code: "UK", label: "Ukrainian" },
  { code: "KO", label: "Korean" },
  { code: "JA", label: "Japanese" },
  { code: "RO", label: "Romanian" },
  { code: "SW", label: "Swahili" },
  { code: "HU", label: "Hungarian" },
  { code: "BG", label: "Bulgarian" },
  { code: "EL", label: "Greek" },
  { code: "NL", label: "Dutch" },
  { code: "AR", label: "Arabic" },
  { code: "IT", label: "Italian" },
  { code: "SV", label: "Swedish" },
  { code: "ES", label: "Spanish" },
  { code: "LV", label: "Latvian" },
  { code: "DE", label: "German" },
  { code: "ID", label: "Indonesian" },
] as const;
export type TranslationCode = (typeof TRANSLATION_LANGUAGES)[number]["code"];

/** Every doc_name translation of one catalog row, keyed by language code. */
export async function getTranslations(
  id: number,
): Promise<Record<TranslationCode, string> | null> {
  const rows = await query<Record<string, string>>(
    `SELECT ${TRANSLATION_COLUMNS.join(", ")} FROM document_master WHERE doc_masterid = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const out = {} as Record<TranslationCode, string>;
  for (const { code } of TRANSLATION_LANGUAGES) {
    out[code as TranslationCode] = (row[`doc_name_${code}`] ?? "").trim();
  }
  return out;
}

/**
 * Persist doc_name translations. Only recognised language columns are touched
 * (keys are validated against the ENUM-like whitelist, never interpolated raw).
 */
export async function updateTranslations(
  id: number,
  translations: Partial<Record<string, string>>,
): Promise<number> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  for (const { code } of TRANSLATION_LANGUAGES) {
    const column = `doc_name_${code}` as (typeof TRANSLATION_COLUMNS)[number];
    if (code in translations) {
      sets.push(`${column} = ?`);
      params.push((translations[code] ?? "").trim());
    }
  }
  if (!sets.length) return 0;
  params.push(id);
  const res = await execute(
    `UPDATE document_master SET ${sets.join(", ")} WHERE doc_masterid = ?`,
    params,
  );
  return res.affectedRows;
}

const BASE_SELECT = `
  SELECT doc_masterid AS docMasterId,
         doc_name AS name,
         doc_usertype AS userType,
         eType AS serviceType,
         eDocServiceType AS docServiceType,
         country AS country,
         ex_status AS exStatus,
         status,
         iDisplayOrder AS displayOrder,
         DATE_FORMAT(doc_instime, '%Y-%m-%d %H:%i') AS inTime
    FROM document_master`;

/** Every non-deleted document type, grouped by usertype then display order. */
export async function listDocuments(userType?: DocUserType): Promise<DocumentRow[]> {
  const where = userType
    ? "status <> 'Deleted' AND doc_usertype = ?"
    : "status <> 'Deleted'";
  return query<DocumentRow>(
    `${BASE_SELECT}
      WHERE ${where}
      ORDER BY doc_usertype, iDisplayOrder, doc_masterid`,
    userType ? [userType] : [],
  );
}

/** A single document type row (regardless of status), or null. */
export async function findRow(id: number): Promise<DocumentRow | null> {
  const rows = await query<DocumentRow>(`${BASE_SELECT} WHERE doc_masterid = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** True when a non-deleted type already uses this name within the usertype. */
export async function nameTaken(
  name: string,
  userType: DocUserType,
  exceptId?: number,
): Promise<boolean> {
  const sql = exceptId
    ? `SELECT 1 AS hit FROM document_master
        WHERE doc_name = ? AND doc_usertype = ? AND status <> 'Deleted' AND doc_masterid <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM document_master
        WHERE doc_name = ? AND doc_usertype = ? AND status <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [name, userType, exceptId] : [name, userType];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/** Legacy `document_master` has no AUTO_INCREMENT; derive the next id (MAX + 1). */
export async function nextMasterId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(doc_masterid) AS max FROM document_master",
  );
  return (rows[0]?.max ?? 0) + 1;
}

/** Insert a new document type, filling every strict-mode NOT NULL column.
 * Pass `conn` to run inside an existing transaction (used by documentsService). */
export async function createDocument(input: DocumentInput, conn?: PoolConnection): Promise<number> {
  const id = conn
    ? ((await conn.query("SELECT IFNULL(MAX(doc_masterid),0)+1 AS max FROM document_master"))[0] as {
        max: number;
      }[])[0].max
    : await nextMasterId();

  const cols: string[] = [
    "doc_masterid",
    "doc_usertype",
    "doc_name",
    "country",
    "ex_status",
    "status",
    "eType",
    "eDocServiceType",
    "iVehicleCategoryId",
    "iDisplayOrder",
    "iBiddingId",
    ...TRANSLATION_COLUMNS,
  ];
  const placeholders: string[] = [
    "?", // doc_masterid
    "?", // doc_usertype
    "?", // doc_name
    "?", // country ('All' or a country id)
    "?", // ex_status
    "?", // status
    "'Ride'", // eType default
    "?", // eDocServiceType
    "0", // iVehicleCategoryId
    "?", // iDisplayOrder
    "0", // iBiddingId
    ...TRANSLATION_COLUMNS.map((c) => (c === "doc_name_EN" ? "?" : "''")),
  ];
  const params: (string | number)[] = [
    id,
    input.userType,
    input.name,
    input.country,
    input.exStatus,
    input.status,
    input.docServiceType,
    input.displayOrder,
    input.name, // doc_name_EN mirrors the primary name
  ];

  const sql = `INSERT INTO document_master (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
  if (conn) await conn.query(sql, params);
  else await execute(sql, params);
  return id;
}

/** Update the editable fields of an existing document type (optionally on a conn). */
export async function updateDocument(
  id: number,
  input: DocumentInput,
  conn?: PoolConnection,
): Promise<void> {
  const sql = `UPDATE document_master
      SET doc_name = ?, doc_usertype = ?, eDocServiceType = ?, country = ?, ex_status = ?, status = ?, iDisplayOrder = ?, doc_name_EN = ?
    WHERE doc_masterid = ?`;
  const params = [
    input.name,
    input.userType,
    input.docServiceType,
    input.country,
    input.exStatus,
    input.status,
    input.displayOrder,
    input.name,
    id,
  ];
  if (conn) await conn.query(sql, params);
  else await execute(sql, params);
}

export async function setStatus(id: number, status: DocStatus): Promise<ResultSetHeader> {
  return execute("UPDATE document_master SET status = ? WHERE doc_masterid = ?", [status, id]);
}

/** Soft delete: flip to 'Deleted' so the type leaves the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE document_master SET status = 'Deleted' WHERE doc_masterid = ?", [id]);
}
