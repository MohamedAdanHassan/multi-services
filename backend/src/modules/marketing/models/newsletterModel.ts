import { query } from "../../../db/mysql";

/**
 * Data access for the legacy `newsletter` table — the addresses that asked to
 * hear from the installation (Marketing Tools → Newsletter Subscribers, #sub-113).
 *
 * What the live schema and data say about this table:
 *  - There is **no primary key and no index at all**. `iNewsLetterId` is a plain
 *    `int NOT NULL` without AUTO_INCREMENT, so ids come from the legacy panel and
 *    nothing can be looked up cheaply. One unfiltered read of the whole table is
 *    therefore the honest access pattern here, exactly as in the other marketing
 *    listings.
 *  - `tDate` is `timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE
 *    CURRENT_TIMESTAMP`: any UPDATE that does not restate the column moves the
 *    recorded subscription date to "now". Combined with the two permissions this
 *    sub-group actually grants — `manage-newsletter` and `export-newsletter`, no
 *    create/edit/delete/status row — the screen reads and downloads and writes
 *    nothing.
 *  - `eStatus` is enum('Subscribe','Unsubscribe') with 'Subscribe' as the default.
 *    The apps flip a row to 'Unsubscribe' when someone leaves, so both values are
 *    real data rather than something this panel maintains. There is no 'Deleted'
 *    member, which is why a delete here would be a hard, irreversible one over
 *    personal data.
 *  - `vEmail` / `vName` / `vIP` are NOT NULL with no default and **no unique key**,
 *    so the same address can legitimately appear twice (re-subscribing after an
 *    unsubscribe keeps history) and an email must never be treated as an identifier.
 *  - Ids are not dense: this dataset starts at 2, so nothing may assume a range.
 *  - No foreign key anywhere points at `newsletter`.
 */

export type NewsletterStatus = "Subscribe" | "Unsubscribe";

export interface NewsletterRow {
  id: number; // iNewsLetterId
  status: NewsletterStatus; // eStatus
  name: string; // vName
  email: string; // vEmail
  ip: string; // vIP
  subscribedDate: string; // tDate (YYYY-MM-DD HH:mm), '' for a legacy zero date
}

/**
 * `tDate` only ever answers "when did this row last change", because the column
 * rewrites itself on update. The listing labels it as the date the panel shows
 * and never as proof of when someone first subscribed.
 */
const SELECT_COLUMNS = `iNewsLetterId, eStatus, vName, vEmail, vIP,
  DATE_FORMAT(tDate, '%Y-%m-%d %H:%i') AS subscribedDate`;

function mapRow(r: Record<string, string | number | null>): NewsletterRow {
  const date = String(r.subscribedDate ?? "");
  return {
    id: Number(r.iNewsLetterId),
    status: (r.eStatus === "Unsubscribe" ? "Unsubscribe" : "Subscribe") as NewsletterStatus,
    name: String(r.vName ?? "").trim(),
    email: String(r.vEmail ?? "").trim(),
    ip: String(r.vIP ?? "").trim(),
    // A zero date would arrive as "0000-00-00 00:00"; the mysql2 driver also
    // refuses to hand back a raw zero timestamp, so only the formatted value is
    // ever inspected.
    subscribedDate: date.startsWith("0000") ? "" : date,
  };
}

/** Every subscriber row, newest first. Retired or hard-deleted rows are simply gone. */
export async function listSubscribers(): Promise<NewsletterRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM newsletter
      ORDER BY tDate DESC, iNewsLetterId DESC`,
  );
  return rows.map(mapRow);
}
