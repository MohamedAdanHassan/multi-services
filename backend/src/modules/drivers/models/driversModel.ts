import { query, execute, withTransaction } from "../../../db/mysql";

export type DriverStatus = "active" | "inactive" | "Deleted" | "Suspend";
export type Availability = "Available" | "Not Available";

/** A `register_driver` row joined with its resolved wallet balance. */
export interface DriverRow {
  iDriverId: number;
  vName: string;
  vLastName: string;
  vEmail: string;
  vPhone: string;
  vCompany: string;
  vCarType: string;
  vAvailability: string;
  eStatus: DriverStatus;
  eIsFeatured: "Yes" | "No";
  vImage: string;
  gender: string;
  birthDate: string | null;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  /** Dial code auto-filled from the chosen country (`register_driver.vCode`). */
  phoneCode: string;
  /** `vLang` — language code from `language_master`. */
  language: string;
  /** `vCurrencyDriver` — currency code. */
  currency: string;
  paymentEmail: string;
  accountHolderName: string;
  accountNumber: string;
  bankName: string;
  bankLocation: string;
  swiftCode: string;
  /** `tProfileDescription` — provider's service description. */
  description: string;
  /** Owning company / store row (`register_driver.iCompanyId`). */
  companyId: number;
  /** Resolved name of `companyId` (empty when unassigned). */
  companyName: string;
  vehicleCount: number;
  hasDocument: number;
  docExpiredCount: number;
  docExpiringSoonCount: number;
  tRegistrationDate: string | null;
  walletBalance: number;
}

/**
 * A driver document type (from `document_master`) merged with the driver's most
 * recent uploaded row from `document_list` (null docId when nothing uploaded).
 */
export interface DriverDocumentRow {
  masterId: number;
  name: string;
  serviceType: string;
  /** Catalog `doc_usertype`; always 'driver' for this page's query. */
  userType: string;
  docId: number | null;
  docFile: string | null;
  exDate: string | null;
  docStatus: string | null;
  rejectReason: string | null;
}

export interface ServiceCategoryRow {
  iServiceId: number;
  name: string;
}

export interface WalletTransactionRow {
  iUserWalletId: number;
  eType: "Credit" | "Debit";
  eFor: string;
  amount: number;
  tDescription: string;
  dDate: string | null;
}

// ---------------------------------------------------------------------------
// Dynamic full-column INSERT for the legacy `register_driver` table.
//
// The table has no AUTO_INCREMENT and, under STRICT_TRANS_TABLES, ~80 NOT NULL
// columns without a DB default must all be supplied. Rather than hand-maintain
// that list, we introspect it once and cache it, filling each column with a
// type-appropriate "empty" default unless the caller overrides it.
// ---------------------------------------------------------------------------

interface RequiredCol {
  col: string;
  /** Literal SQL fragment used when the column is not overridden. */
  def: string;
}

let requiredCols: RequiredCol[] | null = null;

/** First allowed value of an `enum('a','b',...)` COLUMN_TYPE string. */
function firstEnumValue(columnType: string): string {
  const m = /'((?:[^']|'')*)'/.exec(columnType);
  return m ? `'${m[1].replace(/''/g, "''")}'` : "''";
}

function defaultLiteral(dataType: string, columnType: string): string {
  switch (dataType) {
    case "enum":
      return firstEnumValue(columnType);
    case "date":
      return "'1000-01-01'";
    case "datetime":
    case "timestamp":
      return "NOW()";
    case "int":
    case "bigint":
    case "smallint":
    case "mediumint":
    case "decimal":
    case "float":
    case "double":
      return "0";
    default:
      return "''";
  }
}

