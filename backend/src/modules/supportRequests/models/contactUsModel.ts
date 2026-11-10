import { query } from "../../../db/mysql";
import { buildWhere, countRows, dateCol, readDate, type ListFilters } from "./pageHelpers";

/**
 * Data access for the legacy `contactus` table (Support Requests →
 * Contact Us Form Requests, #sub-103). Read-only report: submissions from
 * app users and guests, newest first. `iMemberId` points at a driver or a
 * user depending on `eUserType`, so both joins are conditional and the
 * resolved sender name falls back to the names stored on the message itself.
 */

export interface ContactUsRow {
  id: number; // iContactusId
  name: string; // resolved: joined member name, else Firstname+Lastname
  email: string; // vEmail
  phone: string; // vPhone
  subject: string; // vSubject
  message: string; // tDescription
  userType: string; // eUserType ('Guest' etc.)
  system: string; // eSystem (which app the message came from)
  createdAt: string | null; // tRequestDate, formatted
}

const SEARCH_SQL =
  "(COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName), us.vName, CONCAT_WS(' ', c.vFirstname, c.vLastname)) LIKE ?" +
  " OR c.vEmail LIKE ? OR c.vPhone LIKE ? OR c.vSubject LIKE ?)";

const FROM_JOIN = `contactus c
  LEFT JOIN register_driver dr
    ON c.eUserType = 'Driver,Passenger' AND dr.iDriverId = c.iMemberId
  LEFT JOIN register_user us
    ON c.eUserType = 'Passenger' AND us.iUserId = c.iMemberId`;

const SELECT_COLUMNS = `c.iContactusId,
  COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName), us.vName,
           CONCAT_WS(' ', c.vFirstname, c.vLastname)) AS senderName,
  c.vEmail, c.vPhone, c.vSubject, c.tDescription,
  c.eUserType, c.eSystem, ${dateCol("c.tRequestDate")} AS createdAt`;

function mapRow(r: Record<string, string | number | null>): ContactUsRow {
  return {
    id: Number(r.iContactusId),
    name: String(r.senderName ?? "").trim(),
    email: String(r.vEmail ?? "").trim(),
    phone: String(r.vPhone ?? "").trim(),
    subject: String(r.vSubject ?? "").trim(),
    message: String(r.tDescription ?? "").trim(),
    userType: String(r.eUserType ?? ""),
    system: String(r.eSystem ?? ""),
    createdAt: readDate(r.createdAt),
  };
}

/** Search / date range plus the User Type dropdown filter. */
function contactUsWhere(f: ListFilters): { where: string; params: unknown[] } {
  const base = buildWhere(f, SEARCH_SQL, "c.tRequestDate");
  if (!f.userType) return base;
  return {
    where: `${base.where} AND c.eUserType = ?`,
    params: [...base.params, f.userType],
  };
}

/** One filtered page of submissions, newest first. */
export async function listContactUs(f: ListFilters): Promise<ContactUsRow[]> {
  const { where, params } = contactUsWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     ${where}
     ORDER BY c.tRequestDate DESC, c.iContactusId DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total submissions matching the same filters (for page count). */
export async function countContactUs(f: ListFilters): Promise<number> {
  const { where, params } = contactUsWhere(f);
  return countRows(FROM_JOIN, where, params);
}
