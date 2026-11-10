import { query, execute } from "../../../db/mysql";
import type { AdministratorRow } from "../../../types/models";

/** Select a subset of columns — never expose more than the auth layer needs. */
const SAFE_COLUMNS = `iAdminId, iGroupId, vFirstName, vLastName, vEmail, vPassword, eStatus, vContactNo, vCode`;

export interface AdminSummary {
  iAdminId: number;
  iGroupId: number;
  vFirstName: string;
  vLastName: string;
  vEmail: string;
  vPassword: string;
  eStatus: AdministratorRow["eStatus"];
  vContactNo: string;
  vCode: string;
}

export async function findByEmail(email: string): Promise<AdminSummary | null> {
  const rows = await query<AdminSummary>(
    `SELECT ${SAFE_COLUMNS} FROM administrators WHERE vEmail = ? LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findById(id: number): Promise<AdminSummary | null> {
  const rows = await query<AdminSummary>(
    `SELECT ${SAFE_COLUMNS} FROM administrators WHERE iAdminId = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Only login-eligible accounts: Active status. */
export async function findActiveByEmail(email: string): Promise<AdminSummary | null> {
  const admin = await findByEmail(email);
  return admin && admin.eStatus === "Active" ? admin : null;
}

export async function updatePasswordHash(adminId: number, hash: string): Promise<void> {
  await execute("UPDATE administrators SET vPassword = ? WHERE iAdminId = ?", [hash, adminId]);
}

/** Legacy `administrators` has no AUTO_INCREMENT; derive the next id (MAX + 1). */
export async function nextAdminId(): Promise<number> {
  const rows = await query<{ max: number | null }>(
    "SELECT MAX(iAdminId) AS max FROM administrators",
  );
  return (rows[0]?.max ?? 0) + 1;
}

export interface CreateAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  contactNo: string;
  code: string;
  groupId: number;
  passwordHash: string;
}

export async function create(input: CreateAdminInput): Promise<number> {
  const id = await nextAdminId();
  await execute(
    `INSERT INTO administrators
      (iAdminId, iGroupId, vFirstName, vLastName, vEmail, vContactNo, vCode, vPassword,
       vCountry, vState, vCity, vAddress, vAddressLat, vAddressLong, fHotelServiceCharge,
       vPaymentEmail, vBankAccountHolderName, vAccountNumber, vBankName, vBankLocation,
       vBIC_SWIFT_Code, eStatus, eDefault, vPassword_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', 0, '', '', '', '', '', '', 'Active', 'No', '')`,
    [
      id,
      input.groupId,
      input.firstName,
      input.lastName,
      input.email,
      input.contactNo,
      input.code,
      input.passwordHash,
    ],
  );
  return id;
}

export async function list(): Promise<Omit<AdminSummary, "vPassword">[]> {
  const cols = SAFE_COLUMNS.replace(", vPassword", "");
  return query<Omit<AdminSummary, "vPassword">>(
    `SELECT ${cols} FROM administrators ORDER BY iAdminId`,
  );
}
