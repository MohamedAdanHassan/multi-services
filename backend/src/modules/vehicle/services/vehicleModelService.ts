import { AppError } from "../../../errors/AppError";
import { createTtlCache } from "../../../utils/ttlCache";
import * as makes from "../models/vehicleMakeModel";
import * as models from "../models/vehicleModelModel";
import type { ModelListFilters, ModelStatus, VehicleModelRow } from "../models/vehicleModelModel";

/**
 * Business rules for vehicle models (`model` table). Titles are trimmed,
 * required and capped at the column width (100); the parent make must exist
 * and not be soft-deleted. Lists come back paginated — the catalog holds
 * ~10k rows — and deletes are guarded against live `driver_vehicle` use.
 */

const MAX_TITLE_LEN = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function cleanTitle(value: unknown): string {
  const title = String(value ?? "").trim();
  if (!title) throw AppError.badRequest("Model title is required.");
  if (title.length > MAX_TITLE_LEN) {
    throw AppError.badRequest(`Model title must be at most ${MAX_TITLE_LEN} characters.`);
  }
  return title;
}

async function requireMake(makeId: number): Promise<void> {
  if (!Number.isInteger(makeId) || makeId <= 0) {
    throw AppError.badRequest("A valid make must be selected.");
  }
  const make = await makes.findMake(makeId);
  if (!make) throw AppError.badRequest(`Make #${makeId} not found.`);
}

async function mustFind(id: number): Promise<VehicleModelRow> {
  const row = await models.findModel(id);
  if (!row) throw AppError.notFound(`Model #${id} not found.`);
  return row;
}

export interface ModelPage {
  rows: VehicleModelRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** The ~10k-row catalog is a picker, not a live board: 60s per filter page. */
const pageCache = createTtlCache<ModelPage>(60_000, 128);

/** One filtered page of models; out-of-range pages clamp to the last page. */
export async function listModels(raw: {
  search?: unknown;
  makeId?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<ModelPage> {
  const search = String(raw.search ?? "").trim();
  const makeId = Number(raw.makeId ?? 0);
  const limit = Math.min(Math.max(Number(raw.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let page = Math.max(Number(raw.page) || 1, 1);

  return pageCache.load(`${search}|${makeId}|${page}|${limit}`, async () => {
    const total = await models.countModels({ search, makeId: makeId > 0 ? makeId : undefined, page, limit });
    const pages = Math.max(Math.ceil(total / limit), 1);
    if (page > pages) page = pages;

    const filters: ModelListFilters = { search, makeId: makeId > 0 ? makeId : undefined, page, limit };
    const rows = await models.listModels(filters);
    return { rows, total, page, limit, pages };
  });
}

export async function getModel(id: number): Promise<VehicleModelRow> {
  return mustFind(id);
}

export async function createModel(input: {
  makeId: unknown;
  title: unknown;
  status?: ModelStatus;
}): Promise<VehicleModelRow> {
  const title = cleanTitle(input.title);
  const makeId = Number(input.makeId);
  await requireMake(makeId);
  const status: ModelStatus = input.status === "Inactive" ? "Inactive" : "Active";
  const id = await models.nextModelId();
  await models.createModel(id, makeId, title, status);
  const row = await models.findModel(id);
  if (!row) throw AppError.notFound("Model was created but could not be re-read.");
  pageCache.clear();
  return row;
}

export async function updateModel(
  id: number,
  input: { makeId: unknown; title: unknown },
): Promise<VehicleModelRow> {
  await mustFind(id);
  const title = cleanTitle(input.title);
  const makeId = Number(input.makeId);
  await requireMake(makeId);
  await models.updateModel(id, makeId, title);
  pageCache.clear();
  return mustFind(id);
}

export async function changeStatus(
  id: number,
  status: ModelStatus,
): Promise<VehicleModelRow> {
  const row = await mustFind(id);
  if (row.status !== status) await models.setModelStatus(id, status);
  pageCache.clear();
  return mustFind(id);
}

/** Soft delete, guarded: vehicles keep pointing at model ids. */
export async function deleteModel(id: number): Promise<void> {
  const row = await mustFind(id);
  const vehicles = await models.countVehiclesUsingModel(id);
  if (vehicles > 0) {
    throw AppError.badRequest(
      `Model “${row.title}” is used by ${vehicles} registered vehicle(s) and cannot be deleted.`,
    );
  }
  await models.softDeleteModel(id);
  pageCache.clear();
}
