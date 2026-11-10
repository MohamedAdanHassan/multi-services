import { query, execute } from "../../../db/mysql";
import { nextAdminId } from "../../auth/models/administrators";

/**
 * Legacy `hotel` status enum. Note the column default is 'Active'.
 */
export type HotelStatus = "Active" | "Inactive" | "Deleted";

/**
 * A `hotel` row joined with the descriptive fields of its owner
 * (`administrators`, iGroupId = HOTEL_ADMIN_GROUP_ID). In this legacy schema a
 * "hotel" is a thin device/status record keyed to an admin-panel login; the
 * hotel's name / email / contact live on the `administrators` row.
 */
export interface HotelRow {
  iHotelId: number;
  iAdminId: number;
  firstName: string;
  lastName: string;
  email: string;
  contactNo: string;
  code: string;
  image: string;
  currency: string;
  language: string;
  avgRating: string;
  eStatus: HotelStatus;
  tRegistrationDate: string | null;
}

/** The `administrators` group id reserved for Hotel owners. */
export const HOTEL_ADMIN_GROUP_ID = 4;

/**
 * A new hotel to provision. The owner `administrators` login is created first
 * (name / email / contact / password); the `hotel` row then links to it and
 * carries the hotel-owned fields (currency / language / logo image / status).
 */
export interface CreateHotelInput {
  firstName: string;
  lastName: string;
  email: string;
  contactNo: string;
  code: string;
  passwordHash: string;
  status: Exclude<HotelStatus, "Deleted">;
  currency: string;
  language: string;
}

/** Hotel-owned + owner-descriptive fields editable after creation. */
export interface UpdateHotelInput {
  firstName: string;
  lastName: string;
  email: string;
  contactNo: string;
  code: string;
  currency: string;
  language: string;
}

/**
 * A hotel plus the minimal owner columns needed to route status / delete back
 * onto the `administrators` login.
 */
export interface HotelOwnerRef {
  iHotelId: number;
  iAdminId: number;
  eStatus: HotelStatus;
}

const BASE_SELECT = `
  SELECT h.iHotelId, h.iAdminId,
         COALESCE(a.vFirstName, '') AS firstName,
         COALESCE(a.vLastName, '')  AS lastName,
         COALESCE(a.vEmail, '')     AS email,
         COALESCE(a.vContactNo, '') AS contactNo,
         COALESCE(a.vCode, '')      AS code,
         COALESCE(h.vImgName, '')   AS image,
         COALESCE(h.vCurrencyPassenger, '') AS currency,
         COALESCE(h.vLang, '')      AS language,
         COALESCE(h.vAvgRating, '0.0') AS avgRating,
         h.eStatus,
         DATE_FORMAT(h.tRegistrationDate, '%Y-%m-%d %H:%i') AS tRegistrationDate
    FROM hotel h
    LEFT JOIN administrators a ON a.iAdminId = h.iAdminId`;

/** Every non-deleted hotel, newest first, with its owner's descriptive fields. */
export async function listHotels(): Promise<HotelRow[]> {
  return query<HotelRow>(
    `${BASE_SELECT} WHERE h.eStatus <> 'Deleted' ORDER BY h.iHotelId DESC`,
  );
}

