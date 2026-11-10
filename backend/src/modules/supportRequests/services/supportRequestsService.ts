import { AppError } from "../../../errors/AppError";
import * as contactUs from "../models/contactUsModel";
import * as payment from "../models/paymentRequestModel";
import * as sos from "../models/sosModel";
import * as help from "../models/helpRequestModel";
import * as withdraw from "../models/withdrawModel";
import { clampFilters, isIsoDate, type ListFilters } from "../models/pageHelpers";

/**
 * Read-only business layer for the Support Requests reports (group 26).
 * The permission set for this module contains only `view-*-report` rows, so
 * nothing here ever writes — listings are filtered/paginated server-side and
 * carry full message text inline (no separate detail endpoints).
 */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** Shared input → filter normalization for all three reports. */
function filters(input: Partial<ListFilters>): ListFilters {
  if (!isIsoDate(input.from) || !isIsoDate(input.to)) {
    throw AppError.badRequest("Date filters must use the YYYY-MM-DD format.");
  }
  if (input.from && input.to && input.from > input.to) {
    throw AppError.badRequest("The from date must not be after the to date.");
  }
  return clampFilters({
    search: (input.search ?? "").trim(),
    from: input.from,
    to: input.to,
    page: input.page ?? 1,
    limit: input.limit ?? 25,
    userId: input.userId && input.userId > 0 ? input.userId : undefined,
    driverId: input.driverId && input.driverId > 0 ? input.driverId : undefined,
    tripNumber: (input.tripNumber ?? "").trim() || undefined,
    userType: (input.userType ?? "").trim() || undefined,
    status: (input.status ?? "").trim() || undefined,
  });
}

async function buildPage<T>(
  f: ListFilters,
  list: (f: ListFilters) => Promise<T[]>,
  count: (f: ListFilters) => Promise<number>,
): Promise<Page<T>> {
  // Page and total run concurrently; both share one filter snapshot.
  const [items, total] = await Promise.all([list(f), count(f)]);
  return { items, total, page: f.page, limit: f.limit, pages: Math.max(1, Math.ceil(total / f.limit)) };
}

export async function listContactUs(input: Partial<ListFilters>): Promise<Page<contactUs.ContactUsRow>> {
  const f = filters(input);
  return buildPage(f, contactUs.listContactUs, contactUs.countContactUs);
}

export async function listSos(input: Partial<ListFilters>): Promise<Page<sos.SosRow>> {
  const f = filters(input);
  return buildPage(f, sos.listSos, sos.countSos);
}

/** Users / service providers that appear in SOS records (for the filters). */
export function sosFilterOptions(): Promise<{
  users: sos.SosParticipant[];
  providers: sos.SosParticipant[];
}> {
  return sos.listSosParticipants();
}

export async function listPaymentRequests(
  input: Partial<ListFilters>,
): Promise<Page<payment.PaymentRequestRow>> {
  const f = filters(input);
  return buildPage(f, payment.listPaymentRequests, payment.countPaymentRequests);
}

/** Trips/Jobs Help (#sub-105): trip_help_detail rows with a trip reference. */
export async function listTripJobHelp(
  input: Partial<ListFilters>,
): Promise<Page<help.HelpRequestRow>> {
  const f = filters(input);
  return buildPage(
    f,
    (x) => help.listHelpRequests("trip", x),
    (x) => help.countHelpRequests("trip", x),
  );
}

/** Order Help (#sub-106): trip_help_detail rows with an order reference. */
export async function listOrderHelp(
  input: Partial<ListFilters>,
): Promise<Page<help.HelpRequestRow>> {
  const f = filters(input);
  return buildPage(
    f,
    (x) => help.listHelpRequests("order", x),
    (x) => help.countHelpRequests("order", x),
  );
}

/** Withdraw Requests (#sub-108): driver balance withdrawals. */
export async function listWithdrawRequests(
  input: Partial<ListFilters>,
): Promise<Page<withdraw.WithdrawRequestRow>> {
  const f = filters(input);
  return buildPage(f, withdraw.listWithdrawRequests, withdraw.countWithdrawRequests);
}
