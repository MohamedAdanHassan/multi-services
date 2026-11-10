import type { Request, Response } from "express";
import * as model from "../models/rewardSettingsModel";
import type { RewardSettingInput } from "../models/rewardSettingsModel";
import * as audit from "../../audit/services/auditService";
import { AppError } from "../../../errors/AppError";

/** Audit events for the reward ladder. */
export const RewardSettingEvents = {
  Updated: "reward_setting_updated",
} as const;

function toDto(r: model.RewardSettingRow) {
  return {
    id: r.id,
    levelName: r.levelName,
    minTrips: r.minTrips,
    ratings: r.ratings,
    acceptanceRate: r.acceptanceRate,
    cancellationRate: r.cancellationRate,
    duration: r.duration,
    credit: r.credit,
    image: r.image,
    rewardLevel: r.rewardLevel,
  };
}

/**
 * GET /api/driver-rewards/settings/list — the whole ladder.
 * Four seeded rungs and no create/delete permission, so it is listed in full
 * without pagination or filters.
 */
export async function list(_req: Request, res: Response) {
  const rows = await model.listSettings();
  res.json({ settings: rows.map(toDto), total: rows.length });
}

export async function getOne(req: Request, res: Response) {
  const row = await model.findSetting(Number(req.params.id));
  if (!row) throw AppError.notFound("Reward level not found");
  res.json({ setting: toDto(row) });
}

/**
 * PUT /api/driver-rewards/settings/:id/update — edit one rung. The badge image
 * and the ladder position are not editable (no upload plumbing exists for them
 * and re-numbering levels would rewrite historic grants' meaning).
 */
export async function update(req: Request, res: Response) {
  const id = Number(req.params.id);
  const existing = await model.findSetting(id);
  if (!existing) throw AppError.notFound("Reward level not found");

  const b = req.body as RewardSettingInput;
  await model.updateSetting(id, b);
  audit.logQuiet(req, RewardSettingEvents.Updated, { adminId: null, email: null });

  const row = await model.findSetting(id);
  res.json({ setting: row ? toDto(row) : null });
}
