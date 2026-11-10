import { AppError } from "../../../errors/AppError";
import * as model from "../models/deliveryChargeModel";
import type {
  ChargeFieldSpec,
  ChargeStatus,
  ChargeSummaryRow,
  DeliveryChargeAppScope,
  DeliveryChargeFeatures,
  ScreenMeta,
  ScopeOption,
} from "../models/deliveryChargeModel";
import { ALL_LOCATIONS, OPEN_ENDED_RANGE } from "../models/deliveryChargeModel";

/**
 * Business rules for Delivery Charges (Delivery Genie → #sub-154).
 *
 * A row is one pricing scheme: an order amount to compare against, the charge for
 * orders above it, the charge for orders below it, and the two ways an order can
 * escape paying altogether (a generous subtotal, a short trip). The legacy screen
 * asked for exactly those, plus — when the module switches were on — a distance
 * band and the two Buy Any Service charges.
 *
 * The switches are not decoration, they change the shape of a row:
 *
 * - **distance-wise on**: a location holds several bands, so a new band must start
 *   at 0 when the location has none and may not overlap another band; on edit the
 *   location and the band are frozen (the legacy form disabled both inputs and its
 *   UPDATE omitted both columns), because moving a band would silently re-price
 *   orders that were quoted under the old one.
 * - **distance-wise off**: one scheme per location, which the legacy checked only
 *   in JavaScript (`ajax_check_deliverycharge_area.php`); here it is a server rule.
 *   The band columns are still written — 0 to open-ended — so a row created while
 *   the switch is off keeps meaning the same thing if it is later turned on.
 * - **buy-any-service on**: the two extra charges are asked for; off, they are
 *   stored as 0 and the form never shows them.
 *
 * Values are compared as numbers and stored as the legacy DDL wants them: the two
 * optional amounts are 0 when left blank, which is what "no free-delivery
 * threshold" means to the apps.
 */

/** The columns the DTO carries around, so the form never hardcodes what the server allows. */
export interface DeliveryChargeScopeDto {
  /** Zone id; `0` means every location. */
  locationId: number;
  locationName: string;
  /** True when the stored zone is gone (or was never a delivery-charge zone). */
  missing: boolean;
  /** What the screen shows for it: the zone name, or "All locations". */
  label: string;
}

export interface DeliveryChargeDistanceDto {
  from: number;
  to: number;
  /** True when `to` is the open-ended sentinel. */
  open: boolean;
  label: string;
}

export interface DeliveryChargeDto {
  id: number;
  status: ChargeStatus;
  scope: DeliveryChargeScopeDto;
  distance: DeliveryChargeDistanceDto;
  /** Legacy column → stored value as text, so the form diffs without type surprises. */
  settings: Record<string, string>;
  /** The money / distance columns this screen asks about, given the switches. */
  fieldSpecs: ChargeFieldSpec[];
  /** Whether the location and the band may be changed on this row. */
  scopeEditable: boolean;
  features: DeliveryChargeFeatures;
  currency: { name: string; symbol: string };
  /** Zones the location dropdown may offer. */
  locations: ScopeOption[];
}

/** What the caller may send; every key is optional except the required amounts. */
export interface DeliveryChargeInput {
  locationId?: unknown;
  settings?: Record<string, unknown>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || str(value).trim() === "";
}

/** The columns this screen edits, given the two switches. */
function visibleFields(features: DeliveryChargeFeatures): ChargeFieldSpec[] {
  return [...model.CHARGE_FIELDS, ...model.DISTANCE_RANGE_FIELDS].filter(
    (f) => !f.feature || features[f.feature],
  );
}

function distanceLabel(from: number, to: number): string {
  const unit = "km";
  const high = to >= OPEN_ENDED_RANGE ? "∞" : `${to}`;
  return `${from} – ${high} ${unit}`;
}

/**
 * What the screens and the messages call a row's location. The wording lives in the
 * model, so the list column, the editor's frozen scope and a delete confirmation cannot
 * drift apart — the last of those has to be typed back exactly, which is the one place a
 * differently-worded label would cost an admin their row.
 */
