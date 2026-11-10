import type { Request, Response } from "express";
import * as model from "../models/rewardCampaignModel";
import type {
  RewardCampaignInput,
  RewardCampaignStatus,
} from "../models/rewardCampaignModel";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit events for the campaign lifecycle. */
export const RewardCampaignEvents = {
  Created: "reward_campaign_created",
  Updated: "reward_campaign_updated",
  StatusChanged: "reward_campaign_status_changed",
} as const;

function toDto(r: model.RewardCampaignRow) {
  return {
    id: r.id,
    title: r.title,
    startDate: r.startDate,
    endDate: r.endDate,
    status: r.status,
    currentActive: r.currentActive,
    grants: r.grants,
    totalCredit: r.totalCredit,
  };
}

/**
 * Only one campaign may be "current" (the flag the apps read to decide which
 * campaign is running), so checking it demotes every other campaign. Un-checking
 * needs no extra work: the write already stored 'No' on this row. MyISAM has no
 * transactions, hence the two-step demote/promote inside `setCurrent`.
 */
async function promoteIfCurrent(id: number, currentActive: boolean): Promise<void> {
  if (currentActive) await model.setCurrent(id);
}

/** GET /api/driver-rewards/campaigns/list — every campaign that isn't deleted. */
export async function list(req: Request, res: Response) {
  const q = req.query as Record<string, unknown>;
  const status = q.status as RewardCampaignStatus | undefined;
  const rows = await model.listCampaigns({
    search: String(q.search ?? "").trim(),
    status,
    currentOnly: q.current === "true",
  });
  res.json({ campaigns: rows.map(toDto), total: rows.length });
}

export async function getOne(req: Request, res: Response) {
  const row = await model.findCampaign(Number(req.params.id));
  if (!row) throw AppError.notFound("Reward campaign not found");
  res.json({ campaign: toDto(row) });
}

export async function create(req: Request, res: Response) {
  const b = req.body as RewardCampaignInput;
  if (b.endDate < b.startDate) {
    throw AppError.badRequest("The end date cannot precede the start date");
  }

  // Campaigns always start Inactive; going live is a separate, gated action.
  const id = await model.createCampaign(b);
  await promoteIfCurrent(id, b.currentActive);
  audit.logQuiet(req, RewardCampaignEvents.Created, { adminId: null, email: null });

  const row = await model.findCampaign(id);
  res.status(201).json({ campaign: row ? toDto(row) : { id } });
}

export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findCampaign(id);
  if (!existing) throw AppError.notFound("Reward campaign not found");

  const b = req.body as RewardCampaignInput;
  if (b.endDate < b.startDate) {
    throw AppError.badRequest("The end date cannot precede the start date");
  }

  await model.updateCampaign(id, b);
  await promoteIfCurrent(id, b.currentActive);
  audit.logQuiet(req, RewardCampaignEvents.Updated, { adminId: null, email: null });

  const row = await model.findCampaign(id);
  res.json({ campaign: row ? toDto(row) : null });
}

/**
 * PATCH /api/driver-rewards/campaigns/:id/status — Active / Inactive /
 * Cancelled / Expired. 'Deleted' is excluded on purpose: the seed marks
 * `delete-driver-reward-campaign` as Deleted, so no delete path exists.
 */
export async function setStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findCampaign(id);
  if (!existing) throw AppError.notFound("Reward campaign not found");

  const { status } = req.body as { status: RewardCampaignStatus };
  await model.setStatus(id, status);
  audit.logQuiet(req, RewardCampaignEvents.StatusChanged, { adminId: null, email: null });

  const row = await model.findCampaign(id);
  res.json({ campaign: row ? toDto(row) : null });
}
