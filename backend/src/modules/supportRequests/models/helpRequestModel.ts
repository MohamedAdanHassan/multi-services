import { query } from "../../../db/mysql";
import { buildWhere, countRows, dateCol, readDate, type ListFilters } from "./pageHelpers";

/**
 * Data access for the legacy `trip_help_detail` table, which backs TWO Support
 * report pages that share one schema and are distinguished by which reference
 * id is populated:
 *  - "Trips/Jobs Help" (#sub-105): rows with `iTripId > 0` (booking context).
 *  - "Order Help" (#sub-106): rows with `iOrderId > 0` (order context).
 * Each row is a passenger ("User") asking for help about a specific trip/order,
 * tied to a canned reason (`iHelpDetailId` → `help_detail.vTitle_EN`) plus a
 * free-text comment. Read-only report; newest first.
 */

export type HelpLeg = "trip" | "order";

export interface HelpRequestRow {
  id: number; // iTripHelpDetailId
  refNo: string; // trips.vRideNo (trip) or orders.vOrderNo (order)
  refId: number; // iTripId / iOrderId (0 when the joined row is gone)
  userId: number; // iUserId
  userName: string; // joined register_user name ('' when unresolvable)
  email: string; // register_user email
  phone: string; // register_user phone
  reason: string; // help_detail reason title (EN)
  comment: string; // vComment
  createdAt: string | null; // tDate, formatted
}

function fromJoin(leg: HelpLeg): string {
  const ref =
    leg === "trip"
      ? "LEFT JOIN trips t ON t.iTripId = h.iTripId"
      : "LEFT JOIN orders o ON o.iOrderId = h.iOrderId";
  return `trip_help_detail h
    LEFT JOIN register_user us ON us.iUserId = h.iUserId
    LEFT JOIN help_detail hd ON hd.iHelpDetailId = h.iHelpDetailId
    ${ref}`;
}

function selectColumns(leg: HelpLeg): string {
  const refNo = leg === "trip" ? "IFNULL(t.vRideNo, '')" : "IFNULL(o.vOrderNo, '')";
  const refId = leg === "trip" ? "h.iTripId" : "h.iOrderId";
  return `h.iTripHelpDetailId, ${refNo} AS refNo, ${refId} AS refId, h.iUserId,
    CONCAT_WS(' ', us.vName, us.vLastName) AS userName,
    IFNULL(us.vEmail, '') AS email, IFNULL(us.vPhone, '') AS phone,
    IFNULL(hd.vTitle_EN, '') AS reason, h.vComment AS comment,
    ${dateCol("h.tDate")} AS createdAt`;
}

function mapRow(r: Record<string, string | number | null>): HelpRequestRow {
  return {
    id: Number(r.iTripHelpDetailId),
    refNo: String(r.refNo ?? "").trim(),
    refId: Number(r.refId ?? 0),
    userId: Number(r.iUserId ?? 0),
    userName: String(r.userName ?? "").trim(),
    email: String(r.email ?? "").trim(),
    phone: String(r.phone ?? "").trim(),
    reason: String(r.reason ?? "").trim(),
    comment: String(r.comment ?? "").trim(),
    createdAt: readDate(r.createdAt),
  };
}

function searchSql(leg: HelpLeg): string {
  const ref = leg === "trip" ? "t.vRideNo" : "o.vOrderNo";
  return `(CONCAT_WS(' ', us.vName, us.vLastName) LIKE ? OR us.vEmail LIKE ? OR us.vPhone LIKE ?
    OR IFNULL(hd.vTitle_EN, '') LIKE ? OR h.vComment LIKE ? OR ${ref} LIKE ?)`;
}

/** The leg discriminator (only trip rows or only order rows) + shared filters. */
function helpWhere(leg: HelpLeg, f: ListFilters): { where: string; params: unknown[] } {
  const base = buildWhere(f, searchSql(leg), "h.tDate");
  const legClause = leg === "trip" ? "h.iTripId > 0" : "h.iOrderId > 0";
  return { where: `${base.where} AND ${legClause}`, params: base.params };
}

/** One filtered page of help requests for the given leg, newest first. */
export async function listHelpRequests(leg: HelpLeg, f: ListFilters): Promise<HelpRequestRow[]> {
  const { where, params } = helpWhere(leg, f);
  const offset = (f.page - 1) * f.limit;
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${selectColumns(leg)} FROM ${fromJoin(leg)}
     ${where}
     ORDER BY h.tDate DESC, h.iTripHelpDetailId DESC
     LIMIT ? OFFSET ?`,
    [...params, f.limit, offset],
  );
  return rows.map(mapRow);
}

/** Total help requests matching the same filters (for page count). */
export async function countHelpRequests(leg: HelpLeg, f: ListFilters): Promise<number> {
  const { where, params } = helpWhere(leg, f);
  return countRows(fromJoin(leg), where, params);
}
