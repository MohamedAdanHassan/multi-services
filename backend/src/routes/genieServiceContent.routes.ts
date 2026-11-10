import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import * as ctrl from "../modules/genie-service-content/controllers/genieServiceContent.controller";
import { AppError } from "../errors/AppError";
import { requireScope, SERVICE_CONTENT_APPS } from "../modules/genie-service-content/models/genieServiceContentModel";
import type { ServiceContentApp } from "../modules/genie-service-content/models/genieServiceContentModel";
import { asyncHandler } from "../utils/asyncHandler";
import { validate, fields } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

/**
 * Delivery Genie → Manage Service/Content (display group 33 → #sub-141) and its Delivery
 * Runner twin (group 34 → #sub-144). Each edits ONE root `vehicle_category` row: Genie's
 * (`iParentId = 0 AND eCatType = 'Genie'`, id 280 today) or Runner's (`… = 'Runner'`, id
 * 287) — the category name in every shipped language, the OTP and promote-banner switches,
 * the display orders, the promotional and home-page copy, and the four artwork columns;
 * exactly the fields the pasted legacy render shows, which is the same render for both.
 *
 * The `:app` URL segment decides BOTH which root row is touched and which permission is
 * demanded, so an admin holding only the Genie keys is refused on the Runner path and vice
 * versa. Both halves derive from one tuple (`SERVICE_CONTENT_APPS`): the enum below admits
 * exactly the apps the scope map knows, and `PERMISSION_KEYS` must answer for each of them.
 *
 * The permission names are the seeded ones, verbatim: sub-group 141 ships
 * `*-service-content-genie-delivery` and sub-group 144 `*-service-content-runner-delivery`,
 * each as view, update and update-status. There is deliberately no create or delete route —
 * the legacy app seeds the root row and this screen only ever edits it, which is also what
 * those six keys say.
 */
const appParam = z.object({ app: z.enum(SERVICE_CONTENT_APPS) });
const idParam = appParam.extend({ id: fields.positiveInt });

/** The three permission keys of each app's sub-group, by action. */
const PERMISSION_KEYS: Record<ServiceContentApp, { view: string; update: string; status: string }> = {
  genie: {
    view: "view-service-content-genie-delivery",
    update: "update-service-content-genie-delivery",
    status: "update-status-service-content-genie-delivery",
  },
  runner: {
    view: "view-service-content-runner-delivery",
    update: "update-service-content-runner-delivery",
    status: "update-status-service-content-runner-delivery",
  },
};

/** Image slots the stream/upload routes address, as the model names them. */
const slotParam = idParam.extend({ slot: z.enum(["icon", "promote", "full-logo", "services-icon"]) });

/**
 * Demand the permission of the app in the URL. `validate` has already accepted the enum,
 * but the key is resolved through {@link requireScope} rather than indexing the param
 * directly, so no path can silently be guarded by another app's keys.
 */
function guard(action: "view" | "update" | "status") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = PERMISSION_KEYS[requireScope(req.params.app).app][action];
      return requirePermission(key)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Payload shape. Each group is optional and carries ONLY the fields the editor changed;
 * the service merges them into what is stored and leaves every other key, column and row
 * alone. Keys stay strings at this layer on purpose: the legal language codes, setting
 * columns and blob fields are whitelisted by the service, which answers with a message
 * naming the field it refused — a zod enum here would refuse with a path instead.
 */
const LANG_CODE = z.string().min(1).max(10);
const MAX_NAMES = 40;
const MAX_SETTINGS = 8;
const MAX_COPY_KEYS = 120;

const updateSchema = z.object({
  names: z.record(LANG_CODE, z.string()).optional(),
  settings: z.record(z.string().min(1).max(64), z.union([z.string(), z.number()])).optional(),
  copy: z
    .record(
      z.string().min(1).max(64),
      z.record(z.string().min(1).max(128), z.string()),
    )
    .optional(),
});

const statusSchema = z.object({ status: z.enum(["Active", "Inactive"]) });

/**
 * A `__proto__` key is dropped by zod's record builder (it sets the prototype instead of
 * adding an own property), so a payload made only of such keys reaches the service empty
 * and would write nothing. Refuse the empty shapes here so the client gets a 400 rather
 * than a successful-looking no-op.
 */
function rejectEmpty(req: Request, res: Response, next: NextFunction) {
  const body = req.body as z.infer<typeof updateSchema>;
  const groups: [string, unknown][] = [
    ["names", body.names],
    ["settings", body.settings],
    ["copy", body.copy],
  ];
  for (const [name, value] of groups) {
    if (value !== undefined && !Object.keys(value as object).length) {
      return next(AppError.badRequest(`Send at least the ${name} that changed, or omit them.`));
    }
  }
  const count = (v: unknown) => (v ? Object.keys(v as object).length : 0);
  if (count(body.names) > MAX_NAMES) {
    return next(AppError.badRequest(`A save may change at most ${MAX_NAMES} languages.`));
  }
  if (count(body.settings) > MAX_SETTINGS) {
    return next(AppError.badRequest(`A save may change at most ${MAX_SETTINGS} settings.`));
  }
  const copyKeys = Object.values(body.copy ?? {}).reduce((n, inner) => n + Object.keys(inner).length, 0);
  if (copyKeys > MAX_COPY_KEYS) {
    return next(AppError.badRequest(`A save may change at most ${MAX_COPY_KEYS} text fields.`));
  }
  if (!count(body.names) && !count(body.settings) && !count(body.copy)) {
    return next(AppError.badRequest("Send at least one of `names`, `settings` or `copy`."));
  }
  return next();
}

export const genieServiceContentRouter = Router();

genieServiceContentRouter.use(requireAuth());

/** GET /api/genie-service-content/:app/list — the app's root row(s). */
genieServiceContentRouter.get(
  "/:app/list",
  validate({ params: appParam }),
  guard("view"),
  asyncHandler(ctrl.list),
);

/** GET /api/genie-service-content/:app/:id — names, copy, artwork, settings, promotion. */
genieServiceContentRouter.get(
  "/:app/:id",
  validate({ params: idParam }),
  guard("view"),
  asyncHandler(ctrl.getOne),
);

/**
 * GET /api/genie-service-content/:app/:id/image/:slot — stream one stored file (cookie
 * auth). The name comes from the column and the bytes from this app's upload dir or, for a
 * row the legacy panel seeded, from the read-only tree it wrote to.
 */
genieServiceContentRouter.get(
  "/:app/:id/image/:slot",
  validate({ params: slotParam }),
  guard("view"),
  asyncHandler(ctrl.image),
);

/** POST /api/genie-service-content/:app/:id/image/:slot — multipart attach or replace. */
genieServiceContentRouter.post(
  "/:app/:id/image/:slot",
  validate({ params: slotParam }),
  guard("update"),
  ctrl.imageUploadMiddleware,
  asyncHandler(ctrl.uploadImage),
);

/**
 * PUT /api/genie-service-content/:app/:id — merge the changed names, settings and copy
 * into the row in one statement. Turning the promote-banner on also switches it off on
 * every other row, as the legacy screen promised; the response counts what it cleared.
 */
genieServiceContentRouter.put(
  "/:app/:id",
  validate({ params: idParam, body: updateSchema }),
  rejectEmpty,
  guard("update"),
  asyncHandler(ctrl.update),
);

/** PATCH /api/genie-service-content/:app/:id/status — activate / deactivate the row. */
genieServiceContentRouter.patch(
  "/:app/:id/status",
  validate({ params: idParam, body: statusSchema }),
  guard("status"),
  asyncHandler(ctrl.setStatus),
);
