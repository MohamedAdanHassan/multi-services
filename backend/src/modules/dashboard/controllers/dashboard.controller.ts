import type { Request, Response } from "express";
import * as dashboard from "../models/dashboardModel";
import type { DashboardOverview } from "../models/dashboardModel";
import { createTtlCache } from "../../../utils/ttlCache";

/**
 * The overview fans out to a dozen COUNT/SUM aggregates; every admin lands on
 * it right after login. 10s of reuse is imperceptible on live statistics but
 * turns refresh storms (multiple tabs, back/forward) into a single fan-out.
 */
const overviewCache = createTtlCache<DashboardOverview>(10_000, 4);

/** GET /api/dashboard/overview — all dashboard statistics in one payload. */
export async function overview(_req: Request, res: Response) {
  const data = await overviewCache.load("overview", async () =>
    dashboard.getDashboardOverview(),
  );
  res.json(data);
}