/** Load (and cache) the NOT NULL, no-default, non-auto columns of register_driver. */
async function getRequiredCols(): Promise<RequiredCol[]> {
  if (requiredCols) return requiredCols;
  const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string; COLUMN_TYPE: string }>(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'register_driver'
        AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
        AND EXTRA NOT LIKE '%auto_increment%'
      ORDER BY ORDINAL_POSITION`,
  );
  requiredCols = rows.map((r) => ({
    col: r.COLUMN_NAME,
    def: defaultLiteral(r.DATA_TYPE, r.COLUMN_TYPE),
  }));
  return requiredCols;
}

/** Net wallet balance = SUM(Credit) - SUM(Debit) for this driver's wallet rows. */
const BALANCE_SUBQUERY = `
  COALESCE((
    SELECT SUM(CASE WHEN w.eType = 'Credit' THEN CAST(w.iBalance AS DECIMAL(14,2))
                    ELSE -CAST(w.iBalance AS DECIMAL(14,2)) END)
      FROM user_wallet w
     WHERE w.iUserId = d.iDriverId AND w.eUserType = 'Driver'
  ), 0)`;

/** Number of non-deleted vehicles the driver owns (`driver_vehicle`). */
const VEHICLE_COUNT_SUBQUERY = `
  COALESCE((
    SELECT COUNT(*) FROM driver_vehicle dv
     WHERE dv.iDriverId = d.iDriverId AND dv.eStatus <> 'Deleted'
  ), 0)`;

/** 1 when the driver has at least one active, non-empty uploaded document. */
const HAS_DOCUMENT_SUBQUERY = `
  EXISTS (
    SELECT 1 FROM document_list dl
     WHERE dl.doc_usertype = 'driver'
       AND dl.doc_userid = d.iDriverId
       AND dl.status = 'Active'
       AND dl.doc_file <> ''
  )`;

/** Count of Active documents (with ex_status='yes') whose expiry is past today. */
const DOC_EXPIRED_COUNT_SUBQUERY = `
  COALESCE((
    SELECT COUNT(*) FROM document_list dl
      JOIN document_master dm ON dm.doc_masterid = dl.doc_masterid
     WHERE dl.doc_usertype = 'driver'
       AND dl.doc_userid = d.iDriverId
       AND dl.status = 'Active'
       AND dl.doc_file <> ''
       AND dm.ex_status = 'yes'
       AND dl.ex_date > '2000-01-01'
       AND dl.ex_date < CURDATE()
  ), 0)`;

/** Count of Active documents (with ex_status='yes') expiring within 30 days. */
const DOC_EXPIRING_SOON_COUNT_SUBQUERY = `
  COALESCE((
    SELECT COUNT(*) FROM document_list dl
      JOIN document_master dm ON dm.doc_masterid = dl.doc_masterid
     WHERE dl.doc_usertype = 'driver'
       AND dl.doc_userid = d.iDriverId
       AND dl.status = 'Active'
       AND dl.doc_file <> ''
       AND dm.ex_status = 'yes'
       AND dl.ex_date > '2000-01-01'
       AND dl.ex_date >= CURDATE()
       AND dl.ex_date <= CURDATE() + INTERVAL 30 DAY
  ), 0)`;

/** Banking / profile text — only ever rendered on the driver detail screens. */
const DETAIL_COLUMNS = `
         COALESCE(d.vPaymentEmail, '') AS paymentEmail,
         COALESCE(d.vBankAccountHolderName, '') AS accountHolderName,
         COALESCE(d.vAccountNumber, '') AS accountNumber,
         COALESCE(d.vBankName, '') AS bankName,
         COALESCE(d.vBankLocation, '') AS bankLocation,
         COALESCE(d.vBIC_SWIFT_Code, '') AS swiftCode,
         COALESCE(d.tProfileDescription, '') AS description,`;

const SELECT_HEAD = `
  SELECT d.iDriverId, d.vName, d.vLastName, d.vEmail, d.vPhone, d.vCompany,
         d.vCarType, d.vAvailability, d.eStatus, d.eIsFeatured, d.vImage,
         d.eGender AS gender,
         DATE_FORMAT(d.dBirthDate, '%Y-%m-%d') AS birthDate,
         d.vCaddress AS address, d.vCadress2 AS address2,
         d.vCity AS city, d.vState AS state, d.vZip AS zip, d.vCountry AS country,
         COALESCE(d.vCode, '') AS phoneCode,
         COALESCE(d.vLang, '') AS language,
         COALESCE(d.vCurrencyDriver, '') AS currency,`;

const SELECT_TAIL = `
         COALESCE(d.iCompanyId, 0) AS companyId,
         COALESCE((SELECT c.vCompany FROM company c WHERE c.iCompanyId = d.iCompanyId), '') AS companyName,
         ${VEHICLE_COUNT_SUBQUERY} AS vehicleCount,
         ${HAS_DOCUMENT_SUBQUERY} AS hasDocument,
         ${DOC_EXPIRED_COUNT_SUBQUERY} AS docExpiredCount,
         ${DOC_EXPIRING_SOON_COUNT_SUBQUERY} AS docExpiringSoonCount,
         DATE_FORMAT(d.tRegistrationDate, '%Y-%m-%d %H:%i') AS tRegistrationDate,
         ${BALANCE_SUBQUERY} AS walletBalance
    FROM register_driver d`;

const BASE_SELECT = `${SELECT_HEAD}${DETAIL_COLUMNS}${SELECT_TAIL}`;

/**
 * List projection: same shape as BASE_SELECT but WITHOUT the banking/profile
 * text columns (they bloat every list page and only the detail endpoints are
 * allowed to carry them; the controller's `toDto` defaults them to "").
 */
const LIST_SELECT = `${SELECT_HEAD}${SELECT_TAIL}`;

export async function listDrivers(): Promise<DriverRow[]> {
  return query<DriverRow>(`${LIST_SELECT} WHERE d.eStatus <> 'Deleted' ORDER BY d.iDriverId DESC`);
}

export interface DriverListFilters {
  /** Partial name / email / phone / company / car type, already trimmed. */
  search: string;
  /** Restrict to one status (undefined keeps every non-deleted status). */
  status?: Exclude<DriverStatus, "Deleted">;
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params for page/count so they never drift. */
function buildFilters(f: DriverListFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["d.eStatus <> 'Deleted'"];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("d.eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push(
      "(d.vName LIKE ? OR d.vLastName LIKE ? OR d.vEmail LIKE ? OR d.vPhone LIKE ? OR d.vCompany LIKE ? OR d.vCarType LIKE ?)",
    );
    const p = likePattern(f.search);
    params.push(p, p, p, p, p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One filtered page of drivers (newest first) for the paginated admin listing. */
export async function listDriverPage(
  filters: DriverListFilters & { page: number; limit: number },
): Promise<DriverRow[]> {
  const { where, params } = buildFilters(filters);
  const offset = (filters.page - 1) * filters.limit;
  return query<DriverRow>(
    `${LIST_SELECT} ${where} ORDER BY d.iDriverId DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit, offset],
  );
}

