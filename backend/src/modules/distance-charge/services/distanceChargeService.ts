import { AppError } from "../../../errors/AppError";
import * as model from "../models/distanceChargeModel";
import type {
  DistanceChargeFieldSpec,
  DistanceChargeFeatures,
  DistanceChargeSummaryRow,
  ScreenMeta,
  VehicleTypeOption,
} from "../models/distanceChargeModel";
import { OPEN_ENDED_RANGE } from "../models/distanceChargeModel";
import type { DistanceChargeAppScope } from "../models/distanceChargeModel";

/**
 * Business rules for Distance wise Delivery Charges (Delivery Genie → #sub-155).
 *
 * A row is one distance band of one vehicle type and the two amounts it pays the driver:
 * a completed delivery and a cancelled one. The legacy create accepted a band only if it
 * extended the chain the vehicle type already had — the first band starts at 0, every later
 * one starts where the widest ends, nothing may overlap — and its editor then froze both
 * the band and the vehicle type, leaving only the amounts editable. That is not tidiness:
 * the apps pick a band by distance alone, so a band moved after the fact re-prices orders
 * that were quoted under the old one, and a band nobody moved is the only reason a quoted
 * price can still be explained afterwards.
 *
 * Two of the legacy rules are kept as they are because they are load-bearing, and one is
 * corrected because it was wrong:
 *
 * - the chain is checked **per vehicle type** (`iVehicleTypeId`), and the "already added
 *   maximum distance range" refusal is real: an open-ended band closes the type;
 * - the amounts are the only thing an update writes, exactly as the legacy UPDATE listed;
 * - the legacy message "Distance Range From should be less than or equals to Distance
 *   Range To" fired when `to <= from`, so it described the opposite of its own test. The
 *   rule stays (a band needs a upper bound above its lower one); the wording is fixed.
 *
 * Deletes are hard, and the confirmation phrase is the row itself — `<vehicle type> <from>-<to>`
 * — because a row that is gone cannot be re-priced back and two bands of one type would
 * otherwise share a single word.
 */

/** The vehicle type a row belongs to, as the screens show it. */
export interface VehicleTypeDto {
  id: number;
  name: string;
  /** True when the stored id matches no `vehicle_type` row at all. */
  missing: boolean;
  /** `vehicle_type.eStatus`, or "" when the type is gone. */
  status: string;
  /** The type's own zone, or "All Locations" — the Localization column. */
  localizationLabel: string;
}

export interface BandDto {
  from: number;
  to: number;
  /** True when `to` is the open-ended sentinel. */
  open: boolean;
  label: string;
}

/** What the add form would have to start at, per vehicle type already carrying bands. */
export interface ChainHint {
  /** The `from` the next band of this type must use. */
  nextFrom: number;
  /** True when that value is the open-ended sentinel: no further band is possible. */
  closed: boolean;
}

export interface DistanceChargeDto {
  id: number;
  vehicleType: VehicleTypeDto;
  band: BandDto;
  /** Legacy column → stored value as text, so the form diffs without type surprises. */
  settings: Record<string, string>;
  /** The money and band columns this screen asks about. */
  fieldSpecs: DistanceChargeFieldSpec[];
  /** Whether the band and the vehicle type may be changed on this row. */
  scopeEditable: boolean;
  features: DistanceChargeFeatures;
  currency: { name: string; symbol: string };
  /** `DEFAULT_DISTANCE_UNIT`, for the band inputs' suffix. */
  distanceUnit: string;
  /** Vehicle types the dropdown may offer. */
  vehicleTypes: VehicleTypeOption[];
  /** Chain of every type on file, keyed by id — what the add form prefills from. */
  chains: Record<string, ChainHint>;
  /** What a delete of this row has to be confirmed with. */
  rowLabel: string;
}

/** What the caller may send; every key is optional except the amounts a create needs. */
export interface DistanceChargeInput {
  vehicleTypeId?: unknown;
  settings?: Record<string, unknown>;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || str(value).trim() === "";
}

