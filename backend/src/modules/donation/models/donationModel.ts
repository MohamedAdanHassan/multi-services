import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `donation` table (InnoDB, Utility → Donation,
 * #sub-160). `iDonationId` has no auto-increment, so new ids come from
 * MAX+1 over all rows; deletes are soft (`eStatus='Deleted'`) mirroring the
 * legacy enum so nothing ever breaks historic references.
 *
 * `tTitle` / `tDescription` are NOT plain strings — the legacy app stores a
 * JSON map of per-language texts (`{"tTitle_EN":"…","tTitle_AR":"…"}`), which
 * this layer passes through verbatim (parsing/merging happens in the service).
 * Per the additive-only strategy, INSERTs list every NOT NULL column
 * explicitly and `tCreatedDate` is left to its DB default.
 */

export type DonationStatus = "Active" | "Inactive";

export interface DonationRow {
  id: number; // iDonationId
  rawTitle: string; // tTitle (multilingual JSON)
  rawDescription: string; // tDescription (multilingual JSON)
  link: string; // tLink
  image: string; // vDonationImage (bare filename under <root>/donation/)
  displayOrder: number; // iDisplayOrder
  status: DonationStatus; // eStatus (never 'Deleted' — hidden)
  createdAt: string | null; // tCreatedDate, formatted
}

const SELECT_COLUMNS = `iDonationId, tTitle, tDescription, tLink, vDonationImage,
  iDisplayOrder, eStatus,
  DATE_FORMAT(tCreatedDate, '%Y-%m-%d %H:%i') AS createdAt`;

function mapRow(r: Record<string, string | number | null>): DonationRow {
  return {
    id: Number(r.iDonationId),
    rawTitle: String(r.tTitle ?? ""),
    rawDescription: String(r.tDescription ?? ""),
    link: String(r.tLink ?? ""),
    image: String(r.vDonationImage ?? ""),
    displayOrder: Number(r.iDisplayOrder ?? 0),
    status: r.eStatus === "Inactive" ? "Inactive" : "Active",
    // Zero-dates survive DATE_FORMAT as "0000-00-00 00:00" → shown as null
    // (NULLIF in SQL would make the mysql2 text parser throw instead).
    createdAt: (() => {
      const v = r.createdAt == null ? "" : String(r.createdAt);
      return !v || v.startsWith("0000") ? null : v;
    })(),
  };
}

/** All live donations in display order. */
export async function listDonations(): Promise<DonationRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM donation
     WHERE eStatus <> 'Deleted'
     ORDER BY iDisplayOrder, iDonationId`,
  );
  return rows.map(mapRow);
}

/** One live donation, or null if missing / soft-deleted. */
export async function findDonation(id: number): Promise<DonationRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM donation WHERE iDonationId = ? AND eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id: max over all rows so soft-deleted ids are never reused. */
export async function nextDonationId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iDonationId), 0) + 1 AS nid FROM donation",
  );
  return Number(rows[0]?.nid ?? 1);
}

/** Explicit INSERT covering every NOT NULL column (legacy-table requirement). */
export async function createDonation(
  id: number,
  d: { title: string; description: string; link: string; image: string; displayOrder: number; status: DonationStatus },
): Promise<void> {
  await execute(
    `INSERT INTO donation
       (iDonationId, tTitle, tDescription, tLink, vDonationImage, iDisplayOrder, eStatus)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, d.title, d.description, d.link, d.image, d.displayOrder, d.status],
  );
}

export async function updateDonation(
  id: number,
  d: { title: string; description: string; link: string; displayOrder: number },
): Promise<void> {
  await execute(
    "UPDATE donation SET tTitle = ?, tDescription = ?, tLink = ?, iDisplayOrder = ? WHERE iDonationId = ?",
    [d.title, d.description, d.link, d.displayOrder, id],
  );
}

/** Persist both multilingual JSON blobs (translation editor save). */
export async function updateRawTexts(id: number, title: string, description: string): Promise<void> {
  await execute(
    "UPDATE donation SET tTitle = ?, tDescription = ? WHERE iDonationId = ?",
    [title, description, id],
  );
}

export async function updateImage(id: number, filename: string): Promise<void> {
  await execute("UPDATE donation SET vDonationImage = ? WHERE iDonationId = ?", [filename, id]);
}

export async function setDonationStatus(id: number, status: DonationStatus): Promise<void> {
  await execute("UPDATE donation SET eStatus = ? WHERE iDonationId = ?", [status, id]);
}

/** Soft delete — hides the donation without erasing the row. */
export async function softDeleteDonation(id: number): Promise<void> {
  await execute("UPDATE donation SET eStatus = 'Deleted' WHERE iDonationId = ?", [id]);
}