/** Total non-deleted drivers matching the same filters (for the page count). */
export async function countDrivers(filters: DriverListFilters): Promise<number> {
  const { where, params } = buildFilters(filters);
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM register_driver d ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

export async function findRow(id: number): Promise<DriverRow | null> {
  const rows = await query<DriverRow>(`${BASE_SELECT} WHERE d.iDriverId = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** The stored photo filename for a driver (bare name, e.g. `1695714461.jpg`), or null. */
export async function getDriverPhoto(id: number): Promise<string | null> {
  const rows = await query<{ vImage: string | null }>(
    "SELECT vImage FROM register_driver WHERE iDriverId = ? LIMIT 1",
    [id],
  );
  const f = rows[0]?.vImage?.trim();
  return f ? f : null;
}

/** Point `vImage` at the newly uploaded photo filename. */
export async function setDriverPhoto(id: number, filename: string): Promise<void> {
  await execute("UPDATE register_driver SET vImage = ? WHERE iDriverId = ?", [filename, id]);
}

export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptId
    ? `SELECT 1 AS hit FROM register_driver
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iDriverId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM register_driver
        WHERE vEmail = ? AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

export async function nextDriverId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iDriverId) AS max FROM register_driver",
  );
  return (rows[0]?.max ?? 0) + 1;
}

export interface CreateDriverInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  carType: string;
  status: Exclude<DriverStatus, "Deleted">;
  availability: Availability;
  passwordHash?: string;
  gender: string;
  birthDate: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phoneCode: string;
  language: string;
  currency: string;
  paymentEmail: string;
  accountHolderName: string;
  accountNumber: string;
  bankName: string;
  bankLocation: string;
  swiftCode: string;
  description: string;
  companyId: number;
}

