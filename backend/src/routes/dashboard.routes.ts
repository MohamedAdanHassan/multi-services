import { Router } from "express";
import * as ctrl from "../modules/dashboard/controllers/dashboard.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

export const dashboardRouter = Router();

// All dashboard reads require an authenticated session with the view-admin grant.
dashboardRouter.use(requireAuth());

dashboardRouter.get(
  "/overview",
  requirePermission("view-admin"),
  asyncHandler(ctrl.overview),
);
