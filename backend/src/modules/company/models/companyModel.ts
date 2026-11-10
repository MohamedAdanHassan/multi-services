import { query, execute } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";

export type CompanyStatus = "Active" | "Inactive" | "Deleted";

/** A `company` row with its resolved service-category label. */
export interface CompanyRow {
  iCompanyId: number;
  /** Always 0 for companies; store rows (industry > 0) belong to the Store module. */
  iServiceId: number;
  serviceName: string;
  company: string;
  contactName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  eStatus: CompanyStatus;
  /** Raw `vImage` filename; the DTO turns it into a boolean. */
  hasImage: string;
  tRegistrationDate: string | null;
}

/**
 * A company document type (from `document_master`) merged with the company's
 * most recent uploaded row from `document_list` (null docId when nothing uploaded).
 */
export interface CompanyDocumentRow extends RowDataPacket {
  masterId: number;
  name: string;
  serviceType: string;
  docId: number | null;
  docFile: string | null;
  exDate: string | null;
  docStatus: string | null;
  rejectReason: string | null;
}

/**
 * A selectable service category (`service_categories`). The `company` table
 * backs both stores (industry > 0) and companies (iServiceId = 0); this type
 * stays for the future Store module and is unused by the Company CRUD.
 */
export interface ServiceOption {
  id: number;
  name: string;
}

export interface CreateCompanyInput {
  company: string;
  contactName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  status: Exclude<CompanyStatus, "Deleted">;
  passwordHash?: string;
}

export interface UpdateCompanyInput {
  company: string;
  contactName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  address: string;
  city: string;
  state: string;
  country: string;
  zip: string;
}

const BASE_SELECT = `
  SELECT c.iCompanyId, c.iServiceId,
         COALESCE(sc.vServiceName_EN, '') AS serviceName,
         c.vCompany AS company, c.vContactName AS contactName,
         c.vName AS firstName, c.vLastName AS lastName, c.vEmail AS email,
         c.vPhone AS phone, c.vCode AS phoneCode, c.vCaddress AS address,
         c.vCity AS city, c.vState AS state, c.vCountry AS country, c.vZip AS zip,
         c.eStatus, c.vImage AS hasImage,
         DATE_FORMAT(c.tRegistrationDate, '%Y-%m-%d %H:%i') AS tRegistrationDate
    FROM company c
    LEFT JOIN service_categories sc ON sc.iServiceId = c.iServiceId`;

/**
 * Every non-deleted COMPANY with its service label, newest first. Scoped to
 * `iServiceId = 0`: rows with an industry are stores and belong to the Store
 * module (display group 6), not here.
 */
export async function listCompanies(): Promise<CompanyRow[]> {
  return query<CompanyRow>(
    `${BASE_SELECT} WHERE c.eStatus <> 'Deleted' AND c.iServiceId = 0 ORDER BY c.iCompanyId DESC`,
  );
}