/** Insert a driver, supplying every strict-mode NOT NULL column explicitly. */
export async function createDriver(input: CreateDriverInput): Promise<number> {
  const id = await nextDriverId();
  const cols = await getRequiredCols();

  const overrides: Record<string, string | number> = {
    iDriverId: id,
    eRefType: "Driver",
    vName: input.firstName,
    vLastName: input.lastName,
    vEmail: input.email,
    vPhone: input.phone,
    vCompany: input.company,
    vCarType: input.carType,
    vAvailability: input.availability,
    eStatus: input.status,
    vPassword: input.passwordHash ?? "",
    eGender: input.gender,
    vCaddress: input.address,
    vCadress2: input.address2,
    vCity: input.city,
    vState: input.state,
    vZip: input.zip,
    vCountry: input.country,
    vCode: input.phoneCode,
    vLang: input.language,
    vCurrencyDriver: input.currency,
    vPaymentEmail: input.paymentEmail,
    vBankAccountHolderName: input.accountHolderName,
    vAccountNumber: input.accountNumber,
    vBankName: input.bankName,
    vBankLocation: input.bankLocation,
    vBIC_SWIFT_Code: input.swiftCode,
    tProfileDescription: input.description,
    iCompanyId: input.companyId,
  };
  // dBirthDate is NOT NULL; the required-cols default ('1000-01-01') is used as
  // the "unknown" sentinel, so only override when a real date was supplied.
  if (input.birthDate) overrides.dBirthDate = input.birthDate;

  const colNames: string[] = [];
  const placeholders: string[] = [];
  const params: (string | number)[] = [];
  const requiredSet = new Set(cols.map((c) => c.col));
  for (const c of cols) {
    colNames.push(c.col);
    if (Object.prototype.hasOwnProperty.call(overrides, c.col)) {
      placeholders.push("?");
      params.push(overrides[c.col]);
    } else {
      placeholders.push(c.def);
    }
  }

  // Some override columns (e.g. eStatus) have a DB default, so they are NOT in
  // the strict-required set. Append them explicitly, otherwise the override is
  // silently dropped and every created driver falls back to the column default.
  for (const [col, value] of Object.entries(overrides)) {
    if (requiredSet.has(col)) continue;
    colNames.push(col);
    placeholders.push("?");
    params.push(value);
  }

  await execute(
    `INSERT INTO register_driver (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})`,
    params,
  );
  return id;
}

export interface UpdateDriverInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  carType: string;
  gender: string;
  birthDate: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phoneCode: string;
  language: string;
  currency: string;
  paymentEmail: string;
  accountHolderName: string;
  accountNumber: string;
  bankName: string;
  bankLocation: string;
  swiftCode: string;
  description: string;
  companyId: number;
}

export async function updateDriver(id: number, input: UpdateDriverInput): Promise<void> {
  await execute(
    `UPDATE register_driver
       SET vName = ?, vLastName = ?, vEmail = ?, vPhone = ?, vCompany = ?, vCarType = ?,
           eGender = ?, vCaddress = ?, vCadress2 = ?, vCity = ?, vState = ?, vZip = ?, vCountry = ?,
           dBirthDate = ?, vCode = ?, vLang = ?, vCurrencyDriver = ?, vPaymentEmail = ?,
           vBankAccountHolderName = ?, vAccountNumber = ?, vBankName = ?, vBankLocation = ?,
           vBIC_SWIFT_Code = ?, tProfileDescription = ?, iCompanyId = ?
     WHERE iDriverId = ?`,
    [
      input.firstName,
      input.lastName,
      input.email,
      input.phone,
      input.company,
      input.carType,
      input.gender,
      input.address,
      input.address2,
      input.city,
      input.state,
      input.zip,
      input.country,
      // NOT NULL column — fall back to the "unknown" sentinel when cleared.
      input.birthDate || "1000-01-01",
      input.phoneCode,
      input.language,
      input.currency,
      input.paymentEmail,
      input.accountHolderName,
      input.accountNumber,
      input.bankName,
      input.bankLocation,
      input.swiftCode,
      input.description,
      input.companyId,
      id,
    ],
  );
}

export async function setStatus(id: number, status: DriverStatus): Promise<void> {
  await execute("UPDATE register_driver SET eStatus = ? WHERE iDriverId = ?", [status, id]);
}

export async function setAvailability(id: number, availability: Availability): Promise<void> {
  await execute("UPDATE register_driver SET vAvailability = ? WHERE iDriverId = ?", [
    availability,
    id,
  ]);
}

/** Legacy `register_driver`.`eIsFeatured` is a Yes/No enum. */
export async function setFeatured(id: number, featured: boolean): Promise<void> {
  await execute("UPDATE register_driver SET eIsFeatured = ? WHERE iDriverId = ?", [
    featured ? "Yes" : "No",
    id,
  ]);
}

export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE register_driver SET eStatus = 'Deleted' WHERE iDriverId = ?", [id]);
}

// ---------------------------------------------------------------------------
// Wallet (user_wallet with eUserType = 'Driver'; also has no AUTO_INCREMENT).
// ---------------------------------------------------------------------------

