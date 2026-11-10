import { query, execute } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";
import { REQUIRED_COLUMNS } from "../../company/models/companyModel";

export type StoreStatus = "Active" | "Inactive" | "Deleted";

/** A store row (`company` with `iServiceId > 0`) plus its resolved industry label. */
export interface StoreRow {
  iCompanyId: number;
  /** Industry FK into `service_categories` — always > 0 for stores. */
  iServiceId: number;
  serviceName: string;
  store: string;
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
  location: string;
  locationLat: string;
  locationLng: string;
  maxItemQty: number;
  language: string;
  currency: string;
  eStatus: StoreStatus;
  /** Raw `vImage` filename; the DTO turns it into a boolean. */
  hasImage: string;
  tRegistrationDate: string | null;
}

/** One selectable industry (`service_categories` row). */
export interface StoreIndustryOption {
  id: number;
  name: string;
}

/** A store document type merged with the store's latest upload. */
export interface StoreDocumentRow extends RowDataPacket {
  masterId: number;
  name: string;
  serviceType: string;
  docId: number | null;
  docFile: string | null;
  exDate: string | null;
  docStatus: string | null;
  rejectReason: string | null;
}

export interface CreateStoreInput {
  store: string;
  serviceId: number;
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
  location: string;
  locationLat: string;
  locationLng: string;
  maxItemQty: number;
  language: string;
  currency: string;
  status: Exclude<StoreStatus, "Deleted">;
  passwordHash?: string;
}

export type UpdateStoreInput = Omit<CreateStoreInput, "status" | "passwordHash">;

const BASE_SELECT = `
  SELECT c.iCompanyId, c.iServiceId,
         COALESCE(sc.vServiceName_EN, '') AS serviceName,
         c.vCompany AS store, c.vContactName AS contactName,
         c.vName AS firstName, c.vLastName AS lastName, c.vEmail AS email,
         c.vPhone AS phone, c.vCode AS phoneCode, c.vCaddress AS address,
         c.vCity AS city, c.vState AS state, c.vCountry AS country, c.vZip AS zip,
         c.vRestuarantLocation AS location,
         c.vRestuarantLocationLat AS locationLat,
         c.vRestuarantLocationLong AS locationLng,
         c.iMaxItemQty AS maxItemQty, c.vLang AS language,
         c.vCurrencyCompany AS currency,
         c.eStatus, c.vImage AS hasImage,
         DATE_FORMAT(c.tRegistrationDate, '%Y-%m-%d %H:%i') AS tRegistrationDate
    FROM company c
    LEFT JOIN service_categories sc ON sc.iServiceId = c.iServiceId`;

/**
 * Filters shared by the paginated listing, its COUNT and the CSV export. The
 * `company` table is dual-purpose: every query is scoped to stores
 * (`iServiceId > 0`); companies (`= 0`) belong to the Company module.
 */
