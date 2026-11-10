import { query, execute } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";

export type UserStatus = "Active" | "Inactive" | "Deleted";
export type UserType = "Driver" | "Rider";

/** A `register_user` row joined with its resolved wallet balance. */
export interface UserRow {
  iUserId: number;
  vName: string;
  vLastName: string;
  vEmail: string;
  vPhone: string;
  vPhoneCode: string;
  eGender: string;
  dBirthDate: string | null;
  eStatus: UserStatus;
  eRefType: UserType;
  tRegistrationDate: string | null;
  walletBalance: number;
}

/**
 * A user document type (from `document_master`) merged with the user's most
 * recent uploaded row from `document_list` (null docId when nothing uploaded).
 */
export interface UserDocumentRow extends RowDataPacket {
  masterId: number;
  name: string;
  serviceType: string;
  docId: number | null;
  docFile: string | null;
  exDate: string | null;
  docStatus: string | null;
  rejectReason: string | null;
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  gender: string;
  birthDate: string;
  userType: UserType;
  status: Exclude<UserStatus, "Deleted">;
  passwordHash?: string;
}

export interface UpdateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCode: string;
  gender: string;
  birthDate: string;
}

export interface WalletTransactionRow {
  iUserWalletId: number;
  eType: "Credit" | "Debit";
  eFor: string;
  amount: number;
  tDescription: string;
  dDate: string | null;
}

/** Net wallet balance = SUM(Credit) - SUM(Debit) for the user's own type. */
const BALANCE_SUBQUERY = `
  COALESCE((
    SELECT SUM(CASE WHEN w.eType = 'Credit' THEN CAST(w.iBalance AS DECIMAL(14,2))
                    ELSE -CAST(w.iBalance AS DECIMAL(14,2)) END)
      FROM user_wallet w
     WHERE w.iUserId = u.iUserId AND w.eUserType = u.eRefType
  ), 0)`;

const BASE_SELECT = `
  SELECT u.iUserId, u.vName, u.vLastName, u.vEmail, u.vPhone, u.vPhoneCode,
         u.eGender, DATE_FORMAT(u.dBirthDate, '%Y-%m-%d') AS dBirthDate,
         u.eStatus, u.eRefType,
         DATE_FORMAT(u.tRegistrationDate, '%Y-%m-%d %H:%i') AS tRegistrationDate,
         ${BALANCE_SUBQUERY} AS walletBalance
    FROM register_user u`;

/** Every non-deleted user with a live wallet balance, newest first. */
export async function listUsers(): Promise<UserRow[]> {
  return query<UserRow>(`${BASE_SELECT} WHERE u.eStatus <> 'Deleted' ORDER BY u.iUserId DESC`);
}

export interface UserListFilters {
  /** Partial name / email / phone, already trimmed. */
  search: string;
  /** Restrict to one status (undefined keeps Active + Inactive). */
  status?: Exclude<UserStatus, "Deleted">;
}

