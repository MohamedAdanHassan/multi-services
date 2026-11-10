import { query } from "../../../db/mysql";

/** A generic `{id, name}` reference row (countries, cities). */
export interface GeoOption {
  id: number;
  name: string;
}

/** A state reference row additionally carries its short code. */
export interface StateOption extends GeoOption {
  code: string;
}

/**
 * A country reference row. Legacy rows store the ISO-2 `code` in
 * `company.vCountry` / `register_driver.vCountry`, and `phoneCode` feeds the
 * dial-code box that auto-fills `vCode` on the rider/driver forms.
 */
export interface CountryOption extends GeoOption {
  code: string;
  phoneCode: string;
}

/** Active countries, alphabetically. */
export async function listCountries(): Promise<CountryOption[]> {
  return query<CountryOption>(
    `SELECT iCountryId AS id, vCountry AS name, vCountryCode AS code, vPhoneCode AS phoneCode
       FROM country
      WHERE eStatus = 'Active'
      ORDER BY vCountry`,
  );
}

/** Active states within a country (empty for an "All countries" selection). */
export async function listStates(countryId: number): Promise<StateOption[]> {
  if (!countryId) return [];
  return query<StateOption>(
    `SELECT iStateId AS id, vState AS name, vStateCode AS code
       FROM state
      WHERE eStatus = 'Active' AND iCountryId = ?
      ORDER BY vState`,
    [countryId],
  );
}

/** Active cities within a state (empty for an "All states" selection). */
export async function listCities(stateId: number): Promise<GeoOption[]> {
  if (!stateId) return [];
  return query<GeoOption>(
    `SELECT iCityId AS id, vCity AS name
       FROM city
      WHERE eStatus = 'Active' AND iStateId = ?
      ORDER BY vCity`,
    [stateId],
  );
}

// ---------------------------------------------------------------------------
// Hierarchy integrity checks (foreign keys are enforced at the app layer).
// ---------------------------------------------------------------------------

/** True when `id` is an active country. */
export async function countryExists(id: number): Promise<boolean> {
  if (!id) return false;
  const rows = await query<{ hit: number }>(
    "SELECT 1 AS hit FROM country WHERE iCountryId = ? AND eStatus = 'Active' LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

/** True when `stateId` is an active state belonging to `countryId`. */
export async function stateBelongsToCountry(stateId: number, countryId: number): Promise<boolean> {
  if (!stateId) return false;
  const rows = await query<{ hit: number }>(
    `SELECT 1 AS hit FROM state
      WHERE iStateId = ? AND iCountryId = ? AND eStatus = 'Active' LIMIT 1`,
    [stateId, countryId],
  );
  return rows.length > 0;
}

/** True when `cityId` is an active city belonging to `stateId`. */
export async function cityBelongsToState(cityId: number, stateId: number): Promise<boolean> {
  if (!cityId) return false;
  const rows = await query<{ hit: number }>(
    `SELECT 1 AS hit FROM city
      WHERE iCityId = ? AND iStateId = ? AND eStatus = 'Active' LIMIT 1`,
    [cityId, stateId],
  );
  return rows.length > 0;
}
