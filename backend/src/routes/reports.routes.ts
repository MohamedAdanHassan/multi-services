import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/reports/controllers/reports.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

// Shared listing query for the Reports module (search + date range + paging).
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  from: z.string().trim().max(10).optional(),
  to: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// Earning legs share the listing query but each has its own status enum:
// trips filter on eDriverPaymentStatus, store-delivery orders on ePaid.
const earningTripsQuery = listQuery.extend({
  status: z.enum(["Settelled", "Unsettelled"]).optional(),
});
const earningOrdersQuery = listQuery.extend({
  status: z.enum(["Yes", "No"]).optional(),
});

// Payout legs (drivers settle trips by eDriverPaymentStatus; store orders by ePaid).
const payoutDriversQuery = listQuery.extend({
  status: z.enum(["Settelled", "Unsettelled"]).optional(),
});
// Store payout filters on eRestaurantPaymentStatus (spelled Settled/Unsettled).
const payoutStoresQuery = listQuery.extend({
  status: z.enum(["Settled", "Unsettled"]).optional(),
});
// Store-driver payout filters on eAdminPaymentStatus — same two spellings.
const payoutStoreDriversQuery = payoutStoresQuery;
// Cancellation payout filters on who cancelled the trip (eCancelledBy).
const payoutCancellationsQuery = listQuery.extend({
  status: z.enum(["Passenger", "Driver"]).optional(),
});
// User Wallet report filters on the ledger classification (user_wallet.eFor).
const userWalletQuery = listQuery.extend({
  status: z
    .enum([
      "Deposit",
      "Booking",
      "Refund",
      "Withdrawl",
      "Charges",
      "Referrer",
      "Transfer",
      "Subscription",
      "Outstanding",
      "Donation",
    ])
    .optional(),
});
// Referral report filters on the referred member type (eUserType); the source
// table has no date column but the shared from/to params stay harmless.
const referralQuery = listQuery.extend({
  status: z.enum(["Rider", "Driver"]).optional(),
});
// Payment Member report filters on the payment event (payments.eEvent).
const paymentMemberQuery = listQuery.extend({
  status: z
    .enum([
      "Wallet",
      "Trip",
      "TripTip",
      "OutStanding",
      "OrderPayment",
      "SubscribePayment",
      "OrderTip",
      "Bidding",
      "giftCard",
      "RideShareBooking",
    ])
    .optional(),
});
// User Reward report filters on the campaign status (reward_campaign.eStatus;
// Deleted campaigns are never listed).
const userRewardQuery = listQuery.extend({
  status: z.enum(["Active", "Inactive", "Cancelled", "Expired"]).optional(),
});
// Hotel / organization payouts settle via the legacy `Settelled/Unsettelled` flags.
const payoutSettlementQuery = listQuery.extend({
  status: z.enum(["Settelled", "Unsettelled"]).optional(),
});

export const reportsRouter = Router();

reportsRouter.use(requireAuth());

/** GET /api/reports/blocked-users/drivers/list — blocked drivers (#sub-101). */
reportsRouter.get(
  "/blocked-users/drivers/list",
  requirePermission("view-blocked-driver"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.blockedDriversList),
);

/** GET /api/reports/blocked-users/drivers/export — CSV of the blocked drivers list (#sub-101). */
reportsRouter.get(
  "/blocked-users/drivers/export",
  requirePermission("export-blocked-driver"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.blockedDriversExport),
);

/** GET /api/reports/blocked-users/riders/list — blocked riders (#sub-101). */
reportsRouter.get(
  "/blocked-users/riders/list",
  requirePermission("view-blocked-rider"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.blockedRidersList),
);

/** GET /api/reports/blocked-users/riders/export — CSV of the blocked riders list (#sub-101). */
reportsRouter.get(
  "/blocked-users/riders/export",
  requirePermission("export-blocked-rider"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.blockedRidersExport),
);

/** PATCH /api/reports/blocked-users/drivers/:id/unblock — unblock a driver. */
reportsRouter.patch(
  "/blocked-users/drivers/:id/unblock",
  requirePermission("update-status-blocked-driver"),
  validate({ params: z.object({ id: fields.positiveInt }) }),
  asyncHandler(ctrl.unblockDriver),
);