/** Escape user input for a LIKE pattern (MySQL default escape is backslash). */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Shared WHERE fragment + params for page/count so they never drift. */
function buildFilters(f: UserListFilters): { where: string; params: unknown[] } {
  const clauses: string[] = ["u.eStatus <> 'Deleted'"];
  const params: unknown[] = [];
  if (f.status) {
    clauses.push("u.eStatus = ?");
    params.push(f.status);
  }
  if (f.search) {
    clauses.push("(u.vName LIKE ? OR u.vLastName LIKE ? OR u.vEmail LIKE ? OR u.vPhone LIKE ?)");
    const p = likePattern(f.search);
    params.push(p, p, p, p);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/** One filtered page of users (newest first) for the paginated admin listing. */
export async function listUserPage(
  filters: UserListFilters & { page: number; limit: number },
): Promise<UserRow[]> {
  const { where, params } = buildFilters(filters);
  const offset = (filters.page - 1) * filters.limit;
  return query<UserRow>(
    `${BASE_SELECT} ${where} ORDER BY u.iUserId DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit, offset],
  );
}

/** Total non-deleted users matching the same filters (for the page count). */
export async function countUsers(filters: UserListFilters): Promise<number> {
  const { where, params } = buildFilters(filters);
  const rows = await query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM register_user u ${where}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

/** A single user row (regardless of status), or null. */
export async function findRow(id: number): Promise<UserRow | null> {
  const rows = await query<UserRow>(`${BASE_SELECT} WHERE u.iUserId = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/**
 * True when a non-deleted user already owns this email (optionally excluding one
 * id). Blank emails are never treated as taken — many legacy rows are empty.
 */
export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptId
    ? `SELECT 1 AS hit FROM register_user
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iUserId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM register_user
        WHERE vEmail = ? AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/** Legacy `register_user` has no AUTO_INCREMENT; derive the next id (MAX + 1). */
export async function nextUserId(): Promise<number> {
  const rows = await query<{ max: number | null }>("SELECT MAX(iUserId) AS max FROM register_user");
  return (rows[0]?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Every NOT NULL column that lacks a DB default. The server runs under
 * STRICT_TRANS_TABLES, so an INSERT must supply each one. Columns absent from
 * `overrides` fall back to the legacy "empty" default for their type.
 */
const REQUIRED_COLUMNS: { col: string; def: string }[] = [
  { col: "iCompanyId", def: "0" },
  { col: "iRefUserId", def: "0" },
  { col: "eRefType", def: "'Rider'" },
  { col: "iHotelId", def: "0" },
  { col: "vName", def: "''" },
  { col: "vLastName", def: "''" },
  { col: "vEmail", def: "''" },
  { col: "vPassword", def: "''" },
  { col: "vCountry", def: "''" },
  { col: "vState", def: "''" },
  { col: "vPhone", def: "''" },
  { col: "eGender", def: "''" },
  { col: "dBirthDate", def: "'1000-01-01'" },
  { col: "vImgName", def: "''" },
  { col: "iGcmRegId", def: "''" },
  { col: "vCallFromDriver", def: "''" },
  { col: "iSelectedCarType", def: "0" },
  { col: "tDestinationLatitude", def: "''" },
  { col: "tDestinationLongitude", def: "''" },
  { col: "tDestinationAddress", def: "''" },
  { col: "vInviteCode", def: "''" },
  { col: "vCouponCode", def: "''" },
  { col: "vLang", def: "''" },
  { col: "vPhoneCode", def: "''" },
  { col: "vZip", def: "''" },
  { col: "vPassToken", def: "''" },
  { col: "vCurrencyPassenger", def: "''" },
  { col: "iCabBookingId", def: "''" },
  { col: "iPackageTypeId", def: "0" },
  { col: "vReceiverName", def: "''" },
  { col: "vReceiverMobile", def: "''" },
  { col: "tPickUpIns", def: "''" },
  { col: "tDeliveryIns", def: "''" },
  { col: "tPackageDetails", def: "''" },
  { col: "vRefCode", def: "''" },
  { col: "dRefDate", def: "NOW()" },
  { col: "vLatitude", def: "''" },
  { col: "vLongitude", def: "''" },
  { col: "iUserVehicleId", def: "0" },
  { col: "vPasswordToken", def: "''" },
  { col: "tSessionId", def: "''" },
  { col: "vPassword_token", def: "''" },
  { col: "vRideCountry", def: "''" },
  { col: "tDeviceSessionId", def: "''" },
  { col: "vFirebaseDeviceToken", def: "''" },
  { col: "vTollPriceCurrencyCode", def: "''" },
  { col: "vTimeZone", def: "''" },
  { col: "tLocationUpdateDate", def: "NOW()" },
  { col: "dSendverificationDate", def: "NOW()" },
  { col: "dSendverificationDateEmergency", def: "NOW()" },
  { col: "vEmailVarificationCode", def: "''" },
  { col: "tApiFileName", def: "''" },
  { col: "tVersion", def: "''" },
  { col: "tDeviceData", def: "''" },
  { col: "vRecipientEmail", def: "''" },
  { col: "vTaskStatus", def: "''" },
  { col: "iBiddingPostId", def: "0" },
  { col: "iOTP", def: "0" },
  { col: "eHmsDevice", def: "'No'" },
  { col: "vOTP", def: "''" },
  { col: "eStatus", def: "'Active'" },
];

/** Insert a new user, filling every strict-mode NOT NULL column explicitly. */
export async function createUser(input: CreateUserInput): Promise<number> {
  const id = await nextUserId();

  // Columns driven by the request: value becomes a bound parameter.
  const overrides: Record<string, string | number> = {
    eRefType: input.userType,
    vName: input.firstName,
    vLastName: input.lastName,
    vEmail: input.email,
    vPassword: input.passwordHash ?? "",
    vPhone: input.phone,
    vPhoneCode: input.phoneCode,
    eGender: input.gender,
    dBirthDate: input.birthDate || "1000-01-01",
    eStatus: input.status,
  };

  const cols = ["iUserId", ...REQUIRED_COLUMNS.map((c) => c.col)];
  const placeholders: string[] = ["?"];
  const params: (string | number)[] = [id];
  for (const c of REQUIRED_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(overrides, c.col)) {
      placeholders.push("?");
      params.push(overrides[c.col]);
    } else {
      placeholders.push(c.def);
    }
  }

  await execute(
    `INSERT INTO register_user (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
    params,
  );
  return id;
}

/** Edit profile fields. Never touches password or status (handled elsewhere). */
export async function updateUser(id: number, input: UpdateUserInput): Promise<void> {
  await execute(
    `UPDATE register_user
       SET vName = ?, vLastName = ?, vEmail = ?, vPhone = ?, vPhoneCode = ?, eGender = ?, dBirthDate = ?
     WHERE iUserId = ?`,
    [
      input.firstName,
      input.lastName,
      input.email,
      input.phone,
      input.phoneCode,
      input.gender,
      input.birthDate || "1000-01-01",
      id,
    ],
  );
}

export async function setStatus(id: number, status: UserStatus): Promise<void> {
  await execute("UPDATE register_user SET eStatus = ? WHERE iUserId = ?", [status, id]);
}

/** Soft delete: flip to 'Deleted' so the row disappears from the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE register_user SET eStatus = 'Deleted' WHERE iUserId = ?", [id]);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/** Legacy `user_wallet` has no AUTO_INCREMENT either; derive the next id. */
export async function nextWalletId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iUserWalletId) AS max FROM user_wallet",
  );
  return (rows[0]?.max ?? 0) + 1;
}

