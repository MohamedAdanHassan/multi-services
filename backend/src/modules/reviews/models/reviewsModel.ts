import { query, execute } from "../../../db/mysql";

/**
 * Data access for Reviews (group 24): the legacy `ratings_user_driver` table,
 * read through two very different joins that back the two sub-groups.
 *
 * What the live schema and the legacy screens (`admin368/review.php` for
 * #sub-93 Reviews, `admin368/store_review.php` for #sub-94 Orders Reviews) say:
 *  - `iRatingId` is a plain `int NOT NULL` with **no primary key, no index and no
 *    AUTO_INCREMENT** — the same legacy shape as the push log. Nothing allocates
 *    ids here (reviews arrive from the apps), and this panel never inserts, so
 *    reads simply select by the stored id and the one UPDATE targets it directly.
 *  - `eStatus` is enum('Active','Deleted'): a **soft** marker. The listings hide
 *    'Deleted' unless the admin asks for it, and no delete route exists here
 *    because the sub-groups grant no delete permission.
 *  - `vRating1` is a varchar that holds a decimal string ("5.0", "4.5", …) or the
 *    empty string (26 rows). The rides screen keeps only `vRating1 <> ''`; the
 *    orders screen keeps every rating, including the blanks.
 *  - `tDate` is a plain `timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP` with **no
 *    ON UPDATE clause**, so editing a comment leaves the review date untouched.
 *  - The only thing the legacy "edit review" form writes is `vMessage` — never the
 *    star value — and this panel matches that: editing changes the comment only.
 *
 * The two screens pick rows by different columns:
 *  - Rides (#sub-93): the tab names the *reviewed* party and filters `eUserType`
 *    (which stores the *reviewer*). Tab "Driver" ⇒ `eUserType='Passenger'` (a
 *    passenger reviewed the driver); tab "Passenger" ⇒ `eUserType='Driver'`. Rows
 *    are joined through `trips` and restricted to `t.eSystem='General'`, and the
 *    reviewing rider must still exist (`ru.eStatus <> 'Deleted'`).
 *  - Orders (#sub-94): the tab filters `eToUserType` directly (Company/Driver/
 *    Passenger). Rows are joined through `orders` → `company`, and — exactly as the
 *    old `$ssql .= " AND c.iServiceId IN (…)"` line did — the reviewed store's
 *    service must be an *Active* `service_categories` row. The panel expresses
 *    that legacy hardcoded service-id list the same way the shipped push module
 *    already does: `EXISTS (… sc.eStatus = 'Active')`, keyed off the live enum
 *    rather than a copied theme constant.
 */

/** Rides screen tab: the party the review is *about*. */
export type RideSubject = "Driver" | "Passenger";
/** Orders screen tab: the party the review is *about*. */
export type OrderSubject = "Company" | "Driver" | "Passenger";

export type ReviewStatus = "Active" | "Deleted";

/** Whitelisted sort keys — mapped to fixed SQL, never to raw client text. */
export type SortKey = "default" | "ref" | "subject" | "reviewer" | "rating" | "date" | "message";
export type SortDir = "asc" | "desc";

export interface ReviewFilters {
  status: string; // "all" | "Active" | "Deleted"
  search: string;
  sort: SortKey;
  dir: SortDir;
}

export interface RideReviewRow {
  id: number;
  tripId: number;
  rideNo: string;
  rating: string;
  safetyRating: string;
  message: string;
  date: string;
  status: ReviewStatus;
  /** eUserType: who wrote it (the tab is who it was written about). */
  reviewerType: RideSubject;
  driverName: string;
  passengerName: string;
  driverAvg: string;
  passengerAvg: string;
}

export interface OrderReviewRow {
  id: number;
  orderId: number;
  orderNo: string;
  rating: string;
  safetyRating: string;
  message: string;
  date: string;
  status: ReviewStatus;
  reviewerType: string; // eFromUserType
  subjectType: string; // eToUserType
  companyName: string;
  driverName: string;
  passengerName: string;
  companyAvg: string;
}