/** PATCH /api/reports/blocked-users/riders/:id/unblock — unblock a rider. */
reportsRouter.patch(
  "/blocked-users/riders/:id/unblock",
  requirePermission("update-status-blocked-rider"),
  validate({ params: z.object({ id: fields.positiveInt }) }),
  asyncHandler(ctrl.unblockRider),
);

/** GET /api/reports/outstanding/users/list — user/passenger outstanding (#sub-99). */
reportsRouter.get(
  "/outstanding/users/list",
  requirePermission("view-user-outstanding-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.userOutstandingList),
);

/** GET /api/reports/outstanding/users/export — CSV of the user outstanding leg (#sub-99). */
reportsRouter.get(
  "/outstanding/users/export",
  requirePermission("export-user-outstanding-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.userOutstandingExport),
);

/** GET /api/reports/outstanding/organizations/list — organization outstanding (#sub-99). */
reportsRouter.get(
  "/outstanding/organizations/list",
  requirePermission("view-org-outstanding-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.orgOutstandingList),
);

/** GET /api/reports/outstanding/organizations/export — CSV of the org leg (#sub-99). */
reportsRouter.get(
  "/outstanding/organizations/export",
  requirePermission("export-org-outstanding-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.orgOutstandingExport),
);

/** GET /api/reports/earning/trips/list — Payment Report (Trips/Jobs) (#sub-95). */
reportsRouter.get(
  "/earning/trips/list",
  requirePermission("manage-payment-report"),
  validate({ query: earningTripsQuery }),
  asyncHandler(ctrl.earningTripsList),
);

/** GET /api/reports/earning/orders/list — Admin Earning (Store Deliveries) (#sub-95). */
reportsRouter.get(
  "/earning/orders/list",
  requirePermission("manage-admin-earning"),
  validate({ query: earningOrdersQuery }),
  asyncHandler(ctrl.earningOrdersList),
);

/** GET /api/reports/earning/trips/export — CSV export of the trips leg (#sub-95). */
reportsRouter.get(
  "/earning/trips/export",
  requirePermission("export-payment-report"),
  validate({ query: earningTripsQuery }),
  asyncHandler(ctrl.earningTripsExport),
);

/** GET /api/reports/earning/orders/export — CSV export of the store-delivery leg (#sub-95). */
reportsRouter.get(
  "/earning/orders/export",
  requirePermission("export-admin-earning"),
  validate({ query: earningOrdersQuery }),
  asyncHandler(ctrl.earningOrdersExport),
);

/** GET /api/reports/payout/drivers/list — Driver Payment Report (#sub-96). */
reportsRouter.get(
  "/payout/drivers/list",
  requirePermission("manage-provider-payment-report"),
  validate({ query: payoutDriversQuery }),
  asyncHandler(ctrl.payoutDriversList),
);

/** GET /api/reports/payout/drivers/export — CSV export of the drivers payout leg (#sub-96). */
reportsRouter.get(
  "/payout/drivers/export",
  requirePermission("export-provider-payment-report"),
  validate({ query: payoutDriversQuery }),
  asyncHandler(ctrl.payoutDriversExport),
);

/** GET /api/reports/payout/stores/list — Store Payment Report (#sub-96). */
reportsRouter.get(
  "/payout/stores/list",
  requirePermission("manage-store-payment"),
  validate({ query: payoutStoresQuery }),
  asyncHandler(ctrl.payoutStoresList),
);

/** GET /api/reports/payout/stores/export — CSV export of the stores payout leg (#sub-96). */
reportsRouter.get(
  "/payout/stores/export",
  requirePermission("export-store-payment"),
  validate({ query: payoutStoresQuery }),
  asyncHandler(ctrl.payoutStoresExport),
);

/** GET /api/reports/payout/store-drivers/list — Store Driver Payment Report (#sub-96).
 *  The legacy panel names this pair "store Driver Payment" (`manage-provider-payment`),
 *  which is distinct from the trips-based Driver Payment Report
 *  (`manage-provider-payment-report`). */
reportsRouter.get(
  "/payout/store-drivers/list",
  requirePermission("manage-provider-payment"),
  validate({ query: payoutStoreDriversQuery }),
  asyncHandler(ctrl.payoutStoreDriversList),
);

/** GET /api/reports/payout/store-drivers/export — CSV of the store-drivers payout leg (#sub-96). */
reportsRouter.get(
  "/payout/store-drivers/export",
  requirePermission("export-provider-payment"),
  validate({ query: payoutStoreDriversQuery }),
  asyncHandler(ctrl.payoutStoreDriversExport),
);

/** GET /api/reports/payout/cancellations/list — Cancellation Payment Report (#sub-96).
 *  List only: the legacy panel defines no export permission for this leg. */
reportsRouter.get(
  "/payout/cancellations/list",
  requirePermission("manage-cancellation-payment-report"),
  validate({ query: payoutCancellationsQuery }),
  asyncHandler(ctrl.payoutCancellationsList),
);

/** GET /api/reports/payout/hotels/list — Hotel Payment Report (#sub-96). */
reportsRouter.get(
  "/payout/hotels/list",
  requirePermission("manage-hotel-payment-report"),
  validate({ query: payoutSettlementQuery }),
  asyncHandler(ctrl.payoutHotelsList),
);

/** GET /api/reports/payout/hotels/export — CSV export of the hotels payout leg (#sub-96). */
reportsRouter.get(
  "/payout/hotels/export",
  requirePermission("export-hotel-payment-report"),
  validate({ query: payoutSettlementQuery }),
  asyncHandler(ctrl.payoutHotelsExport),
);

/** GET /api/reports/payout/organizations/list — Organization Payment Report (#sub-96). */
reportsRouter.get(
  "/payout/organizations/list",
  requirePermission("manage-organization-payment-report"),
  validate({ query: payoutSettlementQuery }),
  asyncHandler(ctrl.payoutOrganizationsList),
);

/** GET /api/reports/payout/organizations/export — CSV export of the organizations payout leg (#sub-96). */
reportsRouter.get(
  "/payout/organizations/export",
  requirePermission("export-organization-payment-report"),
  validate({ query: payoutSettlementQuery }),
  asyncHandler(ctrl.payoutOrganizationsExport),
);

/** GET /api/reports/payout/org-cancellations/list — Organization Cancellation Payment Report (#sub-96).
 *  List only: the legacy panel defines no export permission for this leg. */
reportsRouter.get(
  "/payout/org-cancellations/list",
  requirePermission("manage-org-cancellation-payment-report"),
  validate({ query: payoutSettlementQuery }),
  asyncHandler(ctrl.payoutOrgCancellationsList),
);

// ---------------------------------------------------------------------------
// Other Reports (#sub-100)
// ---------------------------------------------------------------------------

const cancelledTripsQuery = listQuery.extend({
  status: z.enum(["Passenger", "Driver"]).optional(),
});

// Cancelled orders filter on who cancelled (orders.eCancelledBy enum).
const cancelledOrdersQuery = listQuery.extend({
  status: z.enum(["Driver", "Passenger", "Company", "Admin"]).optional(),
});

/** GET /api/reports/other/cancelled-trips/list — Cancelled Trip Job Report (#sub-100). */
reportsRouter.get(
  "/other/cancelled-trips/list",
  requirePermission("manage-cancelled-trip-job-report"),
  validate({ query: cancelledTripsQuery }),
  asyncHandler(ctrl.cancelledTripsList),
);

/** GET /api/reports/other/cancelled-trips/export — CSV export of cancelled trips (#sub-100). */
reportsRouter.get(
  "/other/cancelled-trips/export",
  requirePermission("export-cancelled-trip-job-report"),
  validate({ query: cancelledTripsQuery }),
  asyncHandler(ctrl.cancelledTripsExport),
);

/** GET /api/reports/other/cancelled-orders/list — Cancelled Order Report (#sub-100). */
reportsRouter.get(
  "/other/cancelled-orders/list",
  requirePermission("manage-cancelled-order-report"),
  validate({ query: cancelledOrdersQuery }),
  asyncHandler(ctrl.cancelledOrdersList),
);

/** GET /api/reports/other/cancelled-orders/export — CSV export of cancelled orders (#sub-100). */
reportsRouter.get(
  "/other/cancelled-orders/export",
  requirePermission("export-cancelled-order-report"),
  validate({ query: cancelledOrdersQuery }),
  asyncHandler(ctrl.cancelledOrdersExport),
);

// Driver Insurance Reports (#sub-100): three legs over driver_insurance_report
// (idle=Available, accept=Accept, trip=Trip), each list + export.

/** GET /api/reports/other/insurance/idle/list — Insurance Idle Report (#sub-100). */
reportsRouter.get(
  "/other/insurance/idle/list",
  requirePermission("manage-insurance-idle-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceIdleList),
);

/** GET /api/reports/other/insurance/idle/export — CSV of idle segments (#sub-100). */
reportsRouter.get(
  "/other/insurance/idle/export",
  requirePermission("export-insurance-idle-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceIdleExport),
);

/** GET /api/reports/other/insurance/accept/list — Insurance Accept Report (#sub-100). */
reportsRouter.get(
  "/other/insurance/accept/list",
  requirePermission("manage-insurance-accept-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceAcceptList),
);

/** GET /api/reports/other/insurance/accept/export — CSV of accept segments (#sub-100). */
reportsRouter.get(
  "/other/insurance/accept/export",
  requirePermission("export-insurance-accept-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceAcceptExport),
);

/** GET /api/reports/other/insurance/trip/list — Insurance Trip Report (#sub-100). */
reportsRouter.get(
  "/other/insurance/trip/list",
  requirePermission("manage-insurance-trip-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceTripList),
);

/** GET /api/reports/other/insurance/trip/export — CSV of trip segments (#sub-100). */
reportsRouter.get(
  "/other/insurance/trip/export",
  requirePermission("export-insurance-trip-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.insuranceTripExport),
);

/** GET /api/reports/other/provider-log/list — Provider (Driver) Log Report (#sub-100).
 *  List only: the legacy panel defines no export permission for this report. */
reportsRouter.get(
  "/other/provider-log/list",
  requirePermission("manage-provider-log-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.providerLogList),
);

/** GET /api/reports/other/user-wallet/list — User Wallet / Refund / Withdraw /
 *  Referrer Report (#sub-100). List only: no export permission exists. */
reportsRouter.get(
  "/other/user-wallet/list",
  requirePermission("manage-user-wallet-report"),
  validate({ query: userWalletQuery }),
  asyncHandler(ctrl.userWalletList),
);

/** GET /api/reports/other/referral/list — User Referral Report (#sub-100).
 *  List only: no export permission exists. */
reportsRouter.get(
  "/other/referral/list",
  requirePermission("manage-referral-report"),
  validate({ query: referralQuery }),
  asyncHandler(ctrl.referralList),
);

/** GET /api/reports/other/payment-member/list — Payment Member Report (#sub-100).
 *  List only: no export permission exists. */
reportsRouter.get(
  "/other/payment-member/list",
  requirePermission("payment-member"),
  validate({ query: paymentMemberQuery }),
  asyncHandler(ctrl.paymentMemberList),
);

/** GET /api/reports/other/user-reward/list — User Reward Report (#sub-100).
 *  List only: no export permission exists. */
reportsRouter.get(
  "/other/user-reward/list",
  requirePermission("manage-user-reward-report"),
  validate({ query: userRewardQuery }),
  asyncHandler(ctrl.userRewardList),
);

/** GET /api/reports/other/request-acceptance/list — Trips/Jobs Request
 *  Acceptance Report (#sub-100). List only: no export permission exists.
 *  Proxy metric over trips timestamps, so the plain search/date query applies. */
reportsRouter.get(
  "/other/request-acceptance/list",
  requirePermission("manage-trip-job-request-acceptance-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.requestAcceptanceList),
);

/** GET /api/reports/other/time-variance/list — Trips/Jobs Time Variance Report
 *  (#sub-100). List only: no export permission exists. */
reportsRouter.get(
  "/other/time-variance/list",
  requirePermission("manage-trip-job-time-variance-report"),
  validate({ query: listQuery }),
  asyncHandler(ctrl.timeVarianceList),
);
