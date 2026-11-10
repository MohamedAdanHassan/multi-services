import { Router } from "express";
import { z } from "zod";
import * as settingsCtrl from "../modules/driver-rewards/controllers/rewardSettings.controller";
import * as campaignsCtrl from "../modules/driver-rewards/controllers/rewardCampaigns.controller";
import * as reportCtrl from "../modules/driver-rewards/controllers/rewardReport.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Drivers → Manage Reward (#sub-5). Three panels behind one prefix, each on its
 * own seeded permission: the reward ladder (`reward_settings`), the campaigns
 * (`reward_campaign`) and the grants report (`driver_reward`).
 *
 * There is deliberately no delete route: `delete-driver-reward-campaign` is
 * seeded as Deleted, so campaigns can only be cancelled/expired via the status
 * action, and the ladder has no create/delete permission at all.
 */

const idParam = z.object({ id: fields.positiveInt });

/** A real calendar date, not just the shape of one. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "That date does not exist");

const campaignStatus = z.enum(["Active", "Inactive", "Cancelled", "Expired"]);

// ---------------------------------------------------------------------------
// Reward ladder (reward_settings)
// ---------------------------------------------------------------------------

const settingSchema = z.object({
  levelName: z.string().trim().min(1, "Level name is required").max(100),
  minTrips: z.coerce.number().int().min(0, "Minimum trips cannot be negative").max(99999),
  // `fRatings` is the rating floor the driver must hold, on a 5-star scale.
  ratings: z.coerce.number().min(0).max(5, "Ratings cannot exceed 5"),
  acceptanceRate: z.coerce.number().int().min(0, "Acceptance rate cannot be negative").max(100),
  cancellationRate: z.coerce.number().int().min(0, "Cancellation rate cannot be negative").max(100),
  duration: z.coerce.number().int().min(0, "Duration cannot be negative").max(9999),
  credit: z.coerce.number().min(0, "Credit cannot be negative").max(99999999),
});

// ---------------------------------------------------------------------------
// Campaigns (reward_campaign)
// ---------------------------------------------------------------------------

const campaignListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: campaignStatus.optional(),
  current: z.enum(["true", "false"]).optional(),
});

const campaignSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  startDate: isoDate,
  endDate: isoDate,
  // JSON body, so this arrives as a real boolean from the form's switch.
  currentActive: z.boolean().default(false),
});

const campaignStatusSchema = z.object({ status: campaignStatus });

// ---------------------------------------------------------------------------
// Grants report (driver_reward)
// ---------------------------------------------------------------------------

const reportQuery = z.object({
  search: z.string().trim().max(100).optional(),
  driverId: z.coerce.number().int().min(0).optional(),
  campaignId: z.coerce.number().int().min(0).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const driverRewardRouter = Router();

driverRewardRouter.use(requireAuth());

// --- ladder ---------------------------------------------------------------
// Literal `/list` before the `/:id` capture in each section so the param route
// can't swallow it.

driverRewardRouter.get(
  "/settings/list",
  requirePermission("view-driver-reward-setting"),
  asyncHandler(settingsCtrl.list),
);

driverRewardRouter.get(
  "/settings/:id",
  validate({ params: idParam }),
  requirePermission("view-driver-reward-setting"),
  asyncHandler(settingsCtrl.getOne),
);

driverRewardRouter.put(
  "/settings/:id/update",
  validate({ params: idParam, body: settingSchema }),
  requirePermission("update-driver-reward-setting"),
  asyncHandler(settingsCtrl.update),
);

// --- campaigns ------------------------------------------------------------

driverRewardRouter.get(
  "/campaigns/list",
  validate({ query: campaignListQuery }),
  requirePermission("view-driver-reward-campaign"),
  asyncHandler(campaignsCtrl.list),
);

driverRewardRouter.post(
  "/campaigns/create",
  validate({ body: campaignSchema }),
  requirePermission("create-driver-reward-campaign"),
  asyncHandler(campaignsCtrl.create),
);

driverRewardRouter.get(
  "/campaigns/:id",
  validate({ params: idParam }),
  requirePermission("view-driver-reward-campaign"),
  asyncHandler(campaignsCtrl.getOne),
);

driverRewardRouter.put(
  "/campaigns/:id/update",
  validate({ params: idParam, body: campaignSchema }),
  requirePermission("edit-driver-reward-campaign"),
  asyncHandler(campaignsCtrl.update),
);

driverRewardRouter.patch(
  "/campaigns/:id/status",
  validate({ params: idParam, body: campaignStatusSchema }),
  requirePermission("update-status-driver-reward-campaign"),
  asyncHandler(campaignsCtrl.setStatus),
);

// --- grants report --------------------------------------------------------

driverRewardRouter.get(
  "/report/list",
  validate({ query: reportQuery }),
  requirePermission("view-driver-reward-report"),
  asyncHandler(reportCtrl.list),
);
