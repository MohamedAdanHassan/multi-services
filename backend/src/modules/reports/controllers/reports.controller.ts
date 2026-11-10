import type { Request, Response } from "express";
import * as service from "../services/reportsService";

/**
 * Controllers for the Reports module (display group 25). #sub-101 exposes a
 * blocked-drivers and blocked-riders listing plus an unblock mutation; each
 * route is gated by its own permission in reports.routes.ts.
 */

interface QueryShape {
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  status?: string;
}

/** GET /api/reports/blocked-users/drivers/list */
export async function blockedDriversList(req: Request, res: Response) {
  const page = await service.listBlockedUsers("driver", req.query as QueryShape);
  res.json(page);
}

/** GET /api/reports/blocked-users/riders/list */
export async function blockedRidersList(req: Request, res: Response) {
  const page = await service.listBlockedUsers("rider", req.query as QueryShape);
  res.json(page);
}

/** PATCH /api/reports/blocked-users/drivers/:id/unblock */
export async function unblockDriver(req: Request, res: Response) {
  const result = await service.unblockUser("driver", Number(req.params.id));
  res.json({ ok: true, ...result });
}

/** PATCH /api/reports/blocked-users/riders/:id/unblock */
export async function unblockRider(req: Request, res: Response) {
  const result = await service.unblockUser("rider", Number(req.params.id));
  res.json({ ok: true, ...result });
}

/** GET /api/reports/outstanding/users/list — user/passenger outstanding (#sub-99). */
export async function userOutstandingList(req: Request, res: Response) {
  const page = await service.listOutstandingReport("user", req.query as QueryShape);
  res.json(page);
}

/** GET /api/reports/outstanding/organizations/list — organization outstanding (#sub-99). */
export async function orgOutstandingList(req: Request, res: Response) {
  const page = await service.listOutstandingReport("org", req.query as QueryShape);
  res.json(page);
}

// ---------------------------------------------------------------------------
// Earning Report (#sub-95)
// ---------------------------------------------------------------------------