const scopeLabel = model.scopeLabelOf;

async function mustFind(id: number): Promise<model.ChargeRow> {
  const row = await model.findChargeRow(id);
  if (!row) throw AppError.notFound(`Delivery charge #${id} not found.`);
  return row;
}

async function toDto(row: model.ChargeRow, meta: ScreenMeta): Promise<DeliveryChargeDto> {
  return {
    id: row.id,
    status: row.status,
    scope: {
      locationId: row.locationId,
      locationName: row.locationName,
      missing: row.locationId !== ALL_LOCATIONS && !row.locationName,
      label: scopeLabel(row.locationId, row.locationName),
    },
    distance: {
      from: row.distanceFrom,
      to: row.distanceTo,
      open: row.distanceTo >= OPEN_ENDED_RANGE,
      label: distanceLabel(row.distanceFrom, row.distanceTo),
    },
    settings: row.values,
    fieldSpecs: visibleFields(meta.features),
    // The legacy editor freezes the scope while the bands are in charge of it.
    scopeEditable: !meta.features.distanceWise,
    features: meta.features,
    currency: meta.currency,
    locations: meta.locations,
  };
}

/** Amount or distance: a finite number inside the spec's range, or a clear refusal. */
function cleanNumber(spec: ChargeFieldSpec, value: unknown): number {
  const text = str(value).trim();
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw AppError.badRequest(`“${spec.label}” must be a number.`);
  }
  if (n < spec.min || n > spec.max) {
    throw AppError.badRequest(`“${spec.label}” must be between ${spec.min} and ${spec.max}.`);
  }
  return spec.kind === "distance" ? Math.round(n) : n;
}

/**
 * One accepted value of the settings map. Blank is allowed only where the legacy
 * form left the field optional; it means "not set", which the DDL stores as 0.
 */
function cleanSetting(spec: ChargeFieldSpec, value: unknown): string | number {
  if (isBlank(value)) {
    if (spec.required) throw AppError.badRequest(`“${spec.label}” is required.`);
    return 0;
  }
  return cleanNumber(spec, value);
}

/** The band's upper bound, which the form may send as the sentinel or as "open ended". */
function cleanRangeEnd(value: unknown): number {
  const text = str(value).trim().toLowerCase();
  if (text === "∞" || text === "infinity" || text === "open") return OPEN_ENDED_RANGE;
  const n = Number(text);
  if (Number.isFinite(n) && n >= OPEN_ENDED_RANGE) return OPEN_ENDED_RANGE;
  return cleanNumber(model.FIELD_BY_COLUMN.iDistanceRangeTo, value);
}

/**
 * Validate the settings map into the columns a save writes, keyed by legacy name.
 *
 * `demandRequired` separates the two callers: a create has to arrive with a complete
 * scheme, while a save carries only what changed — the columns it does not mention keep
 * the values already stored. A blank is still refused on a required column either way,
 * because "blank" is a decision to clear it, not silence about it.
 */
function cleanSettings(
  input: Record<string, unknown> | undefined,
  features: DeliveryChargeFeatures,
  demandRequired: boolean,
): Record<string, string | number> {
  const payload = input ?? {};
  const out: Record<string, string | number> = Object.create(null) as Record<string, string | number>;

  for (const [key, value] of Object.entries(payload)) {
    const spec = Object.prototype.hasOwnProperty.call(model.FIELD_BY_COLUMN, key)
      ? model.FIELD_BY_COLUMN[key]
      : undefined;
    if (!spec) {
      throw AppError.badRequest(`Unknown delivery-charge value “${key}”.`);
    }
    if (spec.feature && !features[spec.feature]) {
      const switchName =
        spec.feature === "distanceWise" ? "distance-wise delivery charges" : "Buy Any Service";
      throw AppError.badRequest(
        `“${spec.label}” is only editable while ${switchName} is enabled.`,
      );
    }
    out[key] = spec.column === "iDistanceRangeTo" ? cleanRangeEnd(value) : cleanSetting(spec, value);
  }

  if (!demandRequired) return out;
  for (const spec of visibleFields(features)) {
    if (spec.required && !Object.prototype.hasOwnProperty.call(out, spec.column)) {
      throw AppError.badRequest(`“${spec.label}” is required.`);
    }
  }
  return out;
}

