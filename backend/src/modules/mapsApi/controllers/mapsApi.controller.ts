import type { Request, Response } from "express";
import type { SettingRow, SettingWrite } from "../../settings/models/settingsModel";
import * as model from "../models/mapsApiModel";
import * as service from "../services/mapsApiService";
import { parseSelectOptions } from "../../settings/services/settingsService";
import * as audit from "../../audit/services/auditService";

/** Audit event for a Maps API settings save. */
export const MapsApiEvents = {
  Updated: "maps_api_settings_updated",
} as const;

/** Public API shape for one editable Maps setting (same as General Settings). */
function toDto(r: SettingRow) {
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
  };
}

/** GET /api/maps-api/list — the active Maps-related settings, curated order. */
export async function list(_req: Request, res: Response) {
  const rows = await model.listMapsSettings();
  res.json({ settings: rows.map(toDto), total: rows.length });
}

/** PUT /api/maps-api/update — validate and persist a batch, then audit the save. */
export async function update(req: Request, res: Response) {
  const writes = (req.body as { settings: SettingWrite[] }).settings;
  const updated = await service.saveMapsSettings(writes);

  if (updated > 0 && req.auth) {
    audit.logQuiet(req, MapsApiEvents.Updated, {
      adminId: req.auth.adminId,
      email: req.auth.email,
    });
  }

  res.json({ updated });
}