/** Escape a single CSV field per RFC 4180. */
function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Column order differs per leg (trips have a job type + payment mode; orders a store). */
const EARNING_CSV: Record<"trips" | "orders", { header: string[]; cell: (r: Awaited<ReturnType<typeof service.exportEarningReport>>[number]) => (string | number)[] }> = {
  trips: {
    header: ["ID", "Ride No", "Type", "Customer", "Provider", "Fare", "Commission", "Payment Mode", "Driver Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.kind, r.customer, r.provider, r.amount, r.commission, r.paymentMode, r.status, r.date],
  },
  orders: {
    header: ["ID", "Order No", "Store", "Customer", "Provider", "Net Total", "Commission", "Paid", "Date"],
    cell: (r) => [r.id, r.refNo, r.store, r.customer, r.provider, r.amount, r.commission, r.status, r.date],
  },
};

/** Render rows to a CSV string (CRLF line endings, UTF-8 BOM for Excel). */
function toCsv(leg: "trips" | "orders", rows: Awaited<ReturnType<typeof service.exportEarningReport>>): string {
  const { header, cell } = EARNING_CSV[leg];
  const lines = [header.map(csvField).join(",")];
  for (const r of rows) lines.push(cell(r).map(csvField).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** GET /api/reports/earning/trips/list — Payment Report (Trips/Jobs). */
export async function earningTripsList(req: Request, res: Response) {
  const page = await service.listEarningReport("trips", req.query as QueryShape);
  res.json(page);
}

/** GET /api/reports/earning/orders/list — Admin Earning (Store Deliveries). */
export async function earningOrdersList(req: Request, res: Response) {
  const page = await service.listEarningReport("orders", req.query as QueryShape);
  res.json(page);
}

/** GET /api/reports/earning/trips/export — CSV of the trips leg. */
export async function earningTripsExport(req: Request, res: Response) {
  const rows = await service.exportEarningReport("trips", req.query as QueryShape);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="earning-trips.csv"');
  res.send(toCsv("trips", rows));
}

/** GET /api/reports/earning/orders/export — CSV of the store-delivery leg. */
export async function earningOrdersExport(req: Request, res: Response) {
  const rows = await service.exportEarningReport("orders", req.query as QueryShape);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="earning-orders.csv"');
  res.send(toCsv("orders", rows));
}

// ---------------------------------------------------------------------------
// Payout Report (#sub-96) — one listing per payment leg over the LEGS config,
// each with a CSV export where the legacy panel defines an export permission.
// (The cancellations leg is list-only: no export permission exists for it.)
// ---------------------------------------------------------------------------

type PayoutRowDto = Awaited<ReturnType<typeof service.exportPayoutReport>>[number];

/** Legs that expose a CSV export endpoint. */
type PayoutExportLeg = "drivers" | "stores" | "storeDrivers" | "hotels" | "organizations";

interface PayoutCsvSpec {
  header: string[];
  cell: (r: PayoutRowDto) => (string | number)[];
}

const PAYOUT_CSV: Record<PayoutExportLeg, PayoutCsvSpec> = {
  drivers: {
    header: ["ID", "Ride No", "Type", "Provider", "Customer", "Fare", "Commission", "Payout", "Payment Mode", "Driver Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.kind, r.driver, r.customer, r.fare, r.commission, r.payout, r.paymentMode, r.status, r.date],
  },
  stores: {
    header: ["ID", "Order No", "Store", "Driver", "Customer", "Net Total", "Commission", "Store Payout", "Payment Option", "Store Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.store, r.driver, r.customer, r.fare, r.commission, r.payout, r.paymentMode, r.status, r.date],
  },
  storeDrivers: {
    header: ["ID", "Order No", "Store", "Driver", "Customer", "Net Total", "Commission", "Driver Payout", "Payment Option", "Admin Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.store, r.driver, r.customer, r.fare, r.commission, r.payout, r.paymentMode, r.status, r.date],
  },
  hotels: {
    header: ["ID", "Ride No", "Type", "Hotel", "Provider", "Customer", "Fare", "Commission", "Hotel Charge", "Payment Mode", "Hotel Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.kind, r.store, r.driver, r.customer, r.fare, r.commission, r.payout, r.paymentMode, r.status, r.date],
  },
  organizations: {
    header: ["ID", "Ride No", "Type", "Organization", "Provider", "Customer", "Fare", "Commission", "Outstanding", "Payment Mode", "Organization Payment Status", "Date"],
    cell: (r) => [r.id, r.refNo, r.kind, r.store, r.driver, r.customer, r.fare, r.commission, r.payout, r.paymentMode, r.status, r.date],
  },
};

/** Kebab route/filename segment for a camelCase leg key (e.g. storeDrivers → store-drivers). */
function payoutLegSegment(leg: string): string {
  return leg.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Stream a payout leg's rows as an RFC 4180 CSV attachment (Excel-friendly BOM). */
function sendPayoutCsv(
  res: Response,
  leg: PayoutExportLeg,
  rows: PayoutRowDto[],
): void {
  const spec = PAYOUT_CSV[leg];
  const lines = [
    spec.header.map(csvField).join(","),
    ...rows.map((r) => spec.cell(r).map(csvField).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="payout-${payoutLegSegment(leg)}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

/** GET /api/reports/payout/drivers/list — Driver Payment Report. */
export async function payoutDriversList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("drivers", req.query as QueryShape));
}

/** GET /api/reports/payout/drivers/export — CSV of the drivers payout leg. */
export async function payoutDriversExport(req: Request, res: Response) {
  sendPayoutCsv(res, "drivers", await service.exportPayoutReport("drivers", req.query as QueryShape));
}

/** GET /api/reports/payout/stores/list — Store Payment Report. */
export async function payoutStoresList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("stores", req.query as QueryShape));
}

/** GET /api/reports/payout/stores/export — CSV of the stores payout leg. */
export async function payoutStoresExport(req: Request, res: Response) {
  sendPayoutCsv(res, "stores", await service.exportPayoutReport("stores", req.query as QueryShape));
}

/** GET /api/reports/payout/store-drivers/list — Store Driver Payment Report. */
export async function payoutStoreDriversList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("storeDrivers", req.query as QueryShape));
}

/** GET /api/reports/payout/store-drivers/export — CSV of the store-drivers payout leg. */
export async function payoutStoreDriversExport(req: Request, res: Response) {
  sendPayoutCsv(
    res,
    "storeDrivers",
    await service.exportPayoutReport("storeDrivers", req.query as QueryShape),
  );
}

/** GET /api/reports/payout/cancellations/list — Cancellation Payment Report. */
export async function payoutCancellationsList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("cancellations", req.query as QueryShape));
}

/** GET /api/reports/payout/hotels/list — Hotel Payment Report. */
export async function payoutHotelsList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("hotels", req.query as QueryShape));
}

/** GET /api/reports/payout/hotels/export — CSV of the hotels payout leg. */
export async function payoutHotelsExport(req: Request, res: Response) {
  sendPayoutCsv(res, "hotels", await service.exportPayoutReport("hotels", req.query as QueryShape));
}

/** GET /api/reports/payout/organizations/list — Organization Payment Report. */
export async function payoutOrganizationsList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("organizations", req.query as QueryShape));
}