/**
 * Distance bounds: fill in what the form does not ask for, then check the pair.
 * With the switch off every row is 0 → open-ended; with it on the band has to be
 * a real interval.
 */
async function resolveDistance(
  features: DeliveryChargeFeatures,
  settings: Record<string, string | number>,
  locationId: number,
  exceptId: number | null,
): Promise<{ from: number; to: number }> {
  if (!features.distanceWise) {
    return { from: 0, to: OPEN_ENDED_RANGE };
  }
  const from = Number(settings.iDistanceRangeFrom ?? NaN);
  const to = Number(settings.iDistanceRangeTo ?? NaN);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw AppError.badRequest("Distance range from and to are required.");
  }
  if (from < 0) throw AppError.badRequest("Distance range from cannot be negative.");
  if (to !== OPEN_ENDED_RANGE && to <= from) {
    throw AppError.badRequest("Distance range to must be greater than distance range from.");
  }

  const existing = await model.listDistanceRanges(locationId, exceptId);
  if (!existing.length && from !== 0) {
    // The legacy create insisted on this ("Distance Range From should start from 0.")
    // because the apps walk the bands in order and a gap at the start means a trip
    // with no price at all.
    throw AppError.badRequest("The first distance range for a location must start at 0.");
  }
  for (const band of existing) {
    const high = band.to >= OPEN_ENDED_RANGE ? Number.POSITIVE_INFINITY : band.to;
    const mineHigh = to >= OPEN_ENDED_RANGE ? Number.POSITIVE_INFINITY : to;
    if (from < high && band.from < mineHigh) {
      throw AppError.badRequest(
        `A delivery charge already covers ${distanceLabel(band.from, band.to)} for this location.`,
      );
    }
  }
  return { from, to };
}

/** One scheme per location while the bands are not in charge of pricing. */
async function assertLocationFree(locationId: number, exceptId: number | null): Promise<void> {
  const rows = await model.listChargeRows();
  const clash = rows.find((r) => r.id !== exceptId && r.locationId === locationId);
  if (clash) {
    throw AppError.badRequest(
      `Delivery charges for ${scopeLabel(locationId, clash.locationName)} already exist (#${clash.id}).`,
    );
  }
}

/** Every money / distance column the DDL insists on, so a create can never omit one. */
function fillInsertValues(
  settings: Record<string, string | number>,
  features: DeliveryChargeFeatures,
  distance: { from: number; to: number },
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const spec of [...model.CHARGE_FIELDS, ...model.DISTANCE_RANGE_FIELDS]) {
    const sent = Object.prototype.hasOwnProperty.call(settings, spec.column)
      ? settings[spec.column]
      : undefined;
    if (sent !== undefined) {
      values[spec.column] = sent;
    } else if (spec.column === "iDistanceRangeFrom") {
      values[spec.column] = distance.from;
    } else if (spec.column === "iDistanceRangeTo") {
      values[spec.column] = distance.to;
    } else {
      values[spec.column] = 0;
    }
  }
  // With the switch off the two Buy Any Service amounts are never asked for, and 0
  // is what the legacy save wrote for them too.
  if (!features.buyAnyService) {
    values.fDeliveryChargeBuyAnyService = 0;
    values.fDeliveryChargeBuyAnyServiceCancelledOrder = 0;
  }
  return values;
}

/** Location id: the sentinel, or a zone of this screen's own marker. */
async function cleanLocation(scope: DeliveryChargeAppScope, value: unknown): Promise<number> {
  const text = str(value).trim();
  if (!text) throw AppError.badRequest("Select a location, or All locations.");
  const id = Number(text);
  if (!Number.isInteger(id) || id < 0) throw AppError.badRequest("Location must be a whole number.");
  if (!(await model.isKnownLocation(scope.locationEFor, id))) {
    throw AppError.badRequest(`Location #${id} is not a delivery-charge zone.`);
  }
  return id;
}

