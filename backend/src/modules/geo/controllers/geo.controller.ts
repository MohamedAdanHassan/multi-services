import type { Request, Response } from "express";
import * as geo from "../models/geoModel";
import { createTtlCache } from "../../../utils/ttlCache";

/**
 * Reference-data endpoints for the country → state → city hierarchy. These are
 * intentionally generic (not document-specific) so any feature that needs
 * geographic pickers can reuse them. Gated by auth only.
 *
 * The lists are pure reference data (this module never writes) and can run
 * into thousands of rows, so each level is cached for a minute; geo edits
 * made elsewhere surface within the TTL.
 */
const listCache = createTtlCache<readonly unknown[]>(60_000, 256);

export async function countries(_req: Request, res: Response) {
  const countries = await listCache.load("countries", () => geo.listCountries());
  res.json({ countries });
}

export async function states(req: Request, res: Response) {
  const countryId = Number(req.query.countryId ?? 0);
  const states = await listCache.load(`states:${countryId}`, () => geo.listStates(countryId));
  res.json({ states });
}

export async function cities(req: Request, res: Response) {
  const stateId = Number(req.query.stateId ?? 0);
  const cities = await listCache.load(`cities:${stateId}`, () => geo.listCities(stateId));
  res.json({ cities });
}