export interface AddWalletInput {
  userId: number;
  userType: UserType;
  amount: number;
  eFor: string;
  description: string;
}

/** Record a Credit wallet transaction ("Add Wallet Balance"). */
export async function addWalletBalance(input: AddWalletInput): Promise<number> {
  const id = await nextWalletId();
  await execute(
    `INSERT INTO user_wallet
       (iUserWalletId, iUserId, eUserType, iBalance, eType, eFor, tDescription, ePaymentStatus,
        dDate, iTripId, iOrderId, iTransactionId, fromUserId, fromUserType,
        iBiddingPostId, iRentItemPostId, iTmpRentItemPostId, iBookingId)
     VALUES (?, ?, ?, ?, 'Credit', ?, ?, 'Settelled', NOW(), 0, 0, '', 0, ?, 0, 0, 0, 0)`,
    [
      id,
      input.userId,
      input.userType,
      input.amount.toFixed(2),
      input.eFor,
      input.description,
      input.userType,
    ],
  );
  return id;
}

/** The most recent wallet transactions for a user (for the dialog). */
export async function listWalletTransactions(userId: number): Promise<WalletTransactionRow[]> {
  return query<WalletTransactionRow>(
    `SELECT iUserWalletId, eType, eFor,
            CAST(iBalance AS DECIMAL(14,2)) AS amount, tDescription,
            DATE_FORMAT(dDate, '%Y-%m-%d %H:%i') AS dDate
       FROM user_wallet
      WHERE iUserId = ?
      ORDER BY iUserWalletId DESC
      LIMIT 20`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// User documents (document_master catalog + document_list uploads).
// ---------------------------------------------------------------------------

/** Legacy placeholder used when a required date column has no real value. */
const DOC_DATE_SENTINEL = "1000-01-01";

/**
 * All active user document types, each LEFT JOINed with the user's most
 * recent (highest doc_id) non-deleted upload from `document_list`.
 */
export async function listUserDocuments(userId: number): Promise<UserDocumentRow[]> {
  return query<UserDocumentRow>(
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
        AND dl.doc_usertype = 'user'
        AND dl.doc_userid = ?
        AND dl.status <> 'Deleted'
        AND dl.doc_id = (
          SELECT MAX(d2.doc_id)
            FROM document_list d2
           WHERE d2.doc_masterid = m.doc_masterid
             AND d2.doc_usertype = 'user'
             AND d2.doc_userid = ?
             AND d2.status <> 'Deleted'
        )
      WHERE m.doc_usertype = 'user' AND m.status = 'Active'
      ORDER BY m.iDisplayOrder, m.doc_masterid`,
    [userId, userId],
  );
}

/** The stored filename for one uploaded document, scoped to the owning user. */
export async function getUserDocFile(
  docId: number,
  userId: number,
): Promise<string | null> {
  const rows = await query<{ docFile: string | null }>(
    `SELECT doc_file AS docFile FROM document_list
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'user'
        AND status <> 'Deleted'
      LIMIT 1`,
    [docId, userId],
  );
  const f = rows[0]?.docFile?.trim();
  return f ? f : null;
}

/**
 * Approve / reject one uploaded user document (scoped to the owning user).
 * Returns the number of rows updated (0 when the doc does not belong to the user).
 */
export async function setUserDocStatus(
  docId: number,
  userId: number,
  status: "Active" | "Inactive",
  reason: string,
): Promise<number> {
  const res = await execute(
    `UPDATE document_list
        SET status = ?, vRejectReason = ?
      WHERE doc_id = ? AND doc_userid = ? AND doc_usertype = 'user'
        AND status <> 'Deleted'`,
    [status, status === "Inactive" ? reason : "", docId, userId],
  );
  return res.affectedRows ?? 0;
}

/** True when `masterId` is an active user document type in the catalog. */
export async function isValidUserDocType(masterId: number): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM document_master
      WHERE doc_masterid = ? AND doc_usertype = 'user' AND status = 'Active'
      LIMIT 1`,
    [masterId],
  );
  return rows.length > 0;
}

/**
 * Attach (or replace) an uploaded file for one user document type.
 * A new upload resets the row to "pending review" (status Inactive, reason
 * cleared) so it must be re-approved.
 */
export async function upsertUserDocUpload(
  userId: number,
  masterId: number,
  docFile: string,
  exDate: string,
): Promise<void> {
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(exDate) ? exDate : DOC_DATE_SENTINEL;
  const existing = await query<{ doc_id: number }>(
    `SELECT doc_id FROM document_list
      WHERE doc_masterid = ? AND doc_usertype = 'user' AND doc_userid = ?
        AND status <> 'Deleted'
      ORDER BY doc_id DESC LIMIT 1`,
    [masterId, userId],
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
     VALUES (?, ?, 'user', ?, ?, ?, 'Inactive', ?, '', ?, '')`,
    [next[0].nid, masterId, userId, expiry, docFile, DOC_DATE_SENTINEL, DOC_DATE_SENTINEL],
  );
}
