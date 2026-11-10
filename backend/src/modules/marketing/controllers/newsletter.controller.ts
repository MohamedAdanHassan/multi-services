import type { Request, Response } from "express";
import * as service from "../services/newsletterService";
import type { SubscriberFilters } from "../services/newsletterService";

/**
 * HTTP layer for Marketing Tools → Newsletter Subscribers (#sub-113).
 *
 * The sub-group grants two capabilities and nothing else — `manage-newsletter`
 * (459) and `export-newsletter` (805) — so this file has exactly two handlers:
 * a filtered read and a CSV of the same rows. There are no create / edit /
 * delete / status routes to write, because inventing them would hand out powers
 * the RBAC data says no admin holds. Nothing is audited either: the audit trail
 * records mutations, and this screen mutates nothing.
 */

/** Listing filters, already cleaned by the query schema on the route. */
function readFilters(query: Record<string, unknown>): SubscriberFilters {
  return {
    status: String(query.status ?? "all"),
    search: String(query.search ?? ""),
  };
}

/**
 * GET /api/newsletter/list — every subscriber row, newest first.
 *
 * `total` counts the rows the filters left (the table's own footer number, and
 * the promo-code listing's convention), while `overall`, `subscribed` and
 * `unsubscribed` describe the whole table: an admin looking at the
 * "Unsubscribe" slice still needs to see how large the list is.
 */
export async function list(req: Request, res: Response) {
  const all = await service.listSubscribers();
  const summary = service.summarize(all);
  const subscribers = service.filterSubscribers(all, readFilters(req.query as Record<string, unknown>));
  res.json({
    subscribers,
    total: subscribers.length,
    overall: summary.total,
    subscribed: summary.subscribed,
    unsubscribed: summary.unsubscribed,
  });
}

// ---------------------------------------------------------------------------
// CSV export — same RFC 4180 shape as the promo-code and report exports (BOM
// for Excel), and the same filters, so the file matches what is on screen.
// ---------------------------------------------------------------------------

/** Escape a single CSV field per RFC 4180. */
function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header wording matches the screen's column, which calls the same value
 *  "Recorded date" because the legacy column moves on any row change. */
const CSV_HEADER = ["ID", "Name", "Email", "Status", "Recorded Date", "IP"];

function csvCell(d: service.NewsletterSubscriberDto): (string | number)[] {
  return [d.id, d.name, d.email, d.status, d.subscribedDate, d.ip];
}

/** GET /api/newsletter/export — CSV of the subscriber rows matching the filters. */
export async function exportCsv(req: Request, res: Response) {
  const rows = await service.exportSubscribers(readFilters(req.query as Record<string, unknown>));
  const lines = [CSV_HEADER.map(csvField).join(","), ...rows.map((r) => csvCell(r).map(csvField).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="newsletter-subscribers.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}
