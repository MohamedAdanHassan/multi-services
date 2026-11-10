import { query, execute } from "../../../db/mysql";
import { nextAdminId } from "../../auth/models/administrators";

export type AdminStatus = "Active" | "Inactive" | "Deleted";

/** A joined view of an `administrators` row plus its resolved `admin_groups` name. */
export interface AdminRow {
  iAdminId: number;
  iGroupId: number;
  vFirstName: string;
  vLastName: string;
  vEmail: string;
  eStatus: AdminStatus;
  vContactNo: string;
  vCode: string;
  groupName: string | null;
}

export interface CreateAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  groupId: number;
  status: AdminStatus;
}

export interface UpdateAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  groupId: number;
  status: AdminStatus;
}

const BASE_SELECT = `
  SELECT a.iAdminId, a.iGroupId, a.vFirstName, a.vLastName, a.vEmail,
         a.eStatus, a.vContactNo, a.vCode, g.vGroup AS groupName
    FROM administrators a
    LEFT JOIN admin_groups g ON g.iGroupId = a.iGroupId`;

/** Every non-deleted administrator, newest columns joined with the role name. */
export async function listManageable(): Promise<AdminRow[]> {
  return query<AdminRow>(`${BASE_SELECT} WHERE a.eStatus <> 'Deleted' ORDER BY a.iAdminId`);
}

/** A single administrator row (regardless of status), or null. */
export async function findRow(id: number): Promise<AdminRow | null> {
  const rows = await query<AdminRow>(`${BASE_SELECT} WHERE a.iAdminId = ? LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** True when a non-deleted administrator already owns this email (optionally excluding one id). */
export async function emailTaken(email: string, exceptId?: number): Promise<boolean> {
  const sql = exceptId
    ? `SELECT 1 AS hit FROM administrators
        WHERE vEmail = ? AND eStatus <> 'Deleted' AND iAdminId <> ? LIMIT 1`
    : `SELECT 1 AS hit FROM administrators
        WHERE vEmail = ? AND eStatus <> 'Deleted' LIMIT 1`;
  const params = exceptId ? [email, exceptId] : [email];
  const rows = await query<{ hit: number }>(sql, params);
  return rows.length > 0;
}

/**
 * Insert a new administrator. The legacy `administrators` table has no
 * AUTO_INCREMENT (id derived via MAX+1) and many NOT NULL columns, so every
 * unused column is filled with its empty default — mirroring the auth model.
 */
export async function createAdmin(input: CreateAdminInput): Promise<number> {
  const id = await nextAdminId();
  await execute(
    `INSERT INTO administrators
      (iAdminId, iGroupId, vFirstName, vLastName, vEmail, vContactNo, vCode, vPassword,
       vCountry, vState, vCity, vAddress, vAddressLat, vAddressLong, fHotelServiceCharge,
       vPaymentEmail, vBankAccountHolderName, vAccountNumber, vBankName, vBankLocation,
       vBIC_SWIFT_Code, eStatus, eDefault, vPassword_token)
     VALUES (?, ?, ?, ?, ?, '', '', ?, '', '', '', '', '', '', 0, '', '', '', '', '', '', ?, 'No', '')`,
    [
      id,
      input.groupId,
      input.firstName,
      input.lastName,
      input.email,
      input.passwordHash,
      input.status,
    ],
  );
  return id;
}

/** Edit name, email, role and status. Never touches the password hash. */
export async function updateAdmin(id: number, input: UpdateAdminInput): Promise<void> {
  await execute(
    `UPDATE administrators
       SET vFirstName = ?, vLastName = ?, vEmail = ?, iGroupId = ?, eStatus = ?
     WHERE iAdminId = ?`,
    [input.firstName, input.lastName, input.email, input.groupId, input.status, id],
  );
}

export async function setStatus(id: number, status: AdminStatus): Promise<void> {
  await execute("UPDATE administrators SET eStatus = ? WHERE iAdminId = ?", [status, id]);
}

/** Soft delete: flip to 'Deleted' so the row disappears from the manageable list. */
export async function softDelete(id: number): Promise<void> {
  await execute("UPDATE administrators SET eStatus = 'Deleted' WHERE iAdminId = ?", [id]);
}
