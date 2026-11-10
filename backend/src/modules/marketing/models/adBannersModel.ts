import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `advertise_banners` table (Marketing Tools →
 * Advertisement Banners, #sub-109). InnoDB, but `iAdvertBannerId` carries no
 * auto-increment, so new ids come from MAX+1 like the other legacy catalogs.
 *
 * Column semantics, read off the DDL (the table is empty in this dataset, so
 * nothing here is inferred from live rows):
 *  - `ePosition` only allows 'MainScreen' — the placement is fixed, so it is
 *    stored and displayed but never edited.
 *  - `eImpression` (Unlimited/Limited) pairs with `iImpression`, the agreed
 *    cap. How many impressions were actually served lives in the read-only
 *    `banner_impression` log and is surfaced next to that cap.
 *  - `eValidityType` (Permanent/Custom) pairs with `dStartDate`/`dExpiryDate`,
 *    both `DATE NOT NULL` without a default. A Permanent banner therefore
 *    stores the far-future sentinel 9999-12-31 (so a legacy
 *    `dExpiryDate >= today` check stays true) and the UI renders "Permanent"
 *    instead of that date.
 *  - `eStatus` has no 'Deleted' member, so deletes are hard. Historic
 *    impression log rows are left in place (they cost nothing to keep), which
 *    is also why `nextBannerId()` reserves every id the log has ever seen —
 *    see that function.
 */

export type AdBannerStatus = "Active" | "Inactive";
export type ImpressionMode = "Unlimited" | "Limited";
export type ValidityMode = "Permanent" | "Custom";

/** Expiry stored for banners whose validity is Permanent. */
export const PERMANENT_EXPIRY = "9999-12-31";

export interface AdBannerRow {
  id: number; // iAdvertBannerId
  title: string; // vBannerTitle
  image: string; // vBannerImage (bare filename under <webImagesRoot>/AdvImages/)
  redirectUrl: string; // tRedirectUrl
  position: string; // ePosition ('MainScreen' for now)
  impressionMode: ImpressionMode; // eImpression
  impressionCap: number; // iImpression (0 when Unlimited)
  impressionsServed: number; // rows in banner_impression for this banner
  validityMode: ValidityMode; // eValidityType
  startDate: string; // dStartDate (YYYY-MM-DD, '' when zero-date)
  expiryDate: string; // dExpiryDate (YYYY-MM-DD, '' when zero-date / Permanent)
  displayOrder: number; // iDispOrder
  addedDate: string; // dAddedDate (YYYY-MM-DD, '' when zero-date)
  status: AdBannerStatus; // eStatus
}

/** Columns projected for a banner, with dates formatted in SQL. */
const SELECT_COLUMNS = `iAdvertBannerId, vBannerTitle, vBannerImage, tRedirectUrl, ePosition,
  eImpression, iImpression, eValidityType, iDispOrder, eStatus,
  DATE_FORMAT(dStartDate, '%Y-%m-%d') AS startDate,
  DATE_FORMAT(dExpiryDate, '%Y-%m-%d') AS expiryDate,
  DATE_FORMAT(dAddedDate, '%Y-%m-%d') AS addedDate,
  (SELECT COUNT(*) FROM banner_impression bi
     WHERE bi.iAdvertBannerId = advertise_banners.iAdvertBannerId) AS impressionsServed`;

/**
 * Legacy zero-dates survive DATE_FORMAT as the string "0000-00-00" (NULLIF in
 * SQL makes the mysql2 text parser throw), so they are blanked here and the UI
 * shows "—".
 */
function cleanDate(value: unknown): string {
  const v = value == null ? "" : String(value);
  return v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, string | number | null>): AdBannerRow {
  return {
    id: Number(r.iAdvertBannerId),
    title: String(r.vBannerTitle ?? "").trim(),
    image: String(r.vBannerImage ?? "").trim(),
    redirectUrl: String(r.tRedirectUrl ?? "").trim(),
    position: String(r.ePosition ?? ""),
    impressionMode: r.eImpression === "Unlimited" ? "Unlimited" : "Limited",
    impressionCap: Number(r.iImpression ?? 0),
    impressionsServed: Number(r.impressionsServed ?? 0),
    validityMode: r.eValidityType === "Permanent" ? "Permanent" : "Custom",
    startDate: cleanDate(r.startDate),
    // A Custom banner's expiry is always real; a Permanent one shows the
    // sentinel, which the service masks out before it reaches the API.
    expiryDate: cleanDate(r.expiryDate),
    displayOrder: Number(r.iDispOrder ?? 0),
    addedDate: cleanDate(r.addedDate),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
  };
}

/** Every banner, active or not, in display order (newest first within a slot). */
export async function listBanners(): Promise<AdBannerRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM advertise_banners
     ORDER BY iDispOrder, iAdvertBannerId DESC`,
  );
  return rows.map(mapRow);
}

/** One banner, or null when the id is unknown. */
export async function findBanner(id: number): Promise<AdBannerRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM advertise_banners WHERE iAdvertBannerId = ? LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Next free id. Because deletes are hard, `MAX(iAdvertBannerId)` over the banner
 * table alone would hand a deleted banner's id to a new one — and any rows the
 * legacy `banner_impression` log still holds for that id would be silently
 * re-attributed to the newcomer. So the allocation also skips ids that appear
 * in the impression log.
 */
export async function nextBannerId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    `SELECT COALESCE(MAX(iAdvertBannerId), 0) + 1 AS nid FROM (
       SELECT iAdvertBannerId FROM advertise_banners
       UNION ALL
       SELECT iAdvertBannerId FROM banner_impression
     ) AS taken`,
  );
  return Number(rows[0]?.nid ?? 1);
}

export interface BannerWrite {
  title: string;
  image: string;
  redirectUrl: string;
  impressionMode: ImpressionMode;
  impressionCap: number;
  validityMode: ValidityMode;
  startDate: string;
  expiryDate: string;
  displayOrder: number;
  status: AdBannerStatus;
}

/** Edit payload: the stored image and the status are changed through their own routes. */
export type BannerEdit = Omit<BannerWrite, "image" | "status">;

/**
 * Explicit INSERT listing every NOT NULL column (legacy-table requirement).
 * `ePosition` is left to its default — 'MainScreen' is the only enum member.
 */
export async function createBanner(id: number, d: BannerWrite): Promise<void> {
  await execute(
    `INSERT INTO advertise_banners
       (iAdvertBannerId, vBannerTitle, vBannerImage, tRedirectUrl, iImpression,
        dExpiryDate, iDispOrder, dAddedDate, dStartDate, eStatus, eImpression, eValidityType)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?)`,
    [
      id,
      d.title,
      d.image,
      d.redirectUrl,
      d.impressionCap,
      d.expiryDate,
      d.displayOrder,
      d.startDate,
      d.status,
      d.impressionMode,
      d.validityMode,
    ],
  );
}

/**
 * Edit path — the added date and the position are never touched, and
 * `eStatus` is left to the listing's PATCH /status route (same split as
 * donations, where the form never owns the status).
 */
export async function updateBanner(id: number, d: BannerEdit): Promise<void> {
  await execute(
    `UPDATE advertise_banners
        SET vBannerTitle = ?, tRedirectUrl = ?, iImpression = ?, dExpiryDate = ?,
            iDispOrder = ?, dStartDate = ?, eImpression = ?, eValidityType = ?
      WHERE iAdvertBannerId = ?`,
    [
      d.title,
      d.redirectUrl,
      d.impressionCap,
      d.expiryDate,
      d.displayOrder,
      d.startDate,
      d.impressionMode,
      d.validityMode,
      id,
    ],
  );
}

export async function updateImage(id: number, filename: string): Promise<void> {
  await execute("UPDATE advertise_banners SET vBannerImage = ? WHERE iAdvertBannerId = ?", [
    filename,
    id,
  ]);
}

export async function setBannerStatus(id: number, status: AdBannerStatus): Promise<void> {
  await execute("UPDATE advertise_banners SET eStatus = ? WHERE iAdvertBannerId = ?", [
    status,
    id,
  ]);
}

/** Hard delete — `eStatus` has no 'Deleted' member to soft-delete into. */
export async function deleteBanner(id: number): Promise<void> {
  await execute("DELETE FROM advertise_banners WHERE iAdvertBannerId = ?", [id]);
}