export interface StoreListFilters {
  /** Partial store / contact / email / phone / industry, already trimmed. */
  search: string;
  /** Restrict to one status (undefined keeps Active + Inactive). */
  status?: Exclude<StoreStatus, "Deleted">;
  /** Restrict to one industry (0/undefined = all industries). */
  serviceId?: number;
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params for page/count/export so they never drift. */
function buildFilters(f: StoreListFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["c.eStatus <> 'Deleted'", "c.iServiceId > 0"];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("c.eStatus = ?");
    params.push(f.status);
  }
  if (f.serviceId) {
    clauses.push("c.iServiceId = ?");
    params.push(f.serviceId);
  }
  if (f.search) {
    clauses.push(
      "(c.vCompany LIKE ? OR c.vContactName LIKE ? OR c.vEmail LIKE ? OR c.vPhone LIKE ? OR sc.vServiceName_EN LIKE ?)",
    );
    const p = likePattern(f.search);
    params.push(p, p, p, p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * Every live store matching the filters, newest first. Used by the CSV export,
 * which ships the whole result set rather than the visible page.
 */
export async function listStores(
  filters: StoreListFilters = { search: "" },
): Promise<StoreRow[]> {
  const { where, params } = buildFilters(filters);
  return query<StoreRow>(`${BASE_SELECT} ${where} ORDER BY c.iCompanyId DESC`, params);
}

/** One page of live stores (newest first) for the paginated admin listing. */
export async function listStorePage(
  filters: StoreListFilters & { page: number; limit: number },
): Promise<StoreRow[]> {
  const { where, params } = buildFilters(filters);
  const offset = (filters.page - 1) * filters.limit;
  return query<StoreRow>(
    `${BASE_SELECT} ${where} ORDER BY c.iCompanyId DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit, offset],
  );
}

/** Total live stores matching the same filters (for the page count). */
export async function countStores(filters: StoreListFilters): Promise<number> {
  const { where, params } = buildFilters(filters);
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c
       FROM company c
       LEFT JOIN service_categories sc ON sc.iServiceId = c.iServiceId
       ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

/** A single store row (regardless of status), or null. Company ids never match. */
export async function findRow(id: number): Promise<StoreRow | null> {
  const rows = await query<StoreRow>(
    `${BASE_SELECT} WHERE c.iCompanyId = ? AND c.iServiceId > 0 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Active industries for the create/edit dropdown, ordered by id. */
export async function listIndustries(): Promise<StoreIndustryOption[]> {
  return query<StoreIndustryOption>(
    `SELECT iServiceId AS id, vServiceName_EN AS name FROM service_categories
      WHERE eStatus = 'Active' ORDER BY iServiceId`,
  );
}

/** True when `id` is an existing industry row (Active or not — edits keep fidelity). */
export async function industryExists(id: number): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    "SELECT 1 AS ok FROM service_categories WHERE iServiceId = ? LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

/**
 * True when a non-deleted STORE already owns this email (optionally excluding
 * one id). Scoped to `iServiceId > 0` so a company login never blocks a store
 * registration on the shared table. Blank emails are never treated as taken.
 */
export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptId
    ? `SELECT 1 AS hit FROM company
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iServiceId > 0 AND iCompanyId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM company
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iServiceId > 0 LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/**
 * Insert a new store. Shares the `company` table (and its REQUIRED_COLUMNS
 * strict-mode inventory) with the Company module; the ONLY differences are
 * `iServiceId > 0` (the industry) plus the store-owned location fields.
 */
export async function createStore(input: CreateStoreInput): Promise<number> {
  const rows = await query<{ max: number | null }>("SELECT MAX(iCompanyId) AS max FROM company");
  const id = (rows[0]?.max ?? 0) + 1;

  const overrides: Record<string, string | number> = {
    iCompanyId: id,
    iServiceId: input.serviceId,
    eStatus: input.status,
    vCompany: input.store,
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
    vRestuarantLocation: input.location,
    vRestuarantLocationLat: input.locationLat,
    vRestuarantLocationLong: input.locationLng,
    iMaxItemQty: input.maxItemQty,
    vLang: input.language,
    vCurrencyCompany: input.currency,
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

/** Edit profile fields. Never touches password or status. */
export async function updateStore(id: number, input: UpdateStoreInput): Promise<void> {
  await execute(
    `UPDATE company
        SET iServiceId = ?, vCompany = ?, vContactName = ?, vName = ?, vLastName = ?,
            vEmail = ?, vPhone = ?, vCode = ?, vCaddress = ?, vCity = ?, vState = ?,
            vCountry = ?, vZip = ?, vRestuarantLocation = ?, vRestuarantLocationLat = ?,
            vRestuarantLocationLong = ?, iMaxItemQty = ?, vLang = ?, vCurrencyCompany = ?
      WHERE iCompanyId = ? AND iServiceId > 0`,
    [
      input.serviceId,
      input.store,
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
      input.location,
      input.locationLat,
      input.locationLng,
      input.maxItemQty,
      input.language,
      input.currency,
      id,
    ],
  );
}

export async function setStatus(id: number, status: StoreStatus): Promise<void> {
  await execute(
    "UPDATE company SET eStatus = ? WHERE iCompanyId = ? AND iServiceId > 0",
    [status, id],
  );
}

/** Soft delete: flip to 'Deleted' so the row disappears from the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute(
    "UPDATE company SET eStatus = 'Deleted' WHERE iCompanyId = ? AND iServiceId > 0",
    [id],
  );
}

/** Persist a newly uploaded logo filename (legacy `<epoch>_<rand>.<ext>` form). */
export async function setImage(id: number, filename: string): Promise<void> {
  await execute(
    "UPDATE company SET vImage = ? WHERE iCompanyId = ? AND iServiceId > 0",
    [filename, id],
  );
}

// ---------------------------------------------------------------------------
// Store documents (document_master catalog + document_list uploads).
// ---------------------------------------------------------------------------

/** Legacy placeholder used when a required date column has no real value. */
const DOC_DATE_SENTINEL = "1000-01-01";

/**
 * All active store document types, each LEFT JOINed with the store's most
 * recent (highest doc_id) non-deleted upload from `document_list`.
 */
export async function listStoreDocuments(storeId: number): Promise<StoreDocumentRow[]> {
  return query<StoreDocumentRow>(
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
        AND dl.doc_usertype = 'store'
        AND dl.doc_userid = ?
        AND dl.status <> 'Deleted'
        AND dl.doc_id = (
          SELECT MAX(d2.doc_id)
            FROM document_list d2
           WHERE d2.doc_masterid = m.doc_masterid
             AND d2.doc_usertype = 'store'
             AND d2.doc_userid = ?
             AND d2.status <> 'Deleted'
        )
      WHERE m.doc_usertype = 'store' AND m.status = 'Active'
      ORDER BY m.iDisplayOrder, m.doc_masterid`,
    [storeId, storeId],
  );
}

/** The stored filename for one uploaded document, scoped to the owning store. */
export async function getStoreDocFile(docId: number, storeId: number): Promise<string | null> {
  const rows = await query<{ docFile: string | null }>(
    `SELECT doc_file AS docFile FROM document_list
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'store'
        AND status <> 'Deleted'
      LIMIT 1`,
    [docId, storeId],
  );
  const f = rows[0]?.docFile?.trim();
  return f ? f : null;
}

/**
 * Approve / reject one uploaded store document (scoped to the owning store).
 * Returns the number of rows updated (0 when the doc does not belong to the store).
 */
export async function setStoreDocStatus(
  docId: number,
  storeId: number,
  status: "Active" | "Inactive",
  reason: string,
): Promise<number> {
  const res = await execute(
    `UPDATE document_list
        SET status = ?, vRejectReason = ?
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'store'
        AND status <> 'Deleted'`,
    [status, status === "Inactive" ? reason : "", docId, storeId],
  );
  return res.affectedRows ?? 0;
}

/** True when `masterId` is an active store document type in the catalog. */
export async function isValidStoreDocType(masterId: number): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM document_master
      WHERE doc_masterid = ? AND doc_usertype = 'store' AND status = 'Active'
      LIMIT 1`,
    [masterId],
  );
  return rows.length > 0;
}

/**
 * Attach (or replace) an uploaded file for one store document type.
 * A new upload resets the row to "pending review" (status Inactive, reason
 * cleared) so it must be re-approved.
 */
export async function upsertStoreDocUpload(
  storeId: number,
  masterId: number,
  docFile: string,
  exDate: string,
): Promise<void> {
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(exDate) ? exDate : DOC_DATE_SENTINEL;
  const existing = await query<{ doc_id: number }>(
    `SELECT doc_id FROM document_list
      WHERE doc_masterid = ? AND doc_usertype = 'store' AND doc_userid = ?
        AND status <> 'Deleted'
      ORDER BY doc_id DESC LIMIT 1`,
    [masterId, storeId],
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
     VALUES (?, ?, 'store', ?, ?, ?, 'Inactive', ?, '', ?, '')`,
    [next[0].nid, masterId, storeId, expiry, docFile, DOC_DATE_SENTINEL, DOC_DATE_SENTINEL],
  );
}
