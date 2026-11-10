import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `gift_card_images` table — the artwork a gift card
 * can be printed with (Marketing Tools → Manage Gift Cards, #sub-111).
 *
 * What the live data says about this table (364 rows):
 *  - It is a **design × language matrix**: one row per (artwork, `vCode`). The
 *    dataset holds 26 language codes × 14 display orders, and only 15 distinct
 *    filenames — every language's row for a given design points at the SAME
 *    file, because the artwork carries no text. `vCode` therefore selects which
 *    slice of the matrix the panel is looking at, not a translation.
 *  - `iGiftCardImageId int NOT NULL` with no AUTO_INCREMENT and no index, so ids
 *    come from MAX+1 over every row and writes filter by id with `LIMIT 1`.
 *  - ids are NOT dense (min 1, max 1162, 364 rows): the legacy panel hard-deleted
 *    some rows, so MAX+1 must look at every row including 'Deleted' ones.
 *  - `eStatus` has a 'Deleted' member and `delete-giftcard-image` is Active, so
 *    deletes here are soft — which matters for the FILES: because one filename
 *    is shared by up to 26 rows, a row can only be unlinked from its file when
 *    no other row still names it (see `countFileReferences`).
 *  - `iLocationid` is 0 for every row but one (-1): a legacy zone filter this
 *    dataset never uses, so the panel does not expose it and creates write 0.
 *  - The EN row with id 1 has an EMPTY `vImage` — the "no artwork" slot the
 *    legacy import left behind. It is listed and shown as having no file.
 */

export type ImageStatus = "Active" | "Inactive";
export type ImageStatusCode = ImageStatus | "Deleted";

export interface GiftCardImageRow {
  id: number; // iGiftCardImageId
  image: string; // vImage (bare filename under <webImagesRoot>/GiftCard/)
  status: ImageStatusCode; // eStatus
  displayOrder: number; // iDisplayOrder (the design slot within a language)
  addedDate: string; // dAddedDate (YYYY-MM-DD HH:mm)
  code: string; // vCode (language this row belongs to)
  locationId: number; // iLocationid (legacy zone filter, unused here)
}

const SELECT_COLUMNS = `iGiftCardImageId, vImage, eStatus, iDisplayOrder, vCode, iLocationid,
  DATE_FORMAT(dAddedDate, '%Y-%m-%d %H:%i') AS addedDate`;

function mapRow(r: Record<string, string | number | null>): GiftCardImageRow {
  return {
    id: Number(r.iGiftCardImageId),
    image: String(r.vImage ?? "").trim(),
    status: (String(r.eStatus ?? "Active") as ImageStatusCode),
    displayOrder: Number(r.iDisplayOrder ?? 0),
    addedDate: String(r.addedDate ?? "").startsWith("0000")
      ? ""
      : String(r.addedDate ?? ""),
    code: String(r.vCode ?? "").trim(),
    locationId: Number(r.iLocationid ?? 0),
  };
}

/** Every live row of one language's design set, in display order. */
export async function listImages(code: string): Promise<GiftCardImageRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_card_images
      WHERE vCode = ? AND eStatus <> 'Deleted'
      ORDER BY iDisplayOrder, iGiftCardImageId`,
    [code],
  );
  return rows.map(mapRow);
}

/** One usable row, or null when the id is unknown or retired. */
export async function findImage(id: number): Promise<GiftCardImageRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_card_images
      WHERE iGiftCardImageId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * The design set the card form offers: the default language's rows (the artwork
 * is language-independent in this data, so one slice is the honest 14-option
 * list) plus whatever row a card being edited already points at, so an older row
 * from another language stays selectable instead of silently resetting.
 */
export async function listDesignOptions(
  currentImageId: number,
): Promise<GiftCardImageRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_card_images
      WHERE eStatus <> 'Deleted'
        AND (vCode = (SELECT vCode FROM language_master
                      WHERE eDefault = 'Yes' AND eStatus = 'Active'
                     LIMIT 1)
             OR iGiftCardImageId = ?)
      ORDER BY iDisplayOrder, iGiftCardImageId`,
    [currentImageId],
  );
  return rows.map(mapRow);
}

/** Next free id, over every row including retired ones (some ids were hard-deleted). */
export async function nextImageId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iGiftCardImageId), 0) + 1 AS nid FROM gift_card_images",
  );
  return Number(rows[0]?.nid ?? 1);
}

export interface GiftCardImageWrite {
  code: string;
  displayOrder: number;
  image: string; // '' until a file has been uploaded
}

