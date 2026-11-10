import * as model from "../models/newsletterModel";
import type { NewsletterRow, NewsletterStatus } from "../models/newsletterModel";

/**
 * Read-side rules for Newsletter Subscribers (#sub-113).
 *
 * This sub-group grants two capabilities and nothing else: `manage-newsletter`
 * (the list) and `export-newsletter` (the download). There is no create / edit /
 * delete / status permission, so the service exposes no write path — the panel
 * shows what the apps recorded and hands it out as CSV. Keeping the filtering
 * here rather than in the controller is what makes the screen and the exported
 * file agree, exactly as in the promo-code module.
 */

export interface NewsletterSubscriberDto {
  id: number;
  name: string;
  /** What the listing shows when the legacy form stored no name for the address. */
  label: string;
  email: string;
  status: NewsletterStatus;
  ip: string;
  subscribedDate: string;
}

function toDto(r: NewsletterRow): NewsletterSubscriberDto {
  return { ...r, label: r.name || r.email };
}

export interface SubscriberFilters {
  status?: string;
  search?: string;
}

/** Every row, newest first. */
export async function listSubscribers(): Promise<NewsletterSubscriberDto[]> {
  return (await model.listSubscribers()).map(toDto);
}

/**
 * Counts over the WHOLE list, so the footer can tell an admin how many addresses
 * exist while the table shows only the filtered ones.
 */
export interface SubscriberSummary {
  total: number;
  subscribed: number;
  unsubscribed: number;
}

export function summarize(dtos: NewsletterSubscriberDto[]): SubscriberSummary {
  return {
    total: dtos.length,
    subscribed: dtos.filter((d) => d.status === "Subscribe").length,
    unsubscribed: dtos.filter((d) => d.status === "Unsubscribe").length,
  };
}

/** Name, address and the recorded address of the machine that subscribed. */
export function filterSubscribers(
  dtos: NewsletterSubscriberDto[],
  filters: SubscriberFilters,
): NewsletterSubscriberDto[] {
  const status = String(filters.status ?? "all").trim();
  const term = String(filters.search ?? "").trim().toLowerCase();
  return dtos.filter((d) => {
    if (status !== "all" && d.status !== status) return false;
    if (!term) return true;
    return (
      d.name.toLowerCase().includes(term) ||
      d.email.toLowerCase().includes(term) ||
      d.ip.toLowerCase().includes(term)
    );
  });
}

/** The same rows the listing shows, for the CSV path. */
export async function exportSubscribers(
  filters: SubscriberFilters,
): Promise<NewsletterSubscriberDto[]> {
  return filterSubscribers(await listSubscribers(), filters);
}
