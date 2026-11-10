import type { Request, Response } from "express";
import * as model from "../models/rewardReportModel";

function toDto(r: model.RewardGrantRow) {
  return {
    id: r.id,
    driverId: r.driverId,
    driverName: r.driverName,
    campaignId: r.campaignId,
    campaignTitle: r.campaignTitle,
    levelName: r.levelName,
    rewardLevel: r.rewardLevel,
    minTrips: r.minTrips,
    ratings: r.ratings,
    acceptanceRate: r.acceptanceRate,
    cancellationRate: r.cancellationRate,
    duration: r.duration,
    credit: r.credit,
    grantedAt: r.grantedAt,
  };
}

/**
 * GET /api/driver-rewards/report/list — one page of granted rewards.
 * Read-only: no seeded permission allows issuing a grant by hand, and the
 * criteria shown are the snapshot taken at grant time.
 */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 25);
  const filters: model.RewardGrantFilters = {
    search: String(q.search ?? "").trim(),
    driverId: Number(q.driverId ?? 0) || undefined,
    campaignId: Number(q.campaignId ?? 0) || undefined,
    from: q.from ? String(q.from) : undefined,
    to: q.to ? String(q.to) : undefined,
    page,
    limit,
  };
  const [grants, total] = await Promise.all([
    model.listGrants(filters),
    model.countGrants(filters),
  ]);
  res.json({
    grants: grants.map(toDto),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
}
