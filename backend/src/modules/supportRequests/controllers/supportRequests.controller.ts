import type { Request, Response } from "express";
import * as service from "../services/supportRequestsService";

/**
 * Controllers for the Support Requests reports (group 26). Read-only: no
 * audit logging is needed since nothing mutates state. Each route is gated
 * by its own `view-*-report` permission in supportRequests.routes.ts.
 */

interface QueryShape {
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  userId?: number;
  driverId?: number;
  tripNumber?: string;
  userType?: string;
  status?: string;
}

/** GET /api/support-requests/contact-us/list */
export async function contactUsList(req: Request, res: Response) {
  const page = await service.listContactUs(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}

/** GET /api/support-requests/sos/list */
export async function sosList(req: Request, res: Response) {
  const page = await service.listSos(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}

/** GET /api/support-requests/sos/options — user / service-provider filter lists. */
export async function sosOptions(_req: Request, res: Response) {
  const options = await service.sosFilterOptions();
  res.json(options);
}

/** GET /api/support-requests/payment/list */
export async function paymentList(req: Request, res: Response) {
  const page = await service.listPaymentRequests(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}

/** GET /api/support-requests/trip-job-help/list — Trips/Jobs Help (#sub-105). */
export async function tripJobHelpList(req: Request, res: Response) {
  const page = await service.listTripJobHelp(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}

/** GET /api/support-requests/order-help/list — Order Help (#sub-106). */
export async function orderHelpList(req: Request, res: Response) {
  const page = await service.listOrderHelp(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}

/** GET /api/support-requests/withdraw/list — Withdraw Requests (#sub-108). */
export async function withdrawList(req: Request, res: Response) {
  const page = await service.listWithdrawRequests(req.query as QueryShape);
  res.json({ requests: page.items, total: page.total, page: page.page, limit: page.limit, pages: page.pages });
}
