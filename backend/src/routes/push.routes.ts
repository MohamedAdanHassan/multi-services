import { Router } from "express";
import { z } from "zod";
import * as ctrl from "../modules/marketing/controllers/push.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { validate } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Routes for Marketing Tools → Send Push-Notification (#sub-114).
 *
 * One capability, four handlers: `manage-send-push-notification` is the only row
 * the sub-group owns, so it gates the history read, the two audience reads and
 * the record write alike. Structural checks only — enum membership, the message
 * length and the recipient rules are policed in pushService, where the legacy
 * semantics they come from are documented.
 */

// '' is a real value here ("no country filter"), so the pattern is not checked
// in the schema; the service rejects anything that is neither empty nor 2 letters.
const audienceQuery = z.object({
  audience: z.string().trim().min(1).max(20),
  segment: z.string().trim().max(20).optional(),
  country: z.string().trim().max(2).optional(),
});

const historyQuery = z.object({
  limit: z.string().trim().max(6).optional(),
});

const sendSchema = audienceQuery.extend({
  message: z.string().min(1),
  // Optional narrowing of the resolved audience; always intersected server-side.
  recipients: z.array(z.number()).optional(),
});

export const pushRouter = Router();

pushRouter.use(requireAuth());

/** GET /api/push-notifications/history — recorded notifications, newest first. */
pushRouter.get(
  "/history",
  requirePermission("manage-send-push-notification"),
  validate({ query: historyQuery }),
  asyncHandler(ctrl.history),
);

/** GET /api/push-notifications/preview — resolve an audience without recording it. */
pushRouter.get(
  "/preview",
  requirePermission("manage-send-push-notification"),
  validate({ query: audienceQuery }),
  asyncHandler(ctrl.preview),
);

/** GET /api/push-notifications/countries — countries present in an audience. */
pushRouter.get(
  "/countries",
  requirePermission("manage-send-push-notification"),
  validate({ query: audienceQuery }),
  asyncHandler(ctrl.countries),
);

/** POST /api/push-notifications/send — record one row per reached recipient. */
pushRouter.post(
  "/send",
  requirePermission("manage-send-push-notification"),
  validate({ body: sendSchema }),
  asyncHandler(ctrl.send),
);
