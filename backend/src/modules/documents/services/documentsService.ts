import { withTransaction } from "../../../db/mysql";
import { AppError } from "../../../errors/AppError";
import * as doc from "../models/documentsModel";
import * as geoScope from "../models/documentGeoModel";
import * as geo from "../../geo/models/geoModel";
import type { DocumentInput } from "../models/documentsModel";
import type { GeoScope } from "../models/documentGeoModel";

/**
 * Business-logic layer for the document catalog. Owns the multi-step, atomic
 * operations that the controller should not perform inline — notably saving a
 * document together with its geographic scopes inside a single transaction,
 * and validating the country → state → city hierarchy before persisting.
 */

/**
 * Validate each scope's hierarchy integrity and internal consistency:
 *  - a city requires a state, a state requires a country (no gaps);
 *  - every referenced id must exist and be Active, and nest correctly.
 * Returns the scopes normalised (trailing "all" levels collapsed to 0).
 */
export async function validateScopes(scopes: GeoScope[]): Promise<GeoScope[]> {
  const out: GeoScope[] = [];
  for (const [i, s] of scopes.entries()) {
    const countryId = Number(s.countryId) || 0;
    const stateId = Number(s.stateId) || 0;
    const cityId = Number(s.cityId) || 0;
    const at = `Geography #${i + 1}`;

    if (cityId && !stateId) throw AppError.badRequest(`${at}: select a state before a city`);
    if (stateId && !countryId) throw AppError.badRequest(`${at}: select a country before a state`);

    if (countryId && !(await geo.countryExists(countryId))) {
      throw AppError.badRequest(`${at}: unknown or inactive country`);
    }
    if (stateId && !(await geo.stateBelongsToCountry(stateId, countryId))) {
      throw AppError.badRequest(`${at}: state does not belong to the selected country`);
    }
    if (cityId && !(await geo.cityBelongsToState(cityId, stateId))) {
      throw AppError.badRequest(`${at}: city does not belong to the selected state`);
    }
    out.push({ countryId, stateId, cityId });
  }
  return out;
}

/**
 * Derive the legacy single-value `document_master.country` from the richer
 * scope set, so the unchanged PHP app keeps working: the shared country id when
 * every scope agrees, otherwise 'All'.
 */
export function deriveLegacyCountry(scopes: GeoScope[]): string {
  if (!scopes.length) return "All";
  const countries = new Set(scopes.map((s) => s.countryId));
  if (countries.has(0) || countries.size !== 1) return "All";
  return String([...countries][0]);
}

/** Create a document and its scopes atomically. Returns the new master id. */
export async function createDocument(
  input: DocumentInput,
  scopes: GeoScope[],
): Promise<number> {
  const clean = await validateScopes(scopes);
  const base = { ...input, country: deriveLegacyCountry(clean) };
  return withTransaction(async (conn) => {
    const id = await doc.createDocument(base, conn);
    await geoScope.replaceForDocument(id, clean, conn);
    return id;
  });
}

/** Replace a document's fields and scopes atomically. */
export async function updateDocument(
  id: number,
  input: DocumentInput,
  scopes: GeoScope[],
): Promise<void> {
  const clean = await validateScopes(scopes);
  const base = { ...input, country: deriveLegacyCountry(clean) };
  await withTransaction(async (conn) => {
    await doc.updateDocument(id, base, conn);
    await geoScope.replaceForDocument(id, clean, conn);
  });
}
