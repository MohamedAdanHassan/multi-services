import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../../../db/mysql";

/**
 * Data access for Marketing Tools → Send Push-Notification (#sub-114), the legacy
 * `pushnotification_log` table plus the three audience tables a broadcast reads.
 *
 * What the live schema and the legacy screen (`admin368/send_notifications.php`)
 * say about this data:
 *  - The log is **one row per recipient**, not per broadcast: every historical
 *    row carries its own `iPushnotificationId` (verified — the fan-out of 14
 *    drivers on 2024-06-12 06:36:56 shares one timestamp but uses ids 72…85).
 *    The column is a plain `int NOT NULL` with **no primary key, no index and no
 *    AUTO_INCREMENT** (SHOW INDEX returns no rows), so ids come from MAX+1 and
 *    one send burns a run of them.
 *  - `eUserType` is enum('driver','rider','company'): unlike `newsfeed` there is
 *    **no 'all' member**, so "everyone" would have to be three sends, and the
 *    legacy panel never offered it. Rows are terminal — nothing references the
 *    log by id, and no delete path exists in the legacy UI, so a recorded
 *    notification is history the moment it is written.
 *  - `dDateTime` is `datetime NOT NULL` with no default: the writer supplies it,
 *    and every recipient of one send shares the same instant (the legacy code
 *    computed `date("Y-m-d H:i:s")` once). No ON UPDATE hazard here.
 *  - `IP_ADDRESS` varchar(225) NOT NULL held the sending admin's client IP.
 *  - A recipient only reaches the log when its `iGcmRegId` is non-empty — the
 *    legacy loop `continue`d on an empty registration id — and recipients are
 *    de-duplicated by `vFirebaseDeviceToken` "when same devicetoken then take
 *    only one who is logged in". Ordering by `eLogout DESC` achieves that
 *    because the enum's index order (Yes=1, No=2) puts logged-in rows first.
 *  - Audience eligibility mirrors the legacy list queries verbatim: an account
 *    must carry a contact address and must not be Deleted; stores must have a
 *    service and that service category must be Active. Segments are only
 *    selectors — `logged` is `eLogout='No'` and `inactive` is `eStatus`
 *    'Inactive', which matches the drivers' lowercase enum spelling because
 *    these columns are utf8mb3_general_ci (measured: the driver inactive count
 *    does come back for the 'inactive' rows).
 */

export type PushAudience = "driver" | "rider" | "company";
/** Selector within an audience; never stored, only used to pick recipients. */
export type PushSegment = "all" | "logged" | "inactive";

interface AudienceSpec {
  table: string;
  id: string;
  /** Display name expression — stores live in vCompany, never in vName. */
  name: string;
  /** Legacy eligibility, written exactly as the old panel wrote it. */
  where: string;
}

const SPECS: Record<PushAudience, AudienceSpec> = {
  driver: {
    table: "register_driver",
    id: "iDriverId",
    name: "TRIM(CONCAT_WS(' ', vName, vLastName))",
    where: "(vEmail <> '' OR vPhone <> '') AND eStatus <> 'Deleted'",
  },
  rider: {
    table: "register_user",
    id: "iUserId",
    name: "TRIM(CONCAT_WS(' ', vName, vLastName))",
    where: "(vEmail <> '' OR vName <> '' OR vPhone <> '') AND eStatus <> 'Deleted'",
  },
  company: {
    table: "company",
    id: "iCompanyId",
    name: "TRIM(vCompany)",
    where:
      "iServiceId > 0 AND eStatus <> 'Deleted' AND EXISTS (SELECT 1 FROM service_categories sc WHERE sc.iServiceId = company.iServiceId AND sc.eStatus = 'Active')",
  },
};

export interface RecipientRow {
  id: number;
  name: string;
  country: string;
  loggedIn: boolean;
  token: string;
}

export interface LogRow {
  id: number;
  audience: PushAudience;
  userId: number;
  message: string;
  dateTime: string;
  ip: string;
  recipient: string;
}

/** Segment predicate, or '' for "the whole audience". */
function segmentClause(segment: PushSegment): string {
  if (segment === "logged") return " AND eLogout = 'No'";
  if (segment === "inactive") return " AND eStatus = 'Inactive'";
  return "";
}

/**
 * Everyone in the audience who could actually receive a push, ordered so a
 * logged-in account wins a shared device token. `onlyTokened` is the legacy
 * gate (`iGcmRegId <> ''`); the preview also asks for the untokened count so the
 * panel can say who is silently not reached.
 */