/** The status a new row starts at: the legacy form never asked, and the DDL says Active. */
const CREATE_STATUS: ChargeStatus = "Active";

export async function createCharge(
  scope: DeliveryChargeAppScope,
  input: DeliveryChargeInput,
): Promise<DeliveryChargeDto> {
  const meta = await model.readScreenMeta(scope);
  const settings = cleanSettings(input.settings, meta.features, true);
  const locationId = await cleanLocation(scope, input.locationId);
  const distance = await resolveDistance(meta.features, settings, locationId, null);
  if (!meta.features.distanceWise) await assertLocationFree(locationId, null);

  const id = await model.nextChargeId();
  await model.insertChargeRow(id, {
    locationId,
    values: fillInsertValues(settings, meta.features, distance),
  });
  return toDto(await mustFind(id), meta);
}

export async function updateCharge(
  scope: DeliveryChargeAppScope,
  id: number,
  input: DeliveryChargeInput,
): Promise<DeliveryChargeDto> {
  const meta = await model.readScreenMeta(scope);
  const row = await mustFind(id);
  const settings = cleanSettings(input.settings, meta.features, false);

  // The legacy editor freezes the scope while the bands own pricing: an order quoted
  // under one band must not be re-priced by moving it after the fact, so the two band
  // columns are never written here — only checked.
  const wantsLocation =
    input.locationId === undefined || isBlank(input.locationId)
      ? row.locationId
      : await cleanLocation(scope, input.locationId);
  if (wantsLocation !== row.locationId) {
    if (meta.features.distanceWise) {
      throw AppError.badRequest(
        "A charge's location is fixed while distance-wise charges are on — delete the row and add it again.",
      );
    }
    await assertLocationFree(wantsLocation, id);
  }

  if (settings.iDistanceRangeFrom !== undefined || settings.iDistanceRangeTo !== undefined) {
    // Asking resolveDistance the same question a create would, so a band that would
    // overlap a sibling is refused before anything is written; a band that merely
    // repeats what is stored passes through and is then dropped.
    const wanted = await resolveDistance(
      meta.features,
      {
        iDistanceRangeFrom: settings.iDistanceRangeFrom ?? row.distanceFrom,
        iDistanceRangeTo: settings.iDistanceRangeTo ?? row.distanceTo,
      },
      wantsLocation,
      id,
    );
    if (wanted.from !== row.distanceFrom || wanted.to !== row.distanceTo) {
      throw AppError.badRequest(
        "A charge's distance band is fixed once it exists — delete the row and add it again.",
      );
    }
  }

  const sets = Object.entries(settings)
    .filter(([column]) => column !== "iDistanceRangeFrom" && column !== "iDistanceRangeTo")
    .map(([column, value]) => ({ column, value }));
  if (wantsLocation !== row.locationId) sets.push({ column: "iLocationId", value: wantsLocation });
  if (!sets.length) throw AppError.badRequest("Send at least the charge values that changed.");
  await model.updateChargeColumns(id, sets);
  return toDto(await mustFind(id), meta);
}

/** One row plus everything the form needs around it. */
export async function getCharge(
  scope: DeliveryChargeAppScope,
  id: number,
): Promise<DeliveryChargeDto> {
  const meta = await model.readScreenMeta(scope);
  return toDto(await mustFind(id), meta);
}

