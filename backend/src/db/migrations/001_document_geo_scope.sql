-- Geographic scoping for the document catalog (Settings → Documents).
--
-- Additive-only strategy: the legacy `document_master` table is NOT altered.
-- Instead a new InnoDB side-table links a document type to one or more
-- geographic scopes (country / state / city). Foreign-key integrity is
-- enforced at the application layer (see documentsService), matching the
-- existing `provider_service` precedent.
--
-- Sentinel semantics: 0 means "all / not narrowed" at that level, so a row of
-- (countryId=5, stateId=0, cityId=0) means "everywhere in country 5", and
-- (5, 12, 34) means "city 34 of state 12 of country 5". A document with no
-- rows applies to all geographies. The composite PK prevents duplicate scopes.
CREATE TABLE IF NOT EXISTS `document_geo_scope` (
  `doc_masterid` INT NOT NULL,
  `iCountryId`   INT NOT NULL DEFAULT 0,
  `iStateId`     INT NOT NULL DEFAULT 0,
  `iCityId`      INT NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`doc_masterid`, `iCountryId`, `iStateId`, `iCityId`),
  KEY `idx_country` (`iCountryId`),
  KEY `idx_state` (`iStateId`),
  KEY `idx_city` (`iCityId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