/** Every column this screen asks about: the three amounts and the two band bounds. */
function visibleFields(): DistanceChargeFieldSpec[] {
  return [...model.DISTANCE_CHARGE_FIELDS, ...model.DISTANCE_BAND_FIELDS];
}

function bandLabel(from: number, to: number, unit: string): string {
  const high = to >= OPEN_ENDED_RANGE ? "∞" : `${to}`;
  return `${from} – ${high} ${unit}`;
}

/**
 * What the screens and the messages call a row. The wording lives in the model, so the
 * list column, the editor's frozen band and a delete confirmation cannot drift apart — the
 * last of those has to be typed back exactly, which is the one place a differently-worded
 * label would cost an admin their row for good.
 */
const rowLabel = model.rowLabelOf;

async function mustFind(id: number): Promise<model.DistanceChargeRow> {
  const row = await model.findBandRow(id);
  if (!row) throw AppError.notFound(`Distance-wise delivery charge #${id} not found.`);
  return row;
}

/** Every band on file, reduced to what the add form needs per vehicle type. */
async function readChains(): Promise<Record<string, ChainHint>> {
  const bands = await model.listAllBands();
  const perType: Record<string, { from: number; to: number }[]> = Object.create(null) as Record<
    string,
    { from: number; to: number }[]
  >;
  for (const band of bands) {
    const key = String(band.vehicleTypeId);
    (perType[key] ??= []).push({ from: band.from, to: band.to });
  }
  const out: Record<string, ChainHint> = Object.create(null) as Record<string, ChainHint>;
  for (const [key, list] of Object.entries(perType)) {
    const { startsAt, closed } = chainRules(list);
    out[key] = { nextFrom: startsAt, closed };
  }
  return out;
}

/**
 * Where the next band of a set has to start, and whether an open-ended one has already
 * closed it. Shared by the add form's prefill ({@link readChains}) and the create's own
 * check ({@link resolveBand}), so the hint can never promise a band the rules refuse.
 *
 * A chain that does not start at 0 — hand-edited data, or a first band deleted — is still
 * filled from 0, exactly as the legacy create demanded: a band above 0 while nothing covers
 * the short trips would leave a nearby order with no price at all, because the apps pick the
 * row whose range covers the distance and take the first one they get.
 */
function chainRules(bands: { from: number; to: number }[]): {
  startsAt: number;
  closed: boolean;
} {
  if (!bands.length) return { startsAt: 0, closed: false };
  const widest = Math.max(...bands.map((b) => b.to));
  const startsAtZero = bands.some((b) => b.from === 0);
  return { startsAt: startsAtZero ? widest : 0, closed: widest >= OPEN_ENDED_RANGE };
}

async function toDto(
  row: model.DistanceChargeRow | null,
  meta: ScreenMeta,
  chains: Record<string, ChainHint>,
): Promise<DistanceChargeDto> {
  const unit = meta.distanceUnit;
  const vehicleTypeId = row?.vehicleTypeId ?? 0;
  const name = row?.vehicleTypeName ?? "";
  const from = row?.distanceFrom ?? 0;
  // A band is only known once a row exists: an empty one would prefill the add form with
  // `0 – ∞`, which is both the open-ended marker and a lie about what the admin means to
  // price. The form starts from `chains` of the type it picks instead.
  const to = row?.distanceTo ?? 0;
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const spec of model.DISTANCE_CHARGE_FIELDS) {
    values[spec.column] = row ? row.values[spec.column] ?? "0" : spec.required ? "" : "0";
  }
  return {
    id: row?.id ?? 0,
    vehicleType: {
      id: vehicleTypeId,
      name,
      // A row whose type has vanished from `vehicle_type` still prices orders, so it is
      // shown with whatever the join managed to say about it rather than hidden.
      missing: row !== null && row.vehicleTypeStatus === "",
      status: row?.vehicleTypeStatus ?? "",
      // The add form reads the zone label off the option it selects, so it has none yet.
      localizationLabel: row
        ? model.localizationLabelOf(row.locationId, row.locationName)
        : "",
    },
    band: { from, to, open: to >= OPEN_ENDED_RANGE, label: row ? bandLabel(from, to, unit) : "" },
    settings: values,
    fieldSpecs: visibleFields(),
    // The legacy editor freezes the band and the type the moment the row exists.
    scopeEditable: row === null,
    features: meta.features,
    currency: meta.currency,
    distanceUnit: unit,
    vehicleTypes: meta.vehicleTypes,
    chains,
    // Nothing to confirm the delete of a row that does not exist.
    rowLabel: row ? rowLabel(name, vehicleTypeId, from, to) : "",
  };
}

