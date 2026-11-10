import { AppError } from "../../../errors/AppError";
import * as blocked from "../models/blockedUsersModel";
import type { BlockedKind } from "../models/blockedUsersModel";
import * as outstanding from "../models/outstandingModel";
import type { OutstandingLeg } from "../models/outstandingModel";
import * as earning from "../models/earningModel";
import type { EarningLeg } from "../models/earningModel";
import * as payout from "../models/payoutModel";
import type { PayoutLeg } from "../models/payoutModel";
import * as cancelledTrips from "../models/cancelledTripsModel";
import type { CancelledTripRow } from "../models/cancelledTripsModel";
import * as cancelledOrders from "../models/cancelledOrdersModel";
import type { CancelledOrderRow } from "../models/cancelledOrdersModel";
import * as insurance from "../models/insuranceModel";
import type { InsuranceLeg } from "../models/insuranceModel";
import * as providerLog from "../models/providerLogModel";
import * as userWallet from "../models/userWalletModel";
import * as referral from "../models/referralModel";
import * as paymentMember from "../models/paymentMemberModel";
import * as reward from "../models/rewardModel";
import * as requestAcceptance from "../models/requestAcceptanceModel";
import * as timeVariance from "../models/timeVarianceModel";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` string that also names a real calendar day (rejects impossible
 * values like `2024-13-99` that match the shape but would error inside MySQL).
 */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

export interface BlockedListInput {
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface BlockedListPage {
  requests: blocked.BlockedUserRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

function normalise(input: BlockedListInput): blocked.BlockedFilters {
  const from = (input.from ?? "").trim();
  const to = (input.to ?? "").trim();
  if (from && !isRealDate(from)) throw new AppError(400, "BAD_DATE", "'from' must be a valid YYYY-MM-DD date");
  if (to && !isRealDate(to)) throw new AppError(400, "BAD_DATE", "'to' must be a valid YYYY-MM-DD date");
  if (from && to && from > to) {
    throw new AppError(400, "BAD_DATE_RANGE", "'from' must not be after 'to'");
  }
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  return {
    search: (input.search ?? "").trim(),
    from: from || undefined,
    to: to || undefined,
    page,
    limit,
  };
}

export async function listBlockedUsers(
  kind: BlockedKind,
  input: BlockedListInput,
): Promise<BlockedListPage> {
  const f = normalise(input);
  const [requests, total] = await Promise.all([
    blocked.listBlocked(kind, f),
    blocked.countBlocked(kind, f),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All blocked accounts matching the filters, for CSV export (#sub-101). */
export async function exportBlockedUsers(
  kind: BlockedKind,
  input: BlockedListInput,
): Promise<blocked.BlockedUserRow[]> {
  return blocked.exportBlocked(kind, normalise(input));
}

export async function unblockUser(
  kind: BlockedKind,
  id: number,
): Promise<{ id: number; kind: BlockedKind }> {
  const account = await blocked.getAccountById(kind, id);
  if (!account) throw new AppError(404, "NOT_FOUND", "Account not found");
  if (!(await blocked.isBlocked(kind, id))) {
    throw new AppError(409, "NOT_BLOCKED", "This account is not currently blocked");
  }
  await blocked.unblockById(kind, id);
  return { id, kind };
}

/** One page of the Outstanding Report (#sub-99) for the given leg. */
export async function listOutstandingReport(
  leg: OutstandingLeg,
  input: BlockedListInput,
): Promise<{ requests: outstanding.OutstandingRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normalise(input);
  const [requests, total] = await Promise.all([
    outstanding.listOutstanding(leg, f),
    outstanding.countOutstanding(leg, f),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All outstanding rows matching the filters, for CSV export (#sub-99). */
export async function exportOutstandingReport(
  leg: OutstandingLeg,
  input: BlockedListInput,
): Promise<outstanding.OutstandingRow[]> {
  return outstanding.exportOutstanding(leg, normalise(input));
}

// ---------------------------------------------------------------------------
// Earning Report (#sub-95): trips/jobs and store-delivery (orders) legs, plus
// CSV export. Adds an optional per-leg `status` filter on top of the shared
// search + date-range + paging normalisation.
// ---------------------------------------------------------------------------

export interface EarningListInput extends BlockedListInput {
  status?: string;
}

function normaliseEarning(input: EarningListInput): earning.EarningFilters {
  const base = normalise(input);
  return { ...base, status: (input.status ?? "").trim() || undefined };
}

export interface EarningPage {
  requests: earning.EarningRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** One page of the Earning Report (#sub-95) for the given leg. */
export async function listEarningReport(leg: EarningLeg, input: EarningListInput): Promise<EarningPage> {
  const f = normaliseEarning(input);
  const [requests, total] = await Promise.all([
    earning.listEarnings(leg, f),
    earning.countEarnings(leg, f),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All rows matching the filters, for CSV export. */
export async function exportEarningReport(
  leg: EarningLeg,
  input: EarningListInput,
): Promise<earning.EarningRow[]> {
  return earning.exportEarnings(leg, normaliseEarning(input));
}

// ---------------------------------------------------------------------------
// Payout Report (#sub-96): payment listings per leg (drivers first), each with
// the same optional `status` filter + CSV export as the Earning legs.
// ---------------------------------------------------------------------------

/** One page of the Payout Report (#sub-96) for the given leg. */
export async function listPayoutReport(
  leg: PayoutLeg,
  input: EarningListInput,
): Promise<{ requests: payout.PayoutRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const [requests, total] = await Promise.all([
    payout.listPayouts(leg, f),
    payout.countPayouts(leg, f),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All payout rows matching the filters, for CSV export. */
export async function exportPayoutReport(
  leg: PayoutLeg,
  input: EarningListInput,
): Promise<payout.PayoutRow[]> {
  return payout.exportPayouts(leg, normaliseEarning(input));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Cancelled Trip Job Report.
// ---------------------------------------------------------------------------

/** One page of the Cancelled Trip Job Report (#sub-100). */
export async function listCancelledTripReport(
  input: EarningListInput,
): Promise<{ requests: CancelledTripRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: cancelledTrips.CancelledTripFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    cancelledTrips.listCancelledTrips(filters),
    cancelledTrips.countCancelledTrips(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All cancelled-trip rows matching the filters, for CSV export. */
export async function exportCancelledTripReport(
  input: EarningListInput,
): Promise<CancelledTripRow[]> {
  const f = normaliseEarning(input);
  return cancelledTrips.exportCancelledTrips({
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  });
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Cancelled Order Report.
// ---------------------------------------------------------------------------

/** One page of the Cancelled Order Report (#sub-100). */
export async function listCancelledOrderReport(
  input: EarningListInput,
): Promise<{ requests: CancelledOrderRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: cancelledOrders.CancelledOrderFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    cancelledOrders.listCancelledOrders(filters),
    cancelledOrders.countCancelledOrders(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All cancelled-order rows matching the filters, for CSV export. */
export async function exportCancelledOrderReport(
  input: EarningListInput,
): Promise<CancelledOrderRow[]> {
  const f = normaliseEarning(input);
  return cancelledOrders.exportCancelledOrders({
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  });
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Driver Insurance Reports (idle / accept / trip
// legs over the shared `driver_insurance_report` ledger, differing only by the
// eAddedFor classification). Each leg has list + CSV export.
// ---------------------------------------------------------------------------

/** One page of a Driver Insurance Report leg (#sub-100). */
export async function listInsuranceReport(
  leg: InsuranceLeg,
  input: BlockedListInput,
): Promise<{ requests: insurance.InsuranceRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normalise(input);
  const filters: insurance.InsuranceFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
  };
  const [requests, total] = await Promise.all([
    insurance.listInsuranceSegments(leg, filters),
    insurance.countInsuranceSegments(leg, filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

/** All insurance-segment rows matching the filters, for CSV export. */
export async function exportInsuranceReport(
  leg: InsuranceLeg,
  input: BlockedListInput,
): Promise<insurance.InsuranceRow[]> {
  const f = normalise(input);
  return insurance.exportInsuranceSegments(leg, {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
  });
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Provider (Driver) Log Report. List only: the
// legacy panel defines no export permission for it.
// ---------------------------------------------------------------------------

/** One page of the Provider Log Report (#sub-100). */
export async function listProviderLogReport(
  input: BlockedListInput,
): Promise<{ requests: providerLog.ProviderLogRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normalise(input);
  const filters: providerLog.ProviderLogFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
  };
  const [requests, total] = await Promise.all([
    providerLog.listProviderLogSessions(filters),
    providerLog.countProviderLogSessions(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Wallet / Refund / Withdraw / Referrer Report.
// List only: the legacy panel defines no export permission for it. Adds an
// optional `status` filter over the eFor classification on top of the shared
// search + date-range + paging normalisation.
// ---------------------------------------------------------------------------

/** One page of the User Wallet Report (#sub-100). */
export async function listUserWalletReport(
  input: EarningListInput,
): Promise<{ requests: userWallet.UserWalletRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: userWallet.UserWalletFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    userWallet.listUserWalletEntries(filters),
    userWallet.countUserWalletEntries(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Referral Report. List only. The source
// table (user_referrer_transaction) has no date column, so from/to are not
// applied; `status` filters eUserType (Rider | Driver).
// ---------------------------------------------------------------------------

/** One page of the Referral Report (#sub-100). */
export async function listReferralReport(
  input: EarningListInput,
): Promise<{ requests: referral.ReferralRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: referral.ReferralFilters = {
    search: f.search,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    referral.listReferrals(filters),
    referral.countReferrals(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Payment Member Report. List only. The payments
// ledger has no date column (from/to not applied); `status` filters eEvent.
// tPaymentDetails (Stripe key material) is never selected.
// ---------------------------------------------------------------------------

/** One page of the Payment Member Report (#sub-100). */
export async function listPaymentMemberReport(
  input: EarningListInput,
): Promise<{ requests: paymentMember.PaymentMemberRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: paymentMember.PaymentMemberFilters = {
    search: f.search,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    paymentMember.listPaymentMemberRows(filters),
    paymentMember.countPaymentMemberRows(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Reward Report. List only. Campaign-centric
// (driver_reward grants are empty in this dataset): one row per
// reward_campaign with rolled-up grant count/credit; `status` filters eStatus
// and from/to filter the campaign start date.
// ---------------------------------------------------------------------------

/** One page of the User Reward Report (#sub-100). */
export async function listUserRewardReport(
  input: EarningListInput,
): Promise<{ requests: reward.UserRewardRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normaliseEarning(input);
  const filters: reward.UserRewardFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
    status: f.status,
  };
  const [requests, total] = await Promise.all([
    reward.listRewardCampaigns(filters),
    reward.countRewardCampaigns(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Trips/Jobs Request Acceptance Report. List only.
// Documented proxy on trips (no acceptance event is stored): the dispatch →
// driver-arrival interval. Search covers ride no / driver / customer, the date
// range filters the request stamp.
// ---------------------------------------------------------------------------

/** One page of the Request Acceptance Report (#sub-100). */
export async function listRequestAcceptanceReport(
  input: BlockedListInput,
): Promise<{ requests: requestAcceptance.RequestAcceptanceRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normalise(input);
  const filters: requestAcceptance.RequestAcceptanceFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
  };
  const [requests, total] = await Promise.all([
    requestAcceptance.listRequestAcceptances(filters),
    requestAcceptance.countRequestAcceptances(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Trips/Jobs Time Variance Report. List only.
// Documented proxy: estimated routing time (trips.fGDtime, text seconds) vs
// the actual tStartDate → tEndDate duration of completed trips.
// ---------------------------------------------------------------------------

/** One page of the Time Variance Report (#sub-100). */
export async function listTimeVarianceReport(
  input: BlockedListInput,
): Promise<{ requests: timeVariance.TimeVarianceRow[]; total: number; page: number; limit: number; pages: number }> {
  const f = normalise(input);
  const filters: timeVariance.TimeVarianceFilters = {
    search: f.search,
    from: f.from,
    to: f.to,
    page: f.page,
    limit: f.limit,
  };
  const [requests, total] = await Promise.all([
    timeVariance.listTimeVariances(filters),
    timeVariance.countTimeVariances(filters),
  ]);
  const pages = Math.max(1, Math.ceil(total / f.limit));
  return { requests, total, page: f.page, limit: f.limit, pages };
}
