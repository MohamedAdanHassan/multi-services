import { execute, query } from "../../../db/mysql";

/**
 * Data access for the legacy `seo_sections` table (InnoDB; `iId` is the
 * logical key, no create/delete — the nine installed sections are fixed).
 * Each row holds the default SEO metadata rendered on one public page, so
 * every column is admin-owned content and fully editable.
 */

export interface SeoSectionRow {
  id: number; // iId
  pageName: string; // vPagename (human label for the section)
  pageTitle: string; // vPagetitle (SEO <title>)
  metaKeywords: string; // vMetakeyword (SEO meta keywords)
  description: string; // tDescription (SEO meta description)
}

/** Editable payload — mirrors the row minus the id. */
export type SeoSectionInput = Omit<SeoSectionRow, "id">;

const SELECT_COLUMNS = `iId, vPagename, vPagetitle, vMetakeyword, tDescription`;

function mapRow(r: Record<string, string | number | null>): SeoSectionRow {
  return {
    id: Number(r.iId),
    pageName: String(r.vPagename ?? ""),
    pageTitle: String(r.vPagetitle ?? ""),
    metaKeywords: String(r.vMetakeyword ?? ""),
    description: String(r.tDescription ?? ""),
  };
}

/** All SEO sections, ordered by id (stable insertion order). */
export async function listSeoSections(): Promise<SeoSectionRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM seo_sections ORDER BY iId`,
  );
  return rows.map(mapRow);
}

/** Look up a single section by id (or null if absent). */
export async function findSeoSection(id: number): Promise<SeoSectionRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM seo_sections WHERE iId = ? LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Persist the editable fields of one section. */
export async function updateSeoSection(id: number, input: SeoSectionInput): Promise<number> {
  const res = await execute(
    `UPDATE seo_sections SET vPagename = ?, vPagetitle = ?, vMetakeyword = ?, tDescription = ? WHERE iId = ?`,
    [input.pageName, input.pageTitle, input.metaKeywords, input.description, id],
  );
  return res.affectedRows;
}