/** Amount or distance: a finite number inside the spec's range, or a clear refusal. */
function cleanNumber(spec: DistanceChargeFieldSpec, value: unknown): number {
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
 * One accepted value of the settings map. Blank means "not set" and is stored as 0, which
 * is what the legacy screen's note told admins to do to deactivate a charge: a zero for
 * both completed and cancelled orders.
 */
function cleanSetting(spec: DistanceChargeFieldSpec, value: unknown): string | number {
  if (isBlank(value)) {
    if (spec.required) throw AppError.badRequest(`“${spec.label}” is required.`);
    return 0;
  }
  return cleanNumber(spec, value);
}

/** The band's upper bound: the ∞ the list shows, the checkbox's sentinel, or a number. */
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
 * `demandRequired` separates the two callers: a create has to arrive with both amounts and
 * both bounds, while a save carries only what changed. A blank is still refused on a
 * required column either way, because "blank" is a decision to clear it, not silence.
 */
function cleanSettings(
  input: Record<string, unknown> | undefined,
  demandRequired: boolean,
): Record<string, string | number> {
  const payload = input ?? {};
  const out: Record<string, string | number> = Object.create(null) as Record<string, string | number>;

  for (const [key, value] of Object.entries(payload)) {
    const spec = Object.prototype.hasOwnProperty.call(model.FIELD_BY_COLUMN, key)
      ? model.FIELD_BY_COLUMN[key]
      : undefined;
    if (!spec) throw AppError.badRequest(`Unknown distance-wise charge value “${key}”.`);
    if (spec.readOnly) {
      throw AppError.badRequest(
        `“${spec.label}” is stored, not editable: the legacy form writes 0 and never asks.`,
      );
    }
    out[key] = spec.column === "iDistanceRangeTo" ? cleanRangeEnd(value) : cleanSetting(spec, value);
  }

  if (!demandRequired) return out;
  for (const spec of visibleFields()) {
    if (spec.required && !Object.prototype.hasOwnProperty.call(out, spec.column)) {
      throw AppError.badRequest(`“${spec.label}” is required.`);
    }
  }
  return out;
}

/**
 * The band's own shape, then the chain it has to join. Only a create asks this: an edit
 * cannot move a band at all. The bands of the vehicle type are read fresh, so two admins
 * adding the next band cannot both be told they succeeded.
 */
async function resolveBand(
  settings: Record<string, string | number>,
  vehicleTypeId: number,
  unit: string,
): Promise<{ from: number; to: number }> {
  const from = Number(settings.iDistanceRangeFrom ?? NaN);
  const to = Number(settings.iDistanceRangeTo ?? NaN);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw AppError.badRequest("Distance range from and to are required.");
  }
  // A negative start never arrives here: the spec's own floor (0) is enforced while the
  // settings map is cleaned, and restating it would put a message no admin can trigger.
  if (to !== OPEN_ENDED_RANGE && to <= from) {
    throw AppError.badRequest("Distance range to must be greater than distance range from.");
  }

  const bands = await model.listBandsOfVehicleType(vehicleTypeId);
  const { startsAt, closed } = chainRules(bands);
  if (closed && from !== OPEN_ENDED_RANGE) {
    throw AppError.badRequest(
      `This vehicle type already has an open-ended band, so no further charge can be added.`,
    );
  }
  if (from !== startsAt) {
    if (!bands.length || startsAt === 0) {
      // Mirrors "Distance Range From should start from 0." — a band above 0 while nothing
      // covers the short trips would leave a near-order with no price at all.
      throw AppError.badRequest(`The first distance range of this vehicle type must start at 0 ${unit}.`);
    }
    throw AppError.badRequest(
      `Distance range from must be ${startsAt} ${unit}, where the widest existing band ends.`,
    );
  }
  for (const band of bands) {
    const high = band.to >= OPEN_ENDED_RANGE ? Number.POSITIVE_INFINITY : band.to;
    const mineHigh = to >= OPEN_ENDED_RANGE ? Number.POSITIVE_INFINITY : to;
    if (from < high && band.from < mineHigh) {
      throw AppError.badRequest(
        `A charge already covers ${bandLabel(band.from, band.to, unit)} for this vehicle type.`,
      );
    }
  }
  return { from, to };
}