/** A single company row (regardless of status), or null. Store rows never match. */
export async function findRow(id: number): Promise<CompanyRow | null> {
  const rows = await query<CompanyRow>(
    `${BASE_SELECT} WHERE c.iCompanyId = ? AND c.iServiceId = 0 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * True when a non-deleted company already owns this email (optionally excluding
 * one id). Blank emails are never treated as taken — many legacy rows are empty.
 */
export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptId
    ? `SELECT 1 AS hit FROM company
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iCompanyId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM company
        WHERE vEmail = ? AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/** Legacy `company` has no AUTO_INCREMENT; derive the next id (MAX + 1). */
export async function nextCompanyId(): Promise<number> {
  const rows = await query<{ max: number | null }>("SELECT MAX(iCompanyId) AS max FROM company");
  return (rows[0]?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Every NOT NULL column of `company` that lacks a DB default. The server runs
 * under STRICT_TRANS_TABLES, so an INSERT must supply each one. Columns absent
 * from `overrides` fall back to the legacy "empty" default for their type.
 * Shared with the Store module — both write the same physical table.
 */
export const REQUIRED_COLUMNS: { col: string; def: string }[] = [
  { col: "iServiceId", def: "0" },
  { col: "vContactName", def: "''" },
  { col: "vName", def: "''" },
  { col: "vLastName", def: "''" },
  { col: "vLoginId", def: "''" },
  { col: "vPassword", def: "''" },
  { col: "vImage", def: "''" },
  { col: "vCoverImage", def: "''" },
  { col: "vCompany", def: "''" },
  { col: "vCaddress", def: "''" },
  { col: "vCadress2", def: "''" },
  { col: "vCity", def: "''" },
  { col: "vState", def: "''" },
  { col: "vZip", def: "''" },
  { col: "vInviteCode", def: "''" },
  { col: "dBirthDate", def: "'1000-01-01'" },
  { col: "vFathersName", def: "''" },
  { col: "vBackCheck", def: "''" },
  { col: "vDriverImg", def: "''" },
  { col: "vEmail", def: "''" },
  { col: "vPhone", def: "''" },
  { col: "vLang", def: "''" },
  { col: "vCurrencyCompany", def: "''" },
  { col: "vVat", def: "''" },
  { col: "vCountry", def: "''" },
  { col: "vCode", def: "''" },
  { col: "vRestuarantLocation", def: "''" },
  { col: "vRestuarantLocationLat", def: "''" },
  { col: "vRestuarantLocationLong", def: "''" },
  { col: "vNoc", def: "''" },
  { col: "vCerti", def: "''" },
  { col: "vPasswordToken", def: "''" },
  { col: "vPassword_token", def: "''" },
  { col: "vFromMonFriTimeSlot1", def: "'00:00:00'" },
  { col: "vToMonFriTimeSlot1", def: "'00:00:00'" },
  { col: "vFromMonFriTimeSlot2", def: "'00:00:00'" },
  { col: "vToMonFriTimeSlot2", def: "'00:00:00'" },
  { col: "vFromSatSunTimeSlot1", def: "'00:00:00'" },
  { col: "vToSatSunTimeSlot1", def: "'00:00:00'" },
  { col: "vFromSatSunTimeSlot2", def: "'00:00:00'" },
  { col: "vToSatSunTimeSlot2", def: "'00:00:00'" },
  { col: "vRadius", def: "0" },
  { col: "fPrepareTime", def: "0" },
  { col: "fOfferAppyType", def: "'None'" },
  { col: "fOfferType", def: "''" },
  { col: "vPaymentEmail", def: "''" },
  { col: "vAcctHolderName", def: "''" },
  { col: "vAcctNo", def: "''" },
  { col: "vBankName", def: "''" },
  { col: "vBankLocation", def: "''" },
  { col: "vSwiftCode", def: "''" },
  { col: "vAvgRating", def: "''" },
  { col: "iGcmRegId", def: "''" },
  { col: "iMaxItemQty", def: "0" },
  { col: "vFirebaseDeviceToken", def: "''" },
  { col: "vTimeZone", def: "''" },
  { col: "tSessionId", def: "''" },
  { col: "tDeviceSessionId", def: "''" },
  { col: "iAppVersion", def: "0" },
  { col: "dSendverificationDate", def: "NOW()" },
  { col: "vEmailVarificationCode", def: "''" },
  { col: "tApiFileName", def: "''" },
  { col: "tVersion", def: "''" },
  { col: "tDeviceData", def: "''" },
  { col: "vDemoStoreImage", def: "''" },
  { col: "eStoreLocationUpdateDateTime", def: "NOW()" },
  { col: "eSafetyPractices", def: "''" },
  { col: "vMonFromSlot1", def: "'00:00:00'" },
  { col: "vMonToSlot1", def: "'00:00:00'" },
  { col: "vTueFromSlot1", def: "'00:00:00'" },
  { col: "vTueToSlot1", def: "'00:00:00'" },
  { col: "vWedFromSlot1", def: "'00:00:00'" },
  { col: "vWedToSlot1", def: "'00:00:00'" },
  { col: "vThuFromSlot1", def: "'00:00:00'" },
  { col: "vThuToSlot1", def: "'00:00:00'" },
  { col: "vFriFromSlot1", def: "'00:00:00'" },
  { col: "vFriToSlot1", def: "'00:00:00'" },
  { col: "vSatFromSlot1", def: "'00:00:00'" },
  { col: "vSatToSlot1", def: "'00:00:00'" },
  { col: "vSunFromSlot1", def: "'00:00:00'" },
  { col: "vSunToSlot1", def: "'00:00:00'" },
  { col: "vMonFromSlot2", def: "'00:00:00'" },
  { col: "vMonToSlot2", def: "'00:00:00'" },
  { col: "vTueFromSlot2", def: "'00:00:00'" },
  { col: "vTueToSlot2", def: "'00:00:00'" },
  { col: "vWedFromSlot2", def: "'00:00:00'" },
  { col: "vWedToSlot2", def: "'00:00:00'" },
  { col: "vThuFromSlot2", def: "'00:00:00'" },
  { col: "vThuToSlot2", def: "'00:00:00'" },
  { col: "vFriFromSlot2", def: "'00:00:00'" },
  { col: "vFriToSlot2", def: "'00:00:00'" },
  { col: "vSatFromSlot2", def: "'00:00:00'" },
  { col: "vSatToSlot2", def: "'00:00:00'" },
  { col: "vSunFromSlot2", def: "'00:00:00'" },
  { col: "vSunToSlot2", def: "'00:00:00'" },
  { col: "fCommission", def: "''" },
  { col: "iGcmRegIdKiosk", def: "''" },
  { col: "tSessionIdKiosk", def: "''" },
  { col: "vKioskImage", def: "''" },
  { col: "eHmsDevice", def: "'No'" },
  { col: "iServiceIdMulti", def: "''" },
  { col: "eForKiosk", def: "'No'" },
  { col: "vOTP", def: "''" },
];

/** Insert a new company, filling every strict-mode NOT NULL column explicitly. */
export async function createCompany(input: CreateCompanyInput): Promise<number> {
  const id = await nextCompanyId();

  // Columns driven by the request: value becomes a bound parameter. Companies
  // own no industry, so iServiceId keeps its REQUIRED_COLUMNS default of 0.
  const overrides: Record<string, string | number> = {
    vCompany: input.company,
    vContactName: input.contactName,
    vName: input.firstName,
    vLastName: input.lastName,
    vEmail: input.email,
    vPassword: input.passwordHash ?? "",
    vPhone: input.phone,
    vCode: input.phoneCode,
    vCaddress: input.address,
    vCity: input.city,
    vState: input.state,
    vCountry: input.country,
    vZip: input.zip,
  };

  const cols = ["iCompanyId", "eStatus", ...REQUIRED_COLUMNS.map((c) => c.col)];
  const placeholders: string[] = ["?", "?"];
  const params: (string | number)[] = [id, input.status];
  for (const c of REQUIRED_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(overrides, c.col)) {
      placeholders.push("?");
      params.push(overrides[c.col]);
    } else {
      placeholders.push(c.def);
    }
  }

  await execute(
    `INSERT INTO company (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
    params,
  );
  return id;
}

/** Edit profile fields. Never touches password, status or iServiceId. */
export async function updateCompany(id: number, input: UpdateCompanyInput): Promise<void> {
  await execute(
    `UPDATE company
       SET vCompany = ?, vContactName = ?, vName = ?, vLastName = ?,
           vEmail = ?, vPhone = ?, vCode = ?, vCaddress = ?, vCity = ?, vState = ?,
           vCountry = ?, vZip = ?
     WHERE iCompanyId = ? AND iServiceId = 0`,
    [
      input.company,
      input.contactName,
      input.firstName,
      input.lastName,
      input.email,
      input.phone,
      input.phoneCode,
      input.address,
      input.city,
      input.state,
      input.country,
      input.zip,
      id,
    ],
  );
}

export async function setStatus(id: number, status: CompanyStatus): Promise<void> {
  await execute("UPDATE company SET eStatus = ? WHERE iCompanyId = ?", [status, id]);
}

/** Soft delete: flip to 'Deleted' so the row disappears from the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE company SET eStatus = 'Deleted' WHERE iCompanyId = ?", [id]);
}

// ---------------------------------------------------------------------------
// Company documents (document_master catalog + document_list uploads).
// ---------------------------------------------------------------------------

/** Legacy placeholder used when a required date column has no real value. */
const DOC_DATE_SENTINEL = "1000-01-01";

/**
 * All active company document types, each LEFT JOINed with the company's most
 * recent (highest doc_id) non-deleted upload from `document_list`.
 */
export async function listCompanyDocuments(companyId: number): Promise<CompanyDocumentRow[]> {
  return query<CompanyDocumentRow>(
    `SELECT m.doc_masterid AS masterId,
            m.doc_name AS name,
            m.eType AS serviceType,
            dl.doc_id AS docId,
            dl.doc_file AS docFile,
            DATE_FORMAT(dl.ex_date, '%Y-%m-%d') AS exDate,
            dl.status AS docStatus,
            dl.vRejectReason AS rejectReason
       FROM document_master m
       LEFT JOIN document_list dl
         ON dl.doc_masterid = m.doc_masterid
        AND dl.doc_usertype = 'company'
        AND dl.doc_userid = ?
        AND dl.status <> 'Deleted'
        AND dl.doc_id = (
          SELECT MAX(d2.doc_id)
            FROM document_list d2
           WHERE d2.doc_masterid = m.doc_masterid
             AND d2.doc_usertype = 'company'
             AND d2.doc_userid = ?
             AND d2.status <> 'Deleted'
        )
      WHERE m.doc_usertype = 'company' AND m.status = 'Active'
      ORDER BY m.iDisplayOrder, m.doc_masterid`,
    [companyId, companyId],
  );
}

/** The stored filename for one uploaded document, scoped to the owning company. */
export async function getCompanyDocFile(
  docId: number,
  companyId: number,
): Promise<string | null> {
  const rows = await query<{ docFile: string | null }>(
    `SELECT doc_file AS docFile FROM document_list
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'company'
        AND status <> 'Deleted'
      LIMIT 1`,
    [docId, companyId],
  );
  const f = rows[0]?.docFile?.trim();
  return f ? f : null;
}

/**
 * Approve / reject one uploaded company document (scoped to the owning company).
 * Returns the number of rows updated (0 when the doc does not belong to the company).
 */
export async function setCompanyDocStatus(
  docId: number,
  companyId: number,
  status: "Active" | "Inactive",
  reason: string,
): Promise<number> {
  const res = await execute(
    `UPDATE document_list
        SET status = ?, vRejectReason = ?
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'company'
        AND status <> 'Deleted'`,
    [status, status === "Inactive" ? reason : "", docId, companyId],
  );
  return res.affectedRows ?? 0;
}

/** True when `masterId` is an active company document type in the catalog. */
export async function isValidCompanyDocType(masterId: number): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM document_master
      WHERE doc_masterid = ? AND doc_usertype = 'company' AND status = 'Active'
      LIMIT 1`,
    [masterId],
  );
  return rows.length > 0;
}

/**
 * Attach (or replace) an uploaded file for one company document type.
 * A new upload resets the row to "pending review" (status Inactive, reason
 * cleared) so it must be re-approved.
 */
export async function upsertCompanyDocUpload(
  companyId: number,
  masterId: number,
  docFile: string,
  exDate: string,
): Promise<void> {
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(exDate) ? exDate : DOC_DATE_SENTINEL;
  const existing = await query<{ doc_id: number }>(
    `SELECT doc_id FROM document_list
      WHERE doc_masterid = ? AND doc_usertype = 'company' AND doc_userid = ?
        AND status <> 'Deleted'
      ORDER BY doc_id DESC LIMIT 1`,
    [masterId, companyId],
  );
  if (existing.length > 0) {
    await execute(
      `UPDATE document_list
          SET doc_file = ?, ex_date = ?, status = 'Inactive', vRejectReason = ''
        WHERE doc_id = ?`,
      [docFile, expiry, existing[0].doc_id],
    );
    return;
  }
  const next = await query<{ nid: number }>(
    "SELECT COALESCE(MAX(doc_id), 0) + 1 AS nid FROM document_list",
  );
  await execute(
    `INSERT INTO document_list
        (doc_id, doc_masterid, doc_usertype, doc_userid, ex_date, doc_file,
         status, req_date, req_file, lastReminderDate, vRejectReason)
     VALUES (?, ?, 'company', ?, ?, ?, 'Inactive', ?, '', ?, '')`,
    [next[0].nid, masterId, companyId, expiry, docFile, DOC_DATE_SENTINEL, DOC_DATE_SENTINEL],
  );
}