/** GET /api/reports/payout/organizations/export — CSV of the organizations payout leg. */
export async function payoutOrganizationsExport(req: Request, res: Response) {
  sendPayoutCsv(res, "organizations", await service.exportPayoutReport("organizations", req.query as QueryShape));
}

/** GET /api/reports/payout/org-cancellations/list — Organization Cancellation Payment Report.
 *  List only: the legacy panel defines no export permission for this leg. */
export async function payoutOrgCancellationsList(req: Request, res: Response) {
  res.json(await service.listPayoutReport("orgcancellations", req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Outstanding Report (#sub-99) & Blocked accounts (#sub-101) — CSV exports.
// Both pages were list-only until their legacy export permissions were wired
// here: export-user-outstanding-report / export-org-outstanding-report and
// export-blocked-driver / export-blocked-rider.
// ---------------------------------------------------------------------------

type OutstandingRowDto = Awaited<ReturnType<typeof service.exportOutstandingReport>>[number];
type BlockedRowDto = Awaited<ReturnType<typeof service.exportBlockedUsers>>[number];

/** Generic: stream any report's rows as an RFC 4180 CSV attachment (Excel-friendly BOM). */
function sendRowsCsv<Row>(
  res: Response,
  filename: string,
  header: string[],
  rows: Row[],
  cell: (r: Row) => (string | number)[],
): void {
  const lines = [
    header.map(csvField).join(","),
    ...rows.map((r) => cell(r).map(csvField).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

/** The debtor column is worded per leg (passenger vs organization). */
const outstandingHeader = (payer: string): string[] => [
  "ID", payer, "Reference", "Trip ID", "Order ID", "Provider", "Amount", "Payment Mode", "Payment By", "Bill Generated", "Date",
];
const outstandingCell = (r: OutstandingRowDto): (string | number)[] => [
  r.id, r.payerName, r.refNo, r.tripId, r.orderId, r.driverName, r.amount, r.paymentMode, r.paidBy, r.billGenerated, r.date,
];

/** The account column is worded per kind (service provider vs rider). */
const blockedHeader = (who: string): string[] => [
  "ID", who, "Email", "Phone", "Account Status", "Blocked On",
];
const blockedCell = (r: BlockedRowDto): (string | number)[] => [
  r.id, r.name, r.email, r.phone, r.accountStatus, r.blockedAt,
];

/** GET /api/reports/outstanding/users/export — CSV of the user outstanding leg. */
export async function userOutstandingExport(req: Request, res: Response) {
  const rows = await service.exportOutstandingReport("user", req.query as QueryShape);
  sendRowsCsv(res, "outstanding-users.csv", outstandingHeader("User"), rows, outstandingCell);
}

/** GET /api/reports/outstanding/organizations/export — CSV of the org outstanding leg. */
export async function orgOutstandingExport(req: Request, res: Response) {
  const rows = await service.exportOutstandingReport("org", req.query as QueryShape);
  sendRowsCsv(res, "outstanding-organizations.csv", outstandingHeader("Organization"), rows, outstandingCell);
}

/** GET /api/reports/blocked-users/drivers/export — CSV of blocked drivers. */
export async function blockedDriversExport(req: Request, res: Response) {
  const rows = await service.exportBlockedUsers("driver", req.query as QueryShape);
  sendRowsCsv(res, "blocked-drivers.csv", blockedHeader("Provider"), rows, blockedCell);
}

/** GET /api/reports/blocked-users/riders/export — CSV of blocked riders. */
export async function blockedRidersExport(req: Request, res: Response) {
  const rows = await service.exportBlockedUsers("rider", req.query as QueryShape);
  sendRowsCsv(res, "blocked-riders.csv", blockedHeader("Rider"), rows, blockedCell);
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Cancelled Trip Job Report
// ---------------------------------------------------------------------------

const CANCELLED_TRIPS_CSV = {
  header: ["ID", "Ride No", "Type", "Provider", "Customer", "Cancelled By", "Reason ID", "Cancel Reason", "Cancel Comment", "Fare", "Cancel Charge", "Charge Failed", "Trip Status", "Date"],
  cell: (r: Awaited<ReturnType<typeof service.exportCancelledTripReport>>[number]) =>
    [r.id, r.refNo, r.kind, r.driver, r.customer, r.cancelledBy, r.cancelReasonId, r.cancelReason, r.cancelComment, r.fare, r.cancelCharge, r.chargeFailed, r.tripStatus, r.date],
};

/** GET /api/reports/other/cancelled-trips/list — Cancelled Trip Job Report (#sub-100). */
export async function cancelledTripsList(req: Request, res: Response) {
  res.json(await service.listCancelledTripReport(req.query as QueryShape));
}

/** GET /api/reports/other/cancelled-trips/export — CSV of cancelled trip jobs. */
export async function cancelledTripsExport(req: Request, res: Response) {
  const rows = await service.exportCancelledTripReport(req.query as QueryShape);
  const lines = [
    CANCELLED_TRIPS_CSV.header.map(csvField).join(","),
    ...rows.map((r) => CANCELLED_TRIPS_CSV.cell(r).map(csvField).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="cancelled-trip-jobs.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Cancelled Order Report
// ---------------------------------------------------------------------------

const CANCELLED_ORDERS_CSV = {
  header: ["ID", "Order No", "Store", "Driver", "Customer", "Cancelled By", "Cancel Reason", "Net Total", "Cancel Charge", "Refund Amount", "Payment Option", "Date"],
  cell: (r: Awaited<ReturnType<typeof service.exportCancelledOrderReport>>[number]) =>
    [r.id, r.orderNo, r.store, r.driver, r.customer, r.cancelledBy, r.cancelReason, r.netTotal, r.cancelCharge, r.refundAmount, r.paymentOption, r.date],
};

/** GET /api/reports/other/cancelled-orders/list — Cancelled Order Report (#sub-100). */
export async function cancelledOrdersList(req: Request, res: Response) {
  res.json(await service.listCancelledOrderReport(req.query as QueryShape));
}

/** GET /api/reports/other/cancelled-orders/export — CSV of cancelled orders. */
export async function cancelledOrdersExport(req: Request, res: Response) {
  const rows = await service.exportCancelledOrderReport(req.query as QueryShape);
  const lines = [
    CANCELLED_ORDERS_CSV.header.map(csvField).join(","),
    ...rows.map((r) => CANCELLED_ORDERS_CSV.cell(r).map(csvField).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="cancelled-orders.csv"');
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Driver Insurance Reports (idle/accept/trip legs)
// ---------------------------------------------------------------------------

type InsuranceLegDto = "idle" | "accept" | "trip";

type InsuranceRowDto = Awaited<ReturnType<typeof service.exportInsuranceReport>>[number];

const INSURANCE_CSV = {
  header: ["ID", "Driver Id", "Driver", "Trip Id", "Ride No", "Type", "Start Time", "End Time", "Duration (sec)", "Distance", "Start Location", "End Location"],
  cell: (r: InsuranceRowDto) => [r.id, r.driverId, r.driver, r.tripId, r.tripRefNo, r.addedFor, r.startTime, r.endTime, r.durationSeconds, r.distance, r.startLocation, r.endLocation],
};

/** Stream an insurance leg's rows as an RFC 4180 CSV attachment (Excel-friendly BOM). */
function sendInsuranceCsv(res: Response, leg: InsuranceLegDto, rows: InsuranceRowDto[]): void {
  const lines = [
    INSURANCE_CSV.header.map(csvField).join(","),
    ...rows.map((r) => INSURANCE_CSV.cell(r).map(csvField).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="insurance-${leg}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

/** GET /api/reports/other/insurance/idle/list — Insurance Idle Report. */
export async function insuranceIdleList(req: Request, res: Response) {
  res.json(await service.listInsuranceReport("idle", req.query as QueryShape));
}

/** GET /api/reports/other/insurance/idle/export — CSV of idle segments. */
export async function insuranceIdleExport(req: Request, res: Response) {
  sendInsuranceCsv(res, "idle", await service.exportInsuranceReport("idle", req.query as QueryShape));
}

/** GET /api/reports/other/insurance/accept/list — Insurance Accept Report. */
export async function insuranceAcceptList(req: Request, res: Response) {
  res.json(await service.listInsuranceReport("accept", req.query as QueryShape));
}

/** GET /api/reports/other/insurance/accept/export — CSV of accept segments. */
export async function insuranceAcceptExport(req: Request, res: Response) {
  sendInsuranceCsv(res, "accept", await service.exportInsuranceReport("accept", req.query as QueryShape));
}

/** GET /api/reports/other/insurance/trip/list — Insurance Trip Report. */
export async function insuranceTripList(req: Request, res: Response) {
  res.json(await service.listInsuranceReport("trip", req.query as QueryShape));
}

/** GET /api/reports/other/insurance/trip/export — CSV of trip segments. */
export async function insuranceTripExport(req: Request, res: Response) {
  sendInsuranceCsv(res, "trip", await service.exportInsuranceReport("trip", req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Provider (Driver) Log Report
// List only: no export permission exists for it in the legacy panel.
// ---------------------------------------------------------------------------

/** GET /api/reports/other/provider-log/list — Driver Log Report (#sub-100). */
export async function providerLogList(req: Request, res: Response) {
  res.json(await service.listProviderLogReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Wallet / Refund / Withdraw / Referrer Report
// List only: no export permission exists for it in the legacy panel.
// ---------------------------------------------------------------------------

/** GET /api/reports/other/user-wallet/list — User Wallet Report (#sub-100). */
export async function userWalletList(req: Request, res: Response) {
  res.json(await service.listUserWalletReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Referral Report
// List only: no export permission exists; the source table has no date column.
// ---------------------------------------------------------------------------

/** GET /api/reports/other/referral/list — Referral Report (#sub-100). */
export async function referralList(req: Request, res: Response) {
  res.json(await service.listReferralReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Payment Member Report
// List only: no export permission exists. tPaymentDetails (Stripe keys) is
// never selected by the model.
// ---------------------------------------------------------------------------

/** GET /api/reports/other/payment-member/list — Payment Member Report (#sub-100). */
export async function paymentMemberList(req: Request, res: Response) {
  res.json(await service.listPaymentMemberReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — User Reward Report
// List only: no export permission exists. Campaign-centric because the
// driver_reward grants table is empty in this dataset.
// ---------------------------------------------------------------------------

/** GET /api/reports/other/user-reward/list — User Reward Report (#sub-100). */
export async function userRewardList(req: Request, res: Response) {
  res.json(await service.listUserRewardReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Trips/Jobs Request Acceptance Report
// List only: no export permission exists. Proxy metric (dispatch → arrival).
// ---------------------------------------------------------------------------

/** GET /api/reports/other/request-acceptance/list — Request Acceptance (#sub-100). */
export async function requestAcceptanceList(req: Request, res: Response) {
  res.json(await service.listRequestAcceptanceReport(req.query as QueryShape));
}

// ---------------------------------------------------------------------------
// Other Reports (#sub-100) — Trips/Jobs Time Variance Report
// List only: no export permission exists. Proxy metric (fGDtime vs actual).
// ---------------------------------------------------------------------------

/** GET /api/reports/other/time-variance/list — Time Variance (#sub-100). */
export async function timeVarianceList(req: Request, res: Response) {
  res.json(await service.listTimeVarianceReport(req.query as QueryShape));
}