/** A blank row of the shape this screen would create, for the add form's defaults. */
export async function blankRecord(
  scope: DeliveryChargeAppScope,
): Promise<DeliveryChargeDto> {
  const meta = await model.readScreenMeta(scope);
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const spec of visibleFields(meta.features)) {
    values[spec.column] = spec.required ? "" : "0";
  }
  return {
    id: 0,
    status: CREATE_STATUS,
    scope: { locationId: ALL_LOCATIONS, locationName: "", missing: false, label: "All locations" },
    distance: { from: 0, to: OPEN_ENDED_RANGE, open: true, label: distanceLabel(0, OPEN_ENDED_RANGE) },
    settings: values,
    fieldSpecs: visibleFields(meta.features),
    scopeEditable: true,
    features: meta.features,
    currency: meta.currency,
    locations: meta.locations,
  };
}

export interface ChargePage {
  rows: ChargeSummaryRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  meta: ScreenMeta;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function listFilters(raw: Record<string, unknown>): model.ChargeListFilters {
  return {
    search: str(raw.search ?? raw.keyword ?? "").trim(),
    status: raw.status === "Active" || raw.status === "Inactive" ? (raw.status as ChargeStatus) : undefined,
    sort: str(raw.sort ?? ""),
    order: str(raw.order ?? "desc").toLowerCase() === "asc" ? "asc" : "desc",
  };
}

/**
 * One filtered page of the schemes. The switches and the currency ride along, so
 * the panel can decide which columns exist from the same response that fills them.
 */
export async function listChargesPaged(
  scope: DeliveryChargeAppScope,
  raw: Record<string, unknown>,
): Promise<ChargePage> {
  const meta = await model.readScreenMeta(scope);
  const filters = listFilters(raw);
  const limit = Math.min(Math.max(Number(raw.limit) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  let page = Math.max(Number(raw.page) || 1, 1);

  const [total, rows] = await Promise.all([
    model.countCharges(filters),
    model.listChargePage(filters, page, limit),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  if (page > pages) {
    page = pages;
    const again = await model.listChargePage(filters, page, limit);
    return pageResult(again, total, page, limit, pages, meta);
  }
  return pageResult(rows, total, page, limit, pages, meta);
}

function pageResult(
  rows: ChargeSummaryRow[],
  total: number,
  page: number,
  limit: number,
  pages: number,
  meta: ScreenMeta,
): ChargePage {
  return {
    rows,
    total,
    page,
    limit,
    pages,
    meta: { features: meta.features, currency: meta.currency, locations: meta.locations },
  };
}

/** The un-paginated list, for a caller that asks for no filtering at all. */
export async function listCharges(
  scope: DeliveryChargeAppScope,
): Promise<{ rows: ChargeSummaryRow[]; meta: ScreenMeta }> {
  const [meta, rows] = await Promise.all([model.readScreenMeta(scope), model.listChargeRows()]);
  return { rows, meta: { features: meta.features, currency: meta.currency, locations: meta.locations } };
}

export async function changeStatus(
  scope: DeliveryChargeAppScope,
  id: number,
  status: ChargeStatus,
): Promise<DeliveryChargeDto> {
  const meta = await model.readScreenMeta(scope);
  const row = await mustFind(id);
  if (row.status !== status) await model.setChargeStatus(id, status);
  return toDto(await mustFind(id), meta);
}

/**
 * Soft delete, name-confirmed. The legacy screen ran a real `DELETE`; hiding the row
 * does the same job for the apps (they only price with `eStatus='Active'` rows) and
 * leaves the pricing on file, so it can be restored with direct access to the table.
 * The distance-wise screen is not a reason to hold a delete back: its
 * `iDeliveyChargeId` is that table's own id and points at nothing here, so the two
 * screens each only ever removed rows of their own table.
 */
export async function deleteCharge(
  scope: DeliveryChargeAppScope,
  id: number,
  confirm: unknown,
): Promise<{ id: number; label: string }> {
  const row = await mustFind(id);
  const label = scopeLabel(row.locationId, row.locationName);

  const wanted = typeof confirm === "string" ? confirm.trim() : "";
  if (!wanted) throw AppError.badRequest(`Type “${label}” to confirm the delete.`);
  if (wanted !== label) {
    throw AppError.badRequest(`Confirmation does not match: this charge is for “${label}”.`);
  }

  await model.softDeleteCharge(id);
  return { id, label };
}