export async function nextWalletId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iUserWalletId) AS max FROM user_wallet",
  );
  return (rows[0]?.max ?? 0) + 1;
}

export interface AddWalletInput {
  driverId: number;
  amount: number;
  eFor: string;
  description: string;
}

export async function addWalletBalance(input: AddWalletInput): Promise<number> {
  const id = await nextWalletId();
  await execute(
    `INSERT INTO user_wallet
       (iUserWalletId, iUserId, eUserType, iBalance, eType, eFor, tDescription, ePaymentStatus,
        dDate, iTripId, iOrderId, iTransactionId, fromUserId, fromUserType,
        iBiddingPostId, iRentItemPostId, iTmpRentItemPostId, iBookingId)
     VALUES (?, ?, 'Driver', ?, 'Credit', ?, ?, 'Settelled', NOW(), 0, 0, '', 0, 'Driver', 0, 0, 0, 0)`,
    [id, input.driverId, input.amount.toFixed(2), input.eFor, input.description],
  );
  return id;
}

export async function listWalletTransactions(driverId: number): Promise<WalletTransactionRow[]> {
  return query<WalletTransactionRow>(
    `SELECT iUserWalletId, eType, eFor,
            CAST(iBalance AS DECIMAL(14,2)) AS amount, tDescription,
            DATE_FORMAT(dDate, '%Y-%m-%d %H:%i') AS dDate
       FROM user_wallet
      WHERE iUserId = ? AND eUserType = 'Driver'
      ORDER BY iUserWalletId DESC
      LIMIT 20`,
    [driverId],
  );
}

// ---------------------------------------------------------------------------
// Driver documents (prepared `document_master` catalog + `document_list` uploads).
// ---------------------------------------------------------------------------

/**
 * All active driver document types, each LEFT JOINed with the driver's most
 * recent (highest doc_id) non-deleted upload from `document_list`.
 */
export async function listDriverDocuments(driverId: number): Promise<DriverDocumentRow[]> {
  return query<DriverDocumentRow>(
    `SELECT m.doc_masterid AS masterId,
            m.doc_name AS name,
            m.eType AS serviceType,
            m.doc_usertype AS userType,
            dl.doc_id AS docId,
            dl.doc_file AS docFile,
            DATE_FORMAT(dl.ex_date, '%Y-%m-%d') AS exDate,
            dl.status AS docStatus,
            dl.vRejectReason AS rejectReason
       FROM document_master m
       LEFT JOIN document_list dl
         ON dl.doc_masterid = m.doc_masterid
        AND dl.doc_usertype = 'driver'
        AND dl.doc_userid = ?
        AND dl.status <> 'Deleted'
        AND dl.doc_id = (
          SELECT MAX(d2.doc_id)
            FROM document_list d2
           WHERE d2.doc_masterid = m.doc_masterid
             AND d2.doc_usertype = 'driver'
             AND d2.doc_userid = ?
             AND d2.status <> 'Deleted'
        )
      WHERE m.doc_usertype = 'driver' AND m.status = 'Active'
      ORDER BY m.iDisplayOrder, m.doc_masterid`,
    [driverId, driverId],
  );
}

/** The stored filename for one uploaded document, scoped to the owning driver. */
export async function getDriverDocFile(
  docId: number,
  driverId: number,
): Promise<string | null> {
  const rows = await query<{ docFile: string | null }>(
    `SELECT doc_file AS docFile FROM document_list
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'driver'
        AND status <> 'Deleted'
      LIMIT 1`,
    [docId, driverId],
  );
  const f = rows[0]?.docFile?.trim();
  return f ? f : null;
}

/**
 * Approve / reject one uploaded driver document (scoped to the owning driver).
 * `reason` is stored alongside a rejection and cleared on approval.
 * Returns the number of rows updated (0 when the doc does not belong to the driver).
 */
export async function setDriverDocStatus(
  docId: number,
  driverId: number,
  status: "Active" | "Inactive",
  reason: string,
): Promise<number> {
  const res = await execute(
    `UPDATE document_list
        SET status = ?, vRejectReason = ?
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'driver'
        AND status <> 'Deleted'`,
    [status, status === "Inactive" ? reason : "", docId, driverId],
  );
  return res.affectedRows ?? 0;
}

/** Legacy placeholder used when a required date column has no real value. */
const DOC_DATE_SENTINEL = "1000-01-01";