/** Vehicle type id: a live type of this delivery line, or a clear refusal. */
async function cleanVehicleType(scope: DistanceChargeAppScope, value: unknown): Promise<number> {
  const text = str(value).trim();
  if (!text) throw AppError.badRequest("Select a vehicle type.");
  const id = Number(text);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("Vehicle type must be a whole number.");
  if (!(await model.isKnownVehicleType(scope.vehicleTypeEType, id))) {
    throw AppError.badRequest(`Vehicle type #${id} is not an active delivery vehicle type.`);
  }
  return id;
}

export async function createBand(
  scope: DistanceChargeAppScope,
  input: DistanceChargeInput,
): Promise<DistanceChargeDto> {
  const [meta, chains] = await Promise.all([model.readScreenMeta(scope), readChains()]);
  const settings = cleanSettings(input.settings, true);
  const vehicleTypeId = await cleanVehicleType(scope, input.vehicleTypeId);
  const band = await resolveBand(settings, vehicleTypeId, meta.distanceUnit);

  const id = await model.nextBandId();
  await model.insertBandRow(id, {
    vehicleTypeId,
    values: {
      iDistanceRangeFrom: band.from,
      iDistanceRangeTo: band.to,
      fDeliveryCharge: settings.fDeliveryCharge,
      fDeliveryChargeCancelled: settings.fDeliveryChargeCancelled,
      // The legacy form commented this input out and posted its default: 0. Anything else
      // would silently start adding money to what the customer pays.
      fDeliveryChargeUser: 0,
    },
  });
  return getRecord(scope, id);
}

export async function updateBand(
  scope: DistanceChargeAppScope,
  id: number,
  input: DistanceChargeInput,
): Promise<DistanceChargeDto> {
  const row = await mustFind(id);
  const settings = cleanSettings(input.settings, false);

  // The legacy editor disabled the band inputs and the vehicle-type select, and its UPDATE
  // listed only the three amounts: a row is nothing but a price change once it exists. That
  // is load-bearing — the apps pick a band by distance alone, so a band moved afterwards
  // re-prices orders that were quoted under the old one. A payload repeating the stored scope
  // verbatim (a form that submits all its fields) is therefore accepted and ignored, and the
  // type is compared without re-validating it: a row whose type has since been retired keeps
  // its price editable.
  const wantsType = isBlank(input.vehicleTypeId) ? row.vehicleTypeId : Number(str(input.vehicleTypeId).trim());
  if (wantsType !== row.vehicleTypeId) {
    throw AppError.badRequest(
      "A charge's vehicle type is fixed once it exists — delete the row and add it again.",
    );
  }
  const wantsFrom = settings.iDistanceRangeFrom;
  const wantsTo = settings.iDistanceRangeTo;
  if (
    (wantsFrom !== undefined && Number(wantsFrom) !== row.distanceFrom) ||
    (wantsTo !== undefined && Number(wantsTo) !== row.distanceTo)
  ) {
    throw AppError.badRequest(
      "A charge's distance band is fixed once it exists — delete the row and add it again.",
    );
  }

  const sets = Object.entries(settings)
    .filter(([column]) => column !== "iDistanceRangeFrom" && column !== "iDistanceRangeTo")
    .map(([column, value]) => ({ column, value }));
  if (!sets.length) throw AppError.badRequest("Send the amounts that changed.");
  await model.updateBandColumns(id, sets);
  return getRecord(scope, id);
}

