import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `newsfeed` table — the articles and in-app
 * announcements of Marketing Tools → News (#sub-112).
 *
 * What the live schema and data say about this table:
 *  - `iNewsfeedId` is a plain `int NOT NULL`: **no primary key, no index, no
 *    AUTO_INCREMENT** (verified with SHOW CREATE TABLE and SHOW INDEX, which
 *    returned no rows at all). New ids therefore come from MAX+1 over every row,
 *    soft-deleted ones included, so an id is never handed out twice.
 *  - `tPublishdate` is `timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE
 *    CURRENT_TIMESTAMP`. Any UPDATE that does not name the column moves the
 *    publish date to "now" — measured on a scratch copy of the schema: a plain
 *    status flip rewrote 2023-08-10 15:02:45 to the current time, while adding
 *    `tPublishdate = tPublishdate` kept it byte-for-byte. Every write below
 *    restates the column, because the admins' publish dates are data, not noise.
 *  - `eStatus` is enum('Active','Inactive','Deleted') — a real soft delete, so
 *    retiring an article never erases it. `'Deleted'` rows are filtered out of
 *    every read, the same way the other content tables hide them.
 *  - `eType` is enum('News','Notification') and `eUserType`
 *    enum('driver','rider','company','all') is NOT NULL **with no default**, so
 *    an INSERT must always name the audience.
 *  - `vTitle` / `tDescription` are longtexts holding per-language JSON maps
 *    (`{"vTitle_EN":"…","vTitle_AR":"…", …}` — note the differing prefixes), all
 *    26 languages this installation ships. This layer passes the blobs through
 *    verbatim; parsing and merging happen in the service.
 *  - `vNewfeedImage` is a bare filename under `<webImagesRoot>/newsfeed/`. Three
 *    of the four stored rows name a file that is no longer on disk, so a missing
 *    image is normal data, not an error.
 *  - No foreign key anywhere points at `newsfeed`, and no other table carries an
 *    `iNewsfeedId` column: these rows are terminal content.
 */

export type NewsStatus = "Active" | "Inactive";
export type NewsType = "News" | "Notification";
/** `eUserType` — which app's users see the row. */
export type NewsAudience = "driver" | "rider" | "company" | "all";

export interface NewsRow {
  id: number; // iNewsfeedId
  rawTitle: string; // vTitle (multilingual JSON, keys "vTitle_<CODE>")
  rawDescription: string; // tDescription (multilingual JSON, keys "tDescription_<CODE>")
  image: string; // vNewfeedImage (bare filename under <root>/newsfeed/)
  publishDate: string; // tPublishdate (YYYY-MM-DD HH:mm), '' for a legacy zero date
  status: NewsStatus; // eStatus (never 'Deleted' — hidden)
  type: NewsType; // eType
  audience: NewsAudience; // eUserType
}

/**
 * Seconds are deliberately dropped for display but never round-tripped: writes
 * restate the column with `tPublishdate = tPublishdate` instead of sending back
 * a formatted value, so no precision is lost by the save paths.
 */
const SELECT_COLUMNS = `iNewsfeedId, vTitle, tDescription, vNewfeedImage, eStatus, eType, eUserType,
  DATE_FORMAT(tPublishdate, '%Y-%m-%d %H:%i') AS publishDate`;

/** Live audiences, in the enum's own spelling. Anything else falls back to 'all'. */
const AUDIENCES: readonly string[] = ["driver", "rider", "company", "all"];

function mapRow(r: Record<string, string | number | null>): NewsRow {
  const date = String(r.publishDate ?? "");
  const audience = String(r.eUserType ?? "");
  return {
    id: Number(r.iNewsfeedId),
    rawTitle: String(r.vTitle ?? ""),
    rawDescription: String(r.tDescription ?? ""),
    image: String(r.vNewfeedImage ?? "").trim(),
    // A zero date arrives as "0000-00-00 00:00" through DATE_FORMAT; the driver
    // would throw on a raw zero timestamp, so only the formatted value is read.
    publishDate: date.startsWith("0000") ? "" : date,
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    type: r.eType === "Notification" ? "Notification" : "News",
    audience: (AUDIENCES.includes(audience) ? audience : "all") as NewsAudience,
  };
}

/** Every live article, newest publish date first. */
export async function listNews(): Promise<NewsRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM newsfeed
     WHERE eStatus <> 'Deleted'
     ORDER BY tPublishdate DESC, iNewsfeedId DESC`,
  );
  return rows.map(mapRow);
}

/** One live row, or null when missing / soft-deleted. */
export async function findNews(id: number): Promise<NewsRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM newsfeed
     WHERE iNewsfeedId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id: max over all rows, so soft-deleted ids are never reused. */
export async function nextNewsId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iNewsfeedId), 0) + 1 AS nid FROM newsfeed",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * Explicit INSERT listing every NOT NULL column except `tPublishdate`, which is
 * left to its DEFAULT CURRENT_TIMESTAMP so a new article is stamped by the DB.
 */
export async function createNews(
  id: number,
  d: {
    title: string;
    description: string;
    image: string;
    status: NewsStatus;
    type: NewsType;
    audience: NewsAudience;
  },
): Promise<void> {
  await execute(
    `INSERT INTO newsfeed
       (iNewsfeedId, vTitle, vNewfeedImage, tDescription, eStatus, eType, eUserType)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, d.title, d.image, d.description, d.status, d.type, d.audience],
  );
}

/** Content edit. `tPublishdate = tPublishdate` is what keeps the date from moving. */
export async function updateNews(
  id: number,
  d: { title: string; description: string; type: NewsType; audience: NewsAudience },
): Promise<void> {
  await execute(
    `UPDATE newsfeed
        SET vTitle = ?, tDescription = ?, eType = ?, eUserType = ?, tPublishdate = tPublishdate
      WHERE iNewsfeedId = ?`,
    [d.title, d.description, d.type, d.audience, id],
  );
}

/** Translation-editor save: both blobs at once, date preserved. */
export async function updateRawTexts(id: number, title: string, description: string): Promise<void> {
  await execute(
    `UPDATE newsfeed SET vTitle = ?, tDescription = ?, tPublishdate = tPublishdate
      WHERE iNewsfeedId = ?`,
    [title, description, id],
  );
}

export async function updateImage(id: number, filename: string): Promise<void> {
  await execute(
    "UPDATE newsfeed SET vNewfeedImage = ?, tPublishdate = tPublishdate WHERE iNewsfeedId = ?",
    [filename, id],
  );
}

export async function setNewsStatus(id: number, status: NewsStatus): Promise<void> {
  await execute(
    "UPDATE newsfeed SET eStatus = ?, tPublishdate = tPublishdate WHERE iNewsfeedId = ?",
    [status, id],
  );
}

/** Soft delete — the row stops showing in the apps but stays resolvable. */
export async function softDeleteNews(id: number): Promise<void> {
  await execute(
    "UPDATE newsfeed SET eStatus = 'Deleted', tPublishdate = tPublishdate WHERE iNewsfeedId = ?",
    [id],
  );
}
