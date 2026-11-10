import { query } from "../../../db/mysql";
import {
  buildWhere,
  countRows,
  dateCol,
  likePattern,
  readDate,
  type ListFilters,
} from "./pageHelpers";

/**
 * Data access for the legacy `emergency_contact_data` table (Support
 * Requests → SOS Requests, #sub-104). Read-only report: panic/SOS messages
 * raised from the apps, each tied to a driver ("Service Provider") and/or a
 * user ("User") and optionally a trip. `vFromUserType` says who pressed the
 * button; `tMessage` carries the legacy-formatted "Important: <name> …" text.
 * The "Booking No" shown in the legacy panel is the trip's `vRideNo`, and the
 * "Contact Details" column is the requestor (driver or user) name/email/phone.
 */

export interface SosRow {
  id: number; // iEmergencyContactId
  fromType: string; // vFromUserType ('Driver' / 'Passenger' …)
  requestor: string; // joined driver or user name ('' when unresolvable)
  email: string; // requestor email (driver or user)
  phone: string; // requestor phone (driver or user)
  contactName: string; // vContactName (emergency contact to call)
  contactPhone: string; // vContactPhone
  userId: number; // iUserId
  driverId: number; // iDriverId
  tripId: number; // iTripId (0 when not trip-bound)
  rideNo: string; // joined trips.vRideNo ('' when no trip) — "Booking No"
  message: string; // tMessage
  createdAt: string | null; // tRequestDate, formatted
}

/** A user or driver that appears in at least one SOS record (for filters). */
export interface SosParticipant {
  id: number;
  name: string;
}

const SEARCH_SQL =
  "(COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName), CONCAT_WS(' ', us.vName, us.vLastName)) LIKE ?" +
  " OR COALESCE(dr.vEmail, us.vEmail) LIKE ? OR COALESCE(dr.vPhone, us.vPhone) LIKE ?" +
  " OR e.vContactName LIKE ? OR e.vContactPhone LIKE ? OR e.tMessage LIKE ?)";

const FROM_JOIN = `emergency_contact_data e
  LEFT JOIN register_driver dr ON dr.iDriverId = e.iDriverId
  LEFT JOIN register_user us ON us.iUserId = e.iUserId
  LEFT JOIN trips t ON t.iTripId = e.iTripId`;

const SELECT_COLUMNS = `e.iEmergencyContactId, e.vFromUserType,
  COALESCE(CONCAT_WS(' ', dr.vName, dr.vLastName),
           CONCAT_WS(' ', us.vName, us.vLastName)) AS requestorName,
  COALESCE(dr.vEmail, us.vEmail) AS requestorEmail,
  COALESCE(dr.vPhone, us.vPhone) AS requestorPhone,
  e.vContactName, e.vContactPhone, e.iUserId, e.iDriverId, e.iTripId,
  IFNULL(t.vRideNo, '') AS rideNo,
  e.tMessage, ${dateCol("e.tRequestDate")} AS createdAt`;

function mapRow(r: Record<string, string | number | null>): SosRow {
  return {
    id: Number(r.iEmergencyContactId),
    fromType: String(r.vFromUserType ?? ""),
    requestor: String(r.requestorName ?? "").trim(),
    email: String(r.requestorEmail ?? "").trim(),
    phone: String(r.requestorPhone ?? "").trim(),
    contactName: String(r.vContactName ?? "").trim(),
    contactPhone: String(r.vContactPhone ?? "").trim(),
    userId: Number(r.iUserId ?? 0),
    driverId: Number(r.iDriverId ?? 0),
    tripId: Number(r.iTripId ?? 0),
    rideNo: String(r.rideNo ?? ""),
    message: String(r.tMessage ?? "").trim(),
    createdAt: readDate(r.createdAt),
  };
}

/**
 * WHERE + params shared by the page and the COUNT: the common search/date
 * fragment plus the SOS-only equality (user / service provider) and trip-number
 * LIKE refinements.
 */
function sosWhere(f: ListFilters): { where: string; params: unknown[] } {
  const base = buildWhere(f, SEARCH_SQL, "e.tRequestDate");
  const extra: string[] = [];
  const params: unknown[] = [];
  if (f.userId) {
    extra.push("e.iUserId = ?");
    params.push(f.userId);
  }
  if (f.driverId) {
    extra.push("e.iDriverId = ?");
    params.push(f.driverId);
  }
  if (f.tripNumber) {
    extra.push("t.vRideNo LIKE ?");
    params.push(likePattern(f.tripNumber));
  }
  return extra.length
    ? { where: `${base.where} AND ${extra.join(" AND ")}`, params: [...base.params, ...params] }
    : base;
}

/** One filtered page of SOS requests, newest first. */
export async function listSos(f: ListFilters): Promise<SosRow[]> {
  const { where, params } = sosWhere(f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM ${FROM_JOIN}
     ${where}
     ORDER BY e.tRequestDate DESC, e.iEmergencyContactId DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total SOS requests matching the same filters (for page count). */
export async function countSos(f: ListFilters): Promise<number> {
  const { where, params } = sosWhere(f);
  return countRows(FROM_JOIN, where, params);
}

/**
 * Distinct users and drivers that actually appear in SOS records, for the
 * "Select User" / "Select Service Provider" filters. Scoping to participants
 * keeps the option lists tiny and every choice meaningful (a filter that
 * returned zero rows would never be offered).
 */
export async function listSosParticipants(): Promise<{
  users: SosParticipant[];
  providers: SosParticipant[];
}> {
  const users = await query<Record<string, string | number | null>>(
    `SELECT e.iUserId AS id, CONCAT_WS(' ', us.vName, us.vLastName) AS name
       FROM emergency_contact_data e
       LEFT JOIN register_user us ON us.iUserId = e.iUserId
      WHERE e.iUserId > 0
      GROUP BY e.iUserId, name
      ORDER BY name`,
  );
  const providers = await query<Record<string, string | number | null>>(
    `SELECT e.iDriverId AS id, CONCAT_WS(' ', dr.vName, dr.vLastName) AS name
       FROM emergency_contact_data e
       LEFT JOIN register_driver dr ON dr.iDriverId = e.iDriverId
      WHERE e.iDriverId > 0
      GROUP BY e.iDriverId, name
      ORDER BY name`,
  );
  const map = (rows: Record<string, string | number | null>[]): SosParticipant[] =>
    rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? "").trim() || `#${r.id}` }));
  return { users: map(users), providers: map(providers) };
}
