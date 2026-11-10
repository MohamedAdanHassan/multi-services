import type { Request, Response } from "express";
import * as model from "../models/settingsModel";
import type { SettingRow, SettingWrite } from "../models/settingsModel";
import * as service from "../services/settingsService";
import * as audit from "../../audit/services/auditService";

/** Audit event for a general-settings save. */
export const SettingsEvents = {
  Updated: "general_settings_updated",
} as const;

/** Human-friendly labels for the legacy `eType` category values. */
const CATEGORY_LABELS: Record<string, string> = {
  General: "General",
  Apperance: "Appearance",
  Email: "Email",
  SMS: "SMS",
  Payment: "Payment",
  Prices: "Prices",
  Paypal: "PayPal",
  "Social Media": "Social Media",
  "App Settings": "App Settings",
  "Installation Settings": "Installation",
  "Store Settings": "Store",
  Blocked: "Blocked",
  "Ride Share Settings": "Ride Share",
};

/** API shape for a single editable setting. */
function toDto(r: SettingRow) {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    value: r.value,
    help: r.help,
    inputType: r.inputType,
    options: service.parseSelectOptions(r.selectOptions),
    required: r.required,
    sensitive: r.sensitive,
    maxValue: r.maxValue,
    zeroAllowed: r.zeroAllowed,
    doubleAllowed: r.doubleAllowed,
    spaceAllowed: r.spaceAllowed,
    appArea: r.appArea,
  };
}

/**
 * All editable settings grouped into ordered categories. The model already
 * returns rows sorted by category then display order, so we just bucket them
 * while preserving first-seen category order.
 */
export async function list(_req: Request, res: Response) {
  const rows = await service.listEditableSettingsCached();
  const order: string[] = [];
  const buckets = new Map<string, ReturnType<typeof toDto>[]>();
  for (const r of rows) {
    if (!buckets.has(r.category)) {
      buckets.set(r.category, []);
      order.push(r.category);
    }
    buckets.get(r.category)!.push(toDto(r));
  }
  const categories = order.map((key) => ({
    key,
    label: CATEGORY_LABELS[key] ?? key,
    settings: buckets.get(key)!,
  }));
  res.json({ categories, total: rows.length });
}

/** Validate and persist a batch of value changes, then audit the save. */
export async function update(req: Request, res: Response) {
  const writes = (req.body as { settings: SettingWrite[] }).settings;
  const updated = await service.saveSettings(writes);

  if (updated > 0 && req.auth) {
    audit.logQuiet(req, SettingsEvents.Updated, {
      adminId: req.auth.adminId,
      email: req.auth.email,
    });
  }

  res.json({ updated });
}