export async function resolveAudience(
  audience: PushAudience,
  segment: PushSegment,
  country: string,
  onlyTokened: boolean,
): Promise<RecipientRow[]> {
  const spec = SPECS[audience];
  const params: unknown[] = [];
  let sql =
    `SELECT ${spec.id} AS id, ${spec.name} AS name, vCountry AS country, ` +
    `eLogout AS loggedOut, vFirebaseDeviceToken AS token FROM ${spec.table} ` +
    `WHERE ${spec.where}`;
  sql += segmentClause(segment);
  if (country) {
    sql += " AND vCountry = ?";
    params.push(country);
  }
  if (onlyTokened) sql += " AND iGcmRegId <> ''";
  sql += ` ORDER BY eLogout DESC, ${spec.id} ASC`;
  const rows = await query<Record<string, string | number | null>>(sql, params);
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    country: String(r.country ?? ""),
    loggedIn: String(r.loggedOut ?? "Yes") === "No",
    token: String(r.token ?? "").trim(),
  }));
}

/** Countries that actually appear in this audience, with their recipient counts. */
export async function audienceCountries(
  audience: PushAudience,
  segment: PushSegment,
): Promise<{ code: string; name: string; recipients: number }[]> {
  const spec = SPECS[audience];
  const rows = await query<{ code: string; name: string | null; c: number }>(
    `SELECT a.vCountry AS code, NULLIF(c.vCountry, '') AS name, COUNT(*) AS c
       FROM (SELECT vCountry FROM ${spec.table}
              WHERE ${spec.where}${segmentClause(segment)} AND iGcmRegId <> ''
                AND vCountry <> '') a
       LEFT JOIN country c ON c.vCountryCode = a.vCountry
      GROUP BY a.vCountry, c.vCountry
      ORDER BY c DESC, a.vCountry ASC`,
  );
  return rows.map((r) => ({
    code: String(r.code),
    // A code with no country row still has to be displayable.
    name: String(r.name ?? r.code),
    recipients: Number(r.c),
  }));
}

/** Insert one log row per recipient, ids allocated as a MAX+1 run. */
export async function insertLogRows(
  rows: { audience: PushAudience; userId: number; message: string }[],
  dateTime: string,
  ip: string,
): Promise<number> {
  if (!rows.length) return 0;
  return withTransaction(async (conn: PoolConnection) => {
    const [base] = await conn.query<RowDataPacket[]>(
      "SELECT COALESCE(MAX(iPushnotificationId), 0) + 1 AS bid FROM pushnotification_log",
    );
    const start = Number((base[0] as { bid: number } | undefined)?.bid ?? 1);
    const placeholders: string[] = [];
    const params: unknown[] = [];
    rows.forEach((row, i) => {
      placeholders.push("(?, ?, ?, ?, ?, ?)");
      params.push(start + i, row.audience, row.userId, row.message, dateTime, ip);
    });
    await conn.query(
      `INSERT INTO pushnotification_log
         (iPushnotificationId, eUserType, iUserId, tMessage, dDateTime, IP_ADDRESS)
       VALUES ${placeholders.join(", ")}`,
      params,
    );
    return rows.length;
  });
}

/** The stored instant of the newest send, so one write cannot straddle a second. */
export async function serverNow(): Promise<string> {
  const rows = await query<{ now: string }>(
    "SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now",
  );
  return String(rows[0]?.now ?? "");
}

/** Newest recorded notifications, with the recipient name resolved per audience. */
export async function recentLog(limit: number): Promise<LogRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT l.iPushnotificationId AS id, l.eUserType AS audience, l.iUserId AS userId,
            l.tMessage AS message, DATE_FORMAT(l.dDateTime, '%Y-%m-%d %H:%i') AS dateTime,
            l.IP_ADDRESS AS ip,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', d.vName, d.vLastName)), ''),
                     NULLIF(TRIM(c.vCompany), ''),
                     NULLIF(TRIM(CONCAT_WS(' ', u.vName, u.vLastName)), ''), '') AS recipient
       FROM pushnotification_log l
       LEFT JOIN register_driver d ON l.eUserType = 'driver'  AND d.iDriverId  = l.iUserId
       LEFT JOIN register_user   u ON l.eUserType = 'rider'   AND u.iUserId    = l.iUserId
       LEFT JOIN company         c ON l.eUserType = 'company' AND c.iCompanyId = l.iUserId
      ORDER BY l.iPushnotificationId DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    audience: String(r.audience ?? "") as PushAudience,
    userId: Number(r.userId),
    message: String(r.message ?? ""),
    dateTime: String(r.dateTime ?? ""),
    ip: String(r.ip ?? ""),
    // An id the audience table no longer has keeps showing itself: the log is
    // history and must stay readable even when the account is long gone.
    recipient: String(r.recipient ?? "") || `#${Number(r.userId)}`,
  }));
}

/** Whole-table totals, for the listing footer. */
export async function logTotals(): Promise<{ total: number; maxId: number }> {
  const rows = await query<{ total: number; maxId: number | null }>(
    "SELECT COUNT(*) AS total, MAX(iPushnotificationId) AS maxId FROM pushnotification_log",
  );
  return { total: Number(rows[0]?.total ?? 0), maxId: Number(rows[0]?.maxId ?? 0) };
}