export interface TabCounts {
  active: number;
  deleted: number;
  total: number;
}

/** A ride tab names the reviewed party; `eUserType` stores the reviewer, so flip. */
function rideReviewerFor(subject: RideSubject): RideSubject {
  return subject === "Driver" ? "Passenger" : "Driver";
}

function trim(v: unknown): string {
  return String(v ?? "").trim();
}

function status(v: unknown): ReviewStatus {
  return String(v) === "Deleted" ? "Deleted" : "Active";
}

/**
 * A `<> 'Deleted'` on a LEFT-JOINed account is intentionally strict: a NULL
 * (account gone) fails it, so reviews whose rider/company row no longer exists
 * drop out — the same effect the old `ru.eStatus!='Deleted'` had.
 */
const RIDES_FROM = `FROM ratings_user_driver r
  LEFT JOIN trips t ON r.iTripId = t.iTripId
  LEFT JOIN register_driver rd ON rd.iDriverId = t.iDriverId
  LEFT JOIN register_user ru ON ru.iUserId = t.iUserId`;
const RIDES_HARD = `t.eSystem = 'General' AND r.vRating1 <> '' AND ru.eStatus <> 'Deleted'`;

const ORDERS_FROM = `FROM ratings_user_driver r
  LEFT JOIN orders o ON r.iOrderId = o.iOrderId
  LEFT JOIN company c ON c.iCompanyId = o.iCompanyId
  LEFT JOIN register_driver rd ON rd.iDriverId = o.iDriverId
  LEFT JOIN register_user ru ON ru.iUserId = o.iUserId`;
const ORDERS_HARD =
  `ru.eStatus <> 'Deleted' AND ` +
  `EXISTS (SELECT 1 FROM service_categories sc WHERE sc.iServiceId = c.iServiceId AND sc.eStatus = 'Active')`;

/**
 * ORDER BY fragments, each sort key bound to the columns of one screen. Only the
 * fixed strings below ever reach the database, so an untrusted `sort` can only
 * select among them, never splice SQL. `ref`/`subject`/`reviewer` differ per
 * screen (ride no vs order no, reviewed party vs writer).
 */
function orderSql(
  screen: "rides" | "orders",
  subject: string,
  key: SortKey,
  dir: SortDir,
): string {
  const a = dir === "asc" ? "ASC" : "DESC";
  const subjectName =
    screen === "rides"
      ? subject === "Driver"
        ? "rd.vName"
        : "ru.vName"
      : subject === "Company"
        ? "c.vCompany"
        : subject === "Driver"
          ? "rd.vName"
          : "ru.vName";
  const reviewerName = screen === "rides" ? (subject === "Driver" ? "ru.vName" : "rd.vName") : "ru.vName";
  const ref = screen === "rides" ? "t.vRideNo" : "o.vOrderNo";
  switch (key) {
    case "ref":
      return ` ORDER BY ${ref} ${a}, r.iRatingId DESC`;
    case "subject":
      return ` ORDER BY ${subjectName} ${a}, r.iRatingId DESC`;
    case "reviewer":
      return ` ORDER BY ${reviewerName} ${a}, r.iRatingId DESC`;
    case "rating":
      // vRating1 is a decimal string; CAST keeps 5.0 above 4.5 and blanks last.
      return ` ORDER BY CAST(NULLIF(r.vRating1, '') AS DECIMAL(4,2)) ${a}, r.iRatingId DESC`;
    case "date":
      return ` ORDER BY r.tDate ${a}, r.iRatingId DESC`;
    case "message":
      return ` ORDER BY r.vMessage ${a}, r.iRatingId DESC`;
    default:
      return " ORDER BY r.iRatingId DESC";
  }
}