/** A single hotel row (regardless of status), or null. */
export async function findRow(id: number): Promise<HotelRow | null> {
  const rows = await query<HotelRow>(`${BASE_SELECT} WHERE h.iHotelId = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** The hotel's owning admin id + status, used to mirror lifecycle onto the login. */
export async function findOwner(id: number): Promise<HotelOwnerRef | null> {
  const rows = await query<HotelOwnerRef>(
    `SELECT iHotelId, iAdminId, eStatus FROM hotel WHERE iHotelId = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** True when any non-deleted administrator already owns this email. */
export async function adminEmailTaken(email: string, exceptAdminId?: number): Promise<boolean> {
  const sql = exceptAdminId
    ? `SELECT 1 AS hit FROM administrators
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iAdminId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM administrators
        WHERE vEmail = ? AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptAdminId ? [email, exceptAdminId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/** True when this email is already the login of another non-deleted hotel. */
export async function hotelEmailTaken(email: string, exceptHotelId?: number): Promise<boolean> {
  if (!email.trim()) return false;
  const sql = exceptHotelId
    ? `SELECT 1 AS hit FROM hotel h
        JOIN administrators a ON a.iAdminId = h.iAdminId
        WHERE a.vEmail = ? AND h.eStatus <> 'Deleted' AND h.iHotelId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM hotel h
        JOIN administrators a ON a.iAdminId = h.iAdminId
        WHERE a.vEmail = ? AND h.eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptHotelId ? [email, exceptHotelId] : [email];
  return (await query<{ hit: number }>(sql, params)).length > 0;
}

/** Legacy `hotel` has no AUTO_INCREMENT; derive the next id (MAX + 1). */
export async function nextHotelId(): Promise<number> {
  const rows = await query<{ max: number | null }>("SELECT MAX(iHotelId) AS max FROM hotel");
  return (rows[0]?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Owner login provisioning (administrators, iGroupId = 4).
// ---------------------------------------------------------------------------

/**
 * Insert the hotel owner as an `administrators` login. The legacy table has no
 * AUTO_INCREMENT (id via MAX + 1) and many NOT NULL no-default columns, so
 * every unused column is filled with its empty default — mirroring the auth
 * model's INSERT column set exactly.
 */
async function createOwnerAdmin(
  input: Pick<CreateHotelInput, "firstName" | "lastName" | "email" | "contactNo" | "code" | "passwordHash">,
  status: Exclude<HotelStatus, "Deleted">,
): Promise<number> {
  const id = await nextAdminId();
  // 24 columns: the 7 descriptive ones + vPassword (bcrypt hash) + eStatus are
  // bound; every other NOT NULL no-default column is filled with its empty
  // legacy default — mirroring the auth/admin model's INSERT column set.
  await execute(
    `INSERT INTO administrators
      (iAdminId, iGroupId, vFirstName, vLastName, vEmail, vContactNo, vCode, vPassword,
       vCountry, vState, vCity, vAddress, vAddressLat, vAddressLong, fHotelServiceCharge,
       vPaymentEmail, vBankAccountHolderName, vAccountNumber, vBankName, vBankLocation,
       vBIC_SWIFT_Code, eStatus, eDefault, vPassword_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', 0, '', '', '', '', '', '', ?, 'No', '')`,
    [
      id,
      HOTEL_ADMIN_GROUP_ID,
      input.firstName,
      input.lastName,
      input.email,
      input.contactNo,
      input.code,
      input.passwordHash,
      status,
    ],
  );
  return id;
}

/**
 * Insert a new hotel row. Every NOT NULL column lacking a DB default is
 * supplied explicitly (STRICT_TRANS_TABLES); the meaningful ones are bound and
 * the rest fall back to legacy empty defaults.
 */
async function insertHotelRow(
  hotelId: number,
  adminId: number,
  status: Exclude<HotelStatus, "Deleted">,
  currency: string,
  language: string,
): Promise<void> {
  await execute(
    `INSERT INTO hotel
      (iHotelId, iAdminId, eStatus, vCurrencyPassenger, vLang,
       vCreditCard, vImgName, vVehicleTypeImg, vPickupFrom, iGcmRegId, iSelectedCarType,
       vZip, vPassToken, vPasswordToken, tSessionId, vPassword_token, tDeviceSessionId,
       vFirebaseDeviceToken, vTimeZone, vEmailVarificationCode,
       tLocationUpdateDate, dSendverificationDate)
     VALUES (?, ?, ?, ?, ?, '', '', '', '', '', 0, '', '', '', '', '', '', '', '', '', NOW(), NOW())`,
    [hotelId, adminId, status, currency, language],
  );
}

/**
 * Provision a hotel: create the owner `administrators` login, then a linked
 * `hotel` row. Returns the new hotel id.
 */
export async function createHotel(input: CreateHotelInput): Promise<number> {
  const adminId = await createOwnerAdmin(input, input.status);
  const hotelId = await nextHotelId();
  await insertHotelRow(hotelId, adminId, input.status, input.currency, input.language);
  return hotelId;
}

/** Update the owner login's descriptive fields (never touches the password). */
export async function updateOwnerAdmin(adminId: number, input: UpdateHotelInput): Promise<void> {
  await execute(
    `UPDATE administrators
        SET vFirstName = ?, vLastName = ?, vEmail = ?, vContactNo = ?, vCode = ?
      WHERE iAdminId = ?`,
    [input.firstName, input.lastName, input.email, input.contactNo, input.code, adminId],
  );
}

/** Update the hotel-owned fields (logo filename handled separately). */
export async function updateHotel(id: number, input: UpdateHotelInput): Promise<void> {
  await execute(
    `UPDATE hotel SET vCurrencyPassenger = ?, vLang = ? WHERE iHotelId = ?`,
    [input.currency, input.language, id],
  );
}

/** Set the stored logo filename for a hotel. */
export async function setHotelImage(id: number, filename: string): Promise<void> {
  await execute("UPDATE hotel SET vImgName = ? WHERE iHotelId = ?", [filename, id]);
}

/** The raw stored logo filename for a hotel, or null. */
export async function getHotelImage(id: number): Promise<string | null> {
  const rows = await query<{ img: string | null }>(
    "SELECT vImgName AS img FROM hotel WHERE iHotelId = ? LIMIT 1",
    [id],
  );
  const f = rows[0]?.img?.trim();
  return f ? f : null;
}

/**
 * Flip status on both the hotel row and its owner login (kept consistent so a
 * deactivated hotel cannot sign in).
 */
export async function setStatus(id: number, status: Exclude<HotelStatus, "Deleted">): Promise<void> {
  const owner = await findOwner(id);
  await execute("UPDATE hotel SET eStatus = ? WHERE iHotelId = ?", [status, id]);
  if (owner) {
    await execute("UPDATE administrators SET eStatus = ? WHERE iAdminId = ?", [status, owner.iAdminId]);
  }
}

/**
 * Soft delete: flip both the hotel row and its owner login to 'Deleted' so the
 * hotel disappears from the manageable list and the login is disabled.
 */
export async function softDelete(id: number): Promise<void> {
  const owner = await findOwner(id);
  await execute("UPDATE hotel SET eStatus = 'Deleted' WHERE iHotelId = ?", [id]);
  if (owner) {
    await execute("UPDATE administrators SET eStatus = 'Deleted' WHERE iAdminId = ?", [owner.iAdminId]);
  }
}
