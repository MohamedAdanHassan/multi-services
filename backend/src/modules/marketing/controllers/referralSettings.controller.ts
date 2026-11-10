import type { Request, Response } from "express";
import type { SettingRow, SettingWrite } from "../../settings/models/settingsModel";
import { parseSelectOptions } from "../../settings/services/settingsService";
import * as service from "../services/referralSettingsService";
import type { ReferralLevelDto } from "../services/referralSettingsService";
import * as audit from "../../audit/services/auditService";
import { EDITABLE_REFERRAL_KEYS } from "../models/referralSettingsModel";

/**
 * HTTP layer for Marketing Tools → MLM Referral Settings (#sub-146). One screen,
 * two legacy sources: the scheme switches in `configurations` and the per-depth
 * commission rows in `multi_level_referral_master`. Reads are served together by
 * `/list` so the page costs one round trip; writes are split by permission
 * (settings save = edit, level create = create, level edit = edit).
 */

/** Audit events for this page. */
export const ReferralSettingsEvents = {
  SettingsUpdated: "referral_settings_updated",
  LevelCreated: "referral_level_created",
  LevelUpdated: "referral_level_updated",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/**
 * Public shape for one scheme setting. `editable` is what tells the UI to draw
 * an input or a locked row: `REFERRAL_SCHEME_ENABLE` and `REFERRAL_AMOUNT`
 * belong to the single-level scheme and stay editable only through General
 * Settings, so they are shown here purely as context.
 */
function settingDto(r: SettingRow) {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    value: r.value,
    help: r.help,
    inputType: r.inputType,
    options: parseSelectOptions(r.selectOptions),
    required: r.required,
    sensitive: r.sensitive,
    maxValue: r.maxValue,
    zeroAllowed: r.zeroAllowed,
    doubleAllowed: r.doubleAllowed,
    spaceAllowed: r.spaceAllowed,
    appArea: r.appArea,
    editable: (EDITABLE_REFERRAL_KEYS as readonly string[]).includes(r.key),
  };
}

/** GET /api/referral-settings/list — settings, levels and the depth ceiling. */
export async function list(_req: Request, res: Response) {
  const { settings, levels, maxLevel } = await service.getPage();
  res.json({ settings: settings.map(settingDto), levels, maxLevel });
}

/** GET /api/referral-settings/levels/:id — one level (edit-page loader). */
export async function getLevel(req: Request, res: Response) {
  res.json({ level: await service.getLevel(Number(req.params.id)) });
}

/** PUT /api/referral-settings/settings — save the scheme switches. */
export async function updateSettings(req: Request, res: Response) {
  const writes = (req.body as { settings: SettingWrite[] }).settings;
  const updated = await service.saveReferralSettings(writes);
  if (updated > 0) await writeAudit(req, ReferralSettingsEvents.SettingsUpdated);
  res.json({ updated });
}

/** POST /api/referral-settings/levels — add a depth. */
export async function createLevel(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const level: ReferralLevelDto = await service.createLevel({
    level: body.level,
    title: body.title,
    amount: body.amount,
  });
  await writeAudit(req, ReferralSettingsEvents.LevelCreated);
  res.status(201).json({ level });
}

/** PUT /api/referral-settings/levels/:id — edit a depth. */
export async function updateLevel(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const level = await service.updateLevel(Number(req.params.id), {
    level: body.level,
    title: body.title,
    amount: body.amount,
  });
  await writeAudit(req, ReferralSettingsEvents.LevelUpdated);
  res.json({ level });
}