/** Columns the free-text search runs across, per screen and tab. */
function searchColumns(screen: "rides" | "orders", subject: string): string[] {
  const nameD = "CONCAT(rd.vName, ' ', rd.vLastName)";
  const nameU = "CONCAT(ru.vName, ' ', ru.vLastName)";
  if (screen === "rides") return ["t.vRideNo", nameD, nameU, "r.vRating1"];
  if (subject === "Company") return ["o.vOrderNo", "c.vCompany", nameU, "r.vRating1"];
  return ["o.vOrderNo", nameD, nameU, "r.vRating1"];
}

/**
 * Shared WHERE assembly for both screens. `params` is filled in the exact order
 * the placeholders appear: tab value, then status, then one term per search
 * column. The base hard filters carry no parameters.
 */
function buildWhere(
  screen: "rides" | "orders",
  subject: string,
  filters: ReviewFilters,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql: string;
  if (screen === "rides") {
    sql = " AND r.eUserType = ?";
    params.push(rideReviewerFor(subject as RideSubject));
  } else {
    sql = " AND r.eToUserType = ?";
    params.push(subject);
  }
  if (filters.status === "Active" || filters.status === "Deleted") {
    sql += " AND r.eStatus = ?";
    params.push(filters.status);
  } else {
    sql += " AND r.eStatus <> 'Deleted'";
  }
  const term = filters.search.trim();
  if (term) {
    const cols = searchColumns(screen, subject);
    sql += " AND (" + cols.map((c) => `${c} LIKE ?`).join(" OR ") + ")";
    for (let i = 0; i < cols.length; i++) params.push(`%${term}%`);
  }
  return { sql, params };
}

const RIDES_SELECT = `SELECT r.iRatingId AS id, r.iTripId AS tripId, t.vRideNo AS rideNo,
  r.vRating1 AS rating, r.vSafetyRating AS safetyRating, r.vMessage AS message,
  DATE_FORMAT(r.tDate, '%Y-%m-%d %H:%i') AS date, r.eUserType AS reviewerType, r.eStatus AS status,
  TRIM(CONCAT_WS(' ', rd.vName, rd.vLastName)) AS driverName,
  TRIM(CONCAT_WS(' ', ru.vName, ru.vLastName)) AS passengerName,
  rd.vAvgRating AS driverAvg, ru.vAvgRating AS passengerAvg`;

/** All ride reviews for a tab, after search + status + sort. */
export async function listRideReviews(subject: RideSubject, f: ReviewFilters): Promise<RideReviewRow[]> {
  const { sql, params } = buildWhere("rides", subject, f);
  const rows = await query<Record<string, string | number | null>>(
    `${RIDES_SELECT} ${RIDES_FROM} WHERE 1=1 AND ${RIDES_HARD}${sql}${orderSql("rides", subject, f.sort, f.dir)}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    tripId: Number(r.tripId ?? 0),
    rideNo: trim(r.rideNo),
    rating: trim(r.rating),
    safetyRating: trim(r.safetyRating),
    message: String(r.message ?? ""),
    date: r.date && !String(r.date).startsWith("0000") ? String(r.date) : "",
    status: status(r.status),
    reviewerType: String(r.reviewerType) === "Driver" ? "Driver" : "Passenger",
    driverName: trim(r.driverName),
    passengerName: trim(r.passengerName),
    driverAvg: trim(r.driverAvg),
    passengerAvg: trim(r.passengerAvg),
  }));
}

const ORDERS_SELECT = `SELECT r.iRatingId AS id, r.iOrderId AS orderId, o.vOrderNo AS orderNo,
  r.vRating1 AS rating, r.vSafetyRating AS safetyRating, r.vMessage AS message,
  DATE_FORMAT(r.tDate, '%Y-%m-%d %H:%i') AS date, r.eStatus AS status,
  r.eFromUserType AS reviewerType, r.eToUserType AS subjectType,
  TRIM(c.vCompany) AS companyName,
  TRIM(CONCAT_WS(' ', rd.vName, rd.vLastName)) AS driverName,
  TRIM(CONCAT_WS(' ', ru.vName, ru.vLastName)) AS passengerName,
  c.vAvgRating AS companyAvg`;

/** All order/store reviews for a tab, after search + status + sort. */
export async function listOrderReviews(subject: OrderSubject, f: ReviewFilters): Promise<OrderReviewRow[]> {
  const { sql, params } = buildWhere("orders", subject, f);
  const rows = await query<Record<string, string | number | null>>(
    `${ORDERS_SELECT} ${ORDERS_FROM} WHERE 1=1 AND ${ORDERS_HARD}${sql}${orderSql("orders", subject, f.sort, f.dir)}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    orderId: Number(r.orderId ?? 0),
    orderNo: trim(r.orderNo),
    rating: trim(r.rating),
    safetyRating: trim(r.safetyRating),
    message: String(r.message ?? ""),
    date: r.date && !String(r.date).startsWith("0000") ? String(r.date) : "",
    status: status(r.status),
    reviewerType: trim(r.reviewerType),
    subjectType: trim(r.subjectType),
    companyName: trim(r.companyName),
    driverName: trim(r.driverName),
    passengerName: trim(r.passengerName),
    companyAvg: trim(r.companyAvg),
  }));
}

