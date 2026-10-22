/**
 * H3 screening schema — PostGIS.
 *
 * G3: DDL is granted by H3's fence (task 3.1, "PostGIS"). Every statement is
 * idempotent (IF NOT EXISTS) so running it twice is a no-op, like
 * ensure-chat-tables.ts. Nothing here alters or drops an existing table.
 *
 * Tables are prefixed h3_ so they cannot collide with the calculator's
 * `calculations`, `conversations` and `messages`.
 *
 * Coordinates are stored in the CRS the Catastro publishes (ETRS89 / UTM 30N,
 * EPSG:25830, for Córdoba). Lengths and azimuths are computed in that CRS;
 * UTM is conformal, so a façade's bearing is preserved to within the grid
 * convergence (≈1.1° at Córdoba city: (λ − λ₀)·sin φ with λ₀ = −3°; recorded in the methodology, not corrected).
 */

export const H3_SCHEMA_SQL: readonly string[] = [
  `CREATE EXTENSION IF NOT EXISTS postgis`,

  // One row per downloaded file. Every building row points at the file it was
  // read from, so a score can always be traced back to a dated, hashed source.
  `CREATE TABLE IF NOT EXISTS h3_sources (
     id            text PRIMARY KEY,
     publisher     text NOT NULL,
     dataset       text NOT NULL,
     url           text NOT NULL,
     last_modified timestamptz,          -- NULL when the publisher sends none (WCS)
     sha256        text NOT NULL,
     retrieved_at  timestamptz NOT NULL,
     licence       text NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS h3_municipalities (
     ine       text PRIMARY KEY,
     name      text NOT NULL,
     province  text NOT NULL,
     catastro  text NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS h3_buildings (
     ref                  text PRIMARY KEY,
     ine_municipality     text NOT NULL,
     catastro_municipality text NOT NULL,
     source_id            text NOT NULL REFERENCES h3_sources(id),
     footprint            geometry(MultiPolygon, 25830) NOT NULL,
     condition            text,
     year_beginning       integer,
     year_end             integer,
     current_use          text,
     building_units       integer,
     dwellings            integer,
     gross_floor_area_m2  numeric,
     part_count           integer NOT NULL,
     floors_above_max     integer,
     ingested_at          timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS h3_buildings_footprint_gix ON h3_buildings USING gist (footprint)`,
  `CREATE INDEX IF NOT EXISTS h3_buildings_ine_idx ON h3_buildings (ine_municipality)`,

  // 3.2 output: façade length per CTE orientation, exposed vs party wall.
  // Inferred from geometry, never sourced — the column name says so.
  `CREATE TABLE IF NOT EXISTS h3_facades_inferred (
     ref            text PRIMARY KEY REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     method         text NOT NULL,
     tolerance_m    numeric NOT NULL,
     perimeter_m    numeric NOT NULL,
     party_wall_m   numeric NOT NULL,
     exposed_m      jsonb NOT NULL,
     computed_at    timestamptz NOT NULL DEFAULT now()
   )`,

  // 3.3 + 3.4: altitude, CTE zone, and July irradiation on the exposed façades.
  `CREATE TABLE IF NOT EXISTS h3_building_climate (
     ref                        text PRIMARY KEY REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     dem_source_id              text NOT NULL REFERENCES h3_sources(id),
     altitude_m                 numeric NOT NULL,
     altitude_basis             text NOT NULL,
     province                   text NOT NULL,
     zone                       text NOT NULL,
     summer                     integer NOT NULL,
     july_street_kwh_per_m      numeric NOT NULL,
     july_street_mean_kwh_m2    numeric,
     july_courtyard_kwh_per_m   numeric NOT NULL,
     july_roof_kwh_m2           numeric NOT NULL,
     irradiation_source         text NOT NULL,
     computed_at                timestamptz NOT NULL DEFAULT now()
   )`,

  // 3.5: INE census sections (boundaries 1 Jan 2021) with the Censo 2021
  // indicators exactly as published, keyed by INE's own codes.
  `CREATE TABLE IF NOT EXISTS h3_census_sections (
     cusec                 text PRIMARY KEY,
     ine_municipality      text NOT NULL,
     boundary              geometry(MultiPolygon, 25830) NOT NULL,
     boundary_source_id    text NOT NULL REFERENCES h3_sources(id),
     indicators            jsonb,
     indicators_source_id  text REFERENCES h3_sources(id)
   )`,
  `CREATE INDEX IF NOT EXISTS h3_census_sections_boundary_gix ON h3_census_sections USING gist (boundary)`,

  `CREATE TABLE IF NOT EXISTS h3_building_section (
     ref      text PRIMARY KEY REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     cusec    text NOT NULL REFERENCES h3_census_sections(cusec),
     method   text NOT NULL,
     ties     integer NOT NULL
   )`,

  // 3.6 (A26): certificates from the Junta's register that name a building of
  // the municipality, keyed by their position in the source file; and each
  // building's summary. No address column, by design.
  `CREATE TABLE IF NOT EXISTS h3_epc_certificates (
     source_id       text NOT NULL REFERENCES h3_sources(id),
     ordinal         integer NOT NULL,
     ref             text NOT NULL REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     unit_ref        text,
     ref_form        text NOT NULL,
     cert_date       date,
     date_valid      boolean NOT NULL,
     building_type   text,
     scope           text,
     procedure       text,
     cooling_demand  numeric,
     cooling_letter  text,
     cooling_scale   jsonb,
     PRIMARY KEY (source_id, ordinal)
   )`,
  `CREATE INDEX IF NOT EXISTS h3_epc_certificates_ref_idx ON h3_epc_certificates (ref)`,
  `CREATE TABLE IF NOT EXISTS h3_building_epc (
     ref                     text PRIMARY KEY REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     source_id               text NOT NULL REFERENCES h3_sources(id),
     certificates            integer NOT NULL,
     entries                 integer NOT NULL,
     units_certified         integer NOT NULL,
     entries_invalid_date    integer NOT NULL,
     cooling_demand_median   numeric,
     cooling_demand_min      numeric,
     cooling_demand_max      numeric,
     letters                 jsonb NOT NULL,
     latest_date             date
   )`,

  // 3.7 + 3.8: one row per index run (method and references, so a score can be
  // recomputed by hand), and one row per scored building with its band.
  `CREATE TABLE IF NOT EXISTS h3_index_runs (
     id               text PRIMARY KEY,
     ine_municipality text NOT NULL,
     method           jsonb NOT NULL,
     refs             jsonb NOT NULL,
     scored           integer NOT NULL,
     not_scored       jsonb NOT NULL,
     computed_at      timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS h3_index (
     ref           text PRIMARY KEY REFERENCES h3_buildings(ref) ON DELETE CASCADE,
     run_id        text NOT NULL REFERENCES h3_index_runs(id),
     index_low     numeric NOT NULL,
     index_mid     numeric NOT NULL,
     index_high    numeric NOT NULL,
     rank_high     integer NOT NULL,
     factors       jsonb NOT NULL,
     completeness  jsonb NOT NULL,
     CHECK (index_low <= index_mid AND index_mid <= index_high)
   )`,
  `CREATE INDEX IF NOT EXISTS h3_index_rank_idx ON h3_index (run_id, rank_high)`,
];
