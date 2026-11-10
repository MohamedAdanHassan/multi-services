import { execute, query } from "../../../db/mysql";
import type { PoolConnection } from "mysql2/promise";

/** A geographic scope as persisted / exchanged: 0 = "all" at that level. */
export interface GeoScope {
  countryId: number;
  stateId: number;
  cityId: number;
}

/** A stored scope enriched with human-readable names for display. */
export interface GeoScopeDetail extends GeoScope {
  countryName: string;
  stateName: string;
  cityName: string;
}

/**
 * Repository for the `document_geo_scope` additive link table. Every write
 * accepts an optional pooled connection so callers can compose it into a
 * larger transaction (see documentsService). FK integrity is guaranteed by the
 * service layer before these methods run.
 */
export async function replaceForDocument(
  docMasterId: number,
  scopes: GeoScope[],
  conn?: PoolConnection,
): Promise<void> {
  const run = async (sql: string, params: unknown[]) => {
    if (conn) await conn.query(sql, params);
    else await execute(sql, params);
  };

  await run("DELETE FROM document_geo_scope WHERE doc_masterid = ?", [docMasterId]);
  if (!scopes.length) return;

  // De-duplicate identical scopes so the composite PK is never violated.
  const unique = [
    ...new Map(
      scopes.map((s) => [`${s.countryId}:${s.stateId}:${s.cityId}`, s]),
    ).values(),
  ];
  for (const s of unique) {
    await run(
      `INSERT INTO document_geo_scope (doc_masterid, iCountryId, iStateId, iCityId)
       VALUES (?, ?, ?, ?)`,
      [docMasterId, s.countryId, s.stateId, s.cityId],
    );
  }
}

/** All scopes of one document, with country/state/city names resolved. */
export async function listForDocument(docMasterId: number): Promise<GeoScopeDetail[]> {
  return query<GeoScopeDetail>(SCOPE_SELECT + " WHERE s.doc_masterid = ? ORDER BY s.iCountryId, s.iStateId, s.iCityId", [
    docMasterId,
  ]);
}

const SCOPE_SELECT = `
  SELECT s.iCountryId AS countryId,
         s.iStateId   AS stateId,
         s.iCityId    AS cityId,
         IFNULL(c.vCountry, '') AS countryName,
         IFNULL(st.vState, '')  AS stateName,
         IFNULL(ci.vCity, '')   AS cityName
    FROM document_geo_scope s
    LEFT JOIN country c  ON c.iCountryId  = s.iCountryId
    LEFT JOIN state  st  ON st.iStateId   = s.iStateId
    LEFT JOIN city   ci  ON ci.iCityId    = s.iCityId`;