/** Per-tab status totals, independent of search/sort, for the listing footer. */
export async function rideCounts(subject: RideSubject): Promise<TabCounts> {
  const rows = await query<{ status: string; n: number }>(
    `SELECT r.eStatus AS status, COUNT(*) AS n ${RIDES_FROM}
      WHERE 1=1 AND ${RIDES_HARD} AND r.eUserType = ? GROUP BY r.eStatus`,
    [rideReviewerFor(subject)],
  );
  return tally(rows);
}

export async function orderCounts(subject: OrderSubject): Promise<TabCounts> {
  const rows = await query<{ status: string; n: number }>(
    `SELECT r.eStatus AS status, COUNT(*) AS n ${ORDERS_FROM}
      WHERE 1=1 AND ${ORDERS_HARD} AND r.eToUserType = ? GROUP BY r.eStatus`,
    [subject],
  );
  return tally(rows);
}

function tally(rows: { status: string; n: number }[]): TabCounts {
  let active = 0;
  let deleted = 0;
  for (const r of rows) {
    if (String(r.status) === "Deleted") deleted += Number(r.n);
    else active += Number(r.n);
  }
  return { active, deleted, total: active + deleted };
}

/** Does this review id belong to the rides screen (a General-trip review)? */
export async function rideReviewExists(id: number): Promise<boolean> {
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one ${RIDES_FROM} WHERE r.iRatingId = ? AND ${RIDES_HARD} LIMIT 1`,
    [id],
  );
  return rows.length > 0;
}

/** Does this review id belong to the orders screen (an Active-service review)? */
export async function orderReviewExists(id: number): Promise<boolean> {
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one ${ORDERS_FROM} WHERE r.iRatingId = ? AND ${ORDERS_HARD} LIMIT 1`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Rewrite only the comment on one review. The star value, the date and the status
 * are never touched here — exactly the legacy "edit review", which updated
 * `vMessage` and nothing else. Returns the affected-row count (0 ⇒ unknown id).
 */
export async function updateComment(id: number, message: string): Promise<number> {
  const res = await execute("UPDATE ratings_user_driver SET vMessage = ? WHERE iRatingId = ?", [message, id]);
  return res.affectedRows;
}

/** The comment currently stored for a review, for the edit confirmation text. */
export async function currentComment(id: number): Promise<string | null> {
  const rows = await query<{ message: string | null }>(
    "SELECT vMessage AS message FROM ratings_user_driver WHERE iRatingId = ? LIMIT 1",
    [id],
  );
  if (!rows.length) return null;
  return String(rows[0].message ?? "");
}