/** True when `masterId` is an active driver document type in the catalog. */
export async function isValidDriverDocType(masterId: number): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM document_master
      WHERE doc_masterid = ? AND doc_usertype = 'driver' AND status = 'Active'
      LIMIT 1`,
    [masterId],
  );
  return rows.length > 0;
}

/**
 * Attach (or replace) an uploaded file for one driver document type.
 * A new upload resets the row to "pending review" (status Inactive, reason
 * cleared) so it must be re-approved. When no row exists yet a fresh
 * `document_list` row is inserted (doc_id is not auto-increment, so it is
 * derived as MAX + 1). `exDate` is a YYYY-MM-DD string or blank.
 */
export async function upsertDriverDocUpload(
  driverId: number,
  masterId: number,
  docFile: string,
  exDate: string,
): Promise<void> {
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(exDate) ? exDate : DOC_DATE_SENTINEL;
  const existing = await query<{ doc_id: number }>(
    `SELECT doc_id FROM document_list
      WHERE doc_masterid = ? AND doc_usertype = 'driver' AND doc_userid = ?
        AND status <> 'Deleted'
      ORDER BY doc_id DESC LIMIT 1`,
    [masterId, driverId],
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
     VALUES (?, ?, 'driver', ?, ?, ?, 'Inactive', ?, '', ?, '')`,
    [next[0].nid, masterId, driverId, expiry, docFile, DOC_DATE_SENTINEL, DOC_DATE_SENTINEL],
  );
}

// ---------------------------------------------------------------------------
// Manage Provider Services (additive `provider_service` link → service_categories).
// ---------------------------------------------------------------------------

export async function listServiceCategories(): Promise<ServiceCategoryRow[]> {
  return query<ServiceCategoryRow>(
    `SELECT iServiceId, vService AS name
       FROM service_categories
      WHERE eStatus = 'Active'
      ORDER BY iDisplayOrder, iServiceId`,
  );
}

/** A `{id, name}` entry for the create/edit pickers (companies or stores). */
export interface CompanyOption {
  id: number;
  name: string;
  /** Industry of a store row (0 for plain companies). */
  serviceId: number;
}

/**
 * Company rows (`iServiceId = 0`, the legacy "Default Company" style owner) and
 * the store rows belonging to one service. `register_driver.iCompanyId` points
 * at either kind of `company` row, so the form offers both lists and writes the
 * single chosen id.
 */
export async function listCompanyOptions(serviceId: number): Promise<{
  companies: CompanyOption[];
  stores: CompanyOption[];
}> {
  const companies = await query<CompanyOption>(
    `SELECT iCompanyId AS id, vCompany AS name, 0 AS serviceId
       FROM company
      WHERE iServiceId = 0 AND eStatus <> 'Deleted'
      ORDER BY vCompany`,
  );
  if (!serviceId) return { companies, stores: [] };
  const stores = await query<CompanyOption>(
    `SELECT iCompanyId AS id, vCompany AS name, iServiceId AS serviceId
       FROM company
      WHERE iServiceId = ? AND eStatus <> 'Deleted'
      ORDER BY vCompany`,
    [serviceId],
  );
  return { companies, stores };
}

/**
 * Service categories for the create/edit picker, labelled the same way the
 * store module labels its industries (English name, ordered by id).
 */
export async function listServiceOptions(): Promise<{ id: number; name: string }[]> {
  return query<{ id: number; name: string }>(
    `SELECT iServiceId AS id, vServiceName_EN AS name FROM service_categories
      WHERE eStatus = 'Active' ORDER BY iServiceId`,
  );
}

export async function getDriverServiceIds(driverId: number): Promise<number[]> {
  const rows = await query<{ iServiceId: number }>(
    "SELECT iServiceId FROM provider_service WHERE iDriverId = ? ORDER BY iServiceId",
    [driverId],
  );
  return rows.map((r) => r.iServiceId);
}

/** Replace a driver's assigned service categories inside a single transaction. */
export async function setDriverServices(driverId: number, serviceIds: number[]): Promise<number[]> {
  const unique = [...new Set(serviceIds)].filter((n) => Number.isInteger(n) && n > 0);
  await withTransaction(async (conn) => {
    await conn.execute("DELETE FROM provider_service WHERE iDriverId = ?", [driverId]);
    for (const sid of unique) {
      await conn.execute(
        "INSERT INTO provider_service (iDriverId, iServiceId) VALUES (?, ?)",
        [driverId, sid],
      );
    }
  });
  return unique;
}