/** One row plus everything the form needs around it. */
export async function getRecord(scope: DistanceChargeAppScope, id: number): Promise<DistanceChargeDto> {
  const [meta, chains, row] = await Promise.all([
    model.readScreenMeta(scope),
    readChains(),
    mustFind(id),
  ]);
  return toDto(row, meta, chains);
}

/** A blank row of the shape this screen would create, for the add form's defaults. */
export async function blankRecord(scope: DistanceChargeAppScope): Promise<DistanceChargeDto> {
  const [meta, chains] = await Promise.all([model.readScreenMeta(scope), readChains()]);
  return toDto(null, meta, chains);
}

export interface BandPage {
  rows: DistanceChargeSummaryRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  meta: ScreenMeta;
  chains: Record<string, ChainHint>;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function listFilters(raw: Record<string, unknown>): model.DistanceChargeListFilters {
  return {
    search: str(raw.search ?? raw.keyword ?? "").trim(),
    sort: str(raw.sort ?? ""),
    order: str(raw.order ?? "desc").toLowerCase() === "asc" ? "asc" : "desc",
  };
}

/**
 * One filtered page of the bands. The switch, the currency, the distance unit and the
 * vehicle types ride along, so the panel labels its columns from the same response that
 * fills them.
 */
export async function listBandsPaged(
  scope: DistanceChargeAppScope,
  raw: Record<string, unknown>,
): Promise<BandPage> {
  const filters = listFilters(raw);
  const limit = Math.min(Math.max(Number(raw.limit) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  let page = Math.max(Number(raw.page) || 1, 1);
  const [meta, chains] = await Promise.all([model.readScreenMeta(scope), readChains()]);

  const [total, rows] = await Promise.all([
    model.countBands(filters),
    model.listBandPage(filters, page, limit),
  ]);
  const pages = Math.max(Math.ceil(total / limit), 1);
  if (page > pages) {
    page = pages;
    return pageResult(await model.listBandPage(filters, page, limit), total, page, limit, pages, meta, chains);
  }
  return pageResult(rows, total, page, limit, pages, meta, chains);
}

function pageResult(
  rows: DistanceChargeSummaryRow[],
  total: number,
  page: number,
  limit: number,
  pages: number,
  meta: ScreenMeta,
  chains: Record<string, ChainHint>,
): BandPage {
  return { rows, total, page, limit, pages, meta, chains };
}

/** The un-paginated list, for a caller that asks for no filtering at all. */
export async function listBands(
  scope: DistanceChargeAppScope,
): Promise<{ rows: DistanceChargeSummaryRow[]; meta: ScreenMeta; chains: Record<string, ChainHint> }> {
  const [meta, chains, rows] = await Promise.all([
    model.readScreenMeta(scope),
    readChains(),
    model.listBandRows(),
  ]);
  return { rows, meta, chains };
}

/**
 * Hard delete, name-confirmed. There is no softer option: every app-side reader selects
 * these rows by distance without looking at `eStatus`, so an "inactive" band would go on
 * pricing orders while disappearing from this screen — which is why the legacy action ran a
 * `DELETE` and why the confirmation asks for the whole row, band included.
 */
export async function deleteBand(
  scope: DistanceChargeAppScope,
  id: number,
  confirm: unknown,
): Promise<{ id: number; label: string }> {
  const row = await mustFind(id);
  const label = rowLabel(row.vehicleTypeName, row.vehicleTypeId, row.distanceFrom, row.distanceTo);

  const wanted = typeof confirm === "string" ? confirm.trim() : "";
  if (!wanted) throw AppError.badRequest(`Type “${label}” to confirm the delete.`);
  if (wanted !== label) {
    throw AppError.badRequest(`Confirmation does not match: this charge is “${label}”.`);
  }

  await model.deleteBandRow(id);
  return { id, label };
}