/** Every column is NOT NULL with no default, so all seven are listed. */
export async function createImage(
  id: number,
  d: GiftCardImageWrite,
  status: ImageStatus,
): Promise<void> {
  await execute(
    `INSERT INTO gift_card_images
       (iGiftCardImageId, vImage, eStatus, iDisplayOrder, dAddedDate, vCode, iLocationid)
     VALUES (?, ?, ?, ?, NOW(), ?, 0)`,
    [id, d.image, status, d.displayOrder, d.code],
  );
}

/** Edit path — the status belongs to PATCH /status. */
export async function updateImage(id: number, d: GiftCardImageWrite): Promise<void> {
  await execute(
    `UPDATE gift_card_images
        SET vImage = ?, iDisplayOrder = ?, vCode = ?
      WHERE iGiftCardImageId = ?
      LIMIT 1`,
    [d.image, d.displayOrder, d.code, id],
  );
}

export async function setImageFile(id: number, filename: string): Promise<void> {
  await execute(
    "UPDATE gift_card_images SET vImage = ? WHERE iGiftCardImageId = ? LIMIT 1",
    [filename, id],
  );
}

export async function setImageStatus(id: number, status: ImageStatus): Promise<void> {
  await execute(
    "UPDATE gift_card_images SET eStatus = ? WHERE iGiftCardImageId = ? LIMIT 1",
    [status, id],
  );
}

/** Soft delete — the row stays, so its id is never handed out again. */
export async function deleteImage(id: number): Promise<void> {
  await execute(
    "UPDATE gift_card_images SET eStatus = 'Deleted' WHERE iGiftCardImageId = ? LIMIT 1",
    [id],
  );
}

/**
 * How many rows still name this file, excluding one row. The same artwork is
 * shared across every language, so a file may only be removed from disk when
 * this returns 0 — including retired rows, which the apps could still reference
 * by id.
 */
export async function countFileReferences(
  filename: string,
  exceptId: number,
): Promise<number> {
  const rows = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM gift_card_images
      WHERE vImage = ? AND iGiftCardImageId <> ?`,
    [filename, exceptId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Live (non-retired) cards per design, in one grouped query: the listing shows
 * how many cards a design is printed on, and retiring one should say so.
 */
export async function cardUsageCounts(): Promise<Record<number, number>> {
  const rows = await query<{ iGiftCardImageId: number | null; n: number | null }>(
    `SELECT iGiftCardImageId, COUNT(*) AS n FROM gift_cards
      WHERE eStatus <> 'Deleted' AND iGiftCardImageId > 0
      GROUP BY iGiftCardImageId`,
  );
  const out: Record<number, number> = {};
  for (const r of rows) out[Number(r.iGiftCardImageId)] = Number(r.n ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// Language axis (language_master) — the picker that chooses the matrix slice.
// ---------------------------------------------------------------------------

export interface LanguageOption {
  code: string; // vCode
  title: string; // native title
  titleEn: string; // English title
  active: boolean; // eStatus
  isDefault: boolean; // eDefault
}

/** Every language the artwork matrix is keyed by, default first. */
export async function listLanguages(): Promise<LanguageOption[]> {
  const rows = await query<{
    vCode: string | null;
    vTitle: string | null;
    vTitle_EN: string | null;
    eStatus: string | null;
    eDefault: string | null;
  }>(
    `SELECT vCode, vTitle, vTitle_EN, eStatus, eDefault
       FROM language_master
      ORDER BY eDefault = 'Yes' DESC, vTitle_EN`,
  );
  return rows
    .filter((r) => String(r.vCode ?? "").trim() !== "")
    .map((r) => ({
      code: String(r.vCode ?? "").trim(),
      title: String(r.vTitle ?? "").trim(),
      titleEn: String(r.vTitle_EN ?? "").trim(),
      active: String(r.eStatus ?? "") === "Active",
      isDefault: String(r.eDefault ?? "") === "Yes",
    }));
}

/**
 * Every language code the artwork matrix itself is keyed by. This can be wider
 * than `language_master`: in this dataset the 14 SL designs have no master row,
 * so the master alone would hide a slice of the table that then cannot be listed
 * or re-tagged from the panel.
 */
export async function listMatrixCodes(): Promise<string[]> {
  const rows = await query<{ vCode: string | null }>(
    `SELECT DISTINCT vCode FROM gift_card_images
      WHERE TRIM(COALESCE(vCode, '')) <> '' ORDER BY vCode`,
  );
  return rows.map((r) => String(r.vCode ?? "").trim()).filter((c) => c !== "");
}

/** The language `listDesignOptions` filters by — EN in this dataset. */
export async function defaultLanguageCode(): Promise<string> {
  const rows = await query<{ c: string | null }>(
    `SELECT vCode AS c FROM language_master
      WHERE eDefault = 'Yes' AND eStatus = 'Active' LIMIT 1`,
  );
  return String(rows[0]?.c ?? "EN").trim() || "EN";
}
