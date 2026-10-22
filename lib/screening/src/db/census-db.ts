/**
 * H3.5 in the database: census-section boundaries + Censo 2021 indicators,
 * and each building's section.
 */
import type { Client, Pool, PoolClient } from "pg";
import type { SectionIndicators } from "../census/indicators";
import type { ShapeRecord } from "../census/shapefile";

type Db = Pool | PoolClient | Client;

export const SECTION_METHOD = "point-on-surface-intersects";

export interface CensusLoadStats {
  readonly sections: number;
  readonly withIndicators: number;
  /** Section boundaries the indicator file has no row for. */
  readonly boundariesWithoutIndicators: readonly string[];
  /** Indicator rows with no boundary in the shapefile. */
  readonly indicatorsWithoutBoundary: readonly string[];
}

const ringsWkt = (rings: ShapeRecord["rings"]) =>
  `MULTILINESTRING(${rings.map((r) => `(${r.map(([x, y]) => `${x} ${y}`).join(",")})`).join(",")})`;

export async function loadCensusSections(
  db: Db,
  ineMunicipality: string,
  shapes: readonly ShapeRecord[],
  indicators: readonly SectionIndicators[],
  boundarySourceId: string,
  indicatorsSourceId: string,
): Promise<CensusLoadStats> {
  const byCusec = new Map(indicators.map((s) => [s.cusec, s]));
  const seen = new Set<string>();
  for (const shape of shapes) {
    const cusec = shape.attributes.CUSEC;
    if (!/^\d{10}$/.test(cusec ?? "")) throw new Error(`shape without a 10-digit CUSEC: ${JSON.stringify(shape.attributes)}`);
    if (shape.attributes.CUMUN !== ineMunicipality) {
      throw new Error(`section ${cusec} belongs to ${shape.attributes.CUMUN}, not ${ineMunicipality}`);
    }
    if (seen.has(cusec)) throw new Error(`section ${cusec} appears twice in the shapefile`);
    seen.add(cusec);
    const ind = byCusec.get(cusec);
    // ST_BuildArea decides holes from the linework, not from winding order.
    await db.query(
      `INSERT INTO h3_census_sections (cusec, ine_municipality, boundary, boundary_source_id, indicators, indicators_source_id)
       VALUES ($1, $2, ST_Multi(ST_BuildArea(ST_GeomFromText($3, 25830))), $4, $5::jsonb, $6)
       ON CONFLICT (cusec) DO UPDATE SET ine_municipality = EXCLUDED.ine_municipality,
         boundary = EXCLUDED.boundary, boundary_source_id = EXCLUDED.boundary_source_id,
         indicators = EXCLUDED.indicators, indicators_source_id = EXCLUDED.indicators_source_id`,
      [cusec, ineMunicipality, ringsWkt(shape.rings), boundarySourceId,
       ind ? JSON.stringify(ind.values) : null, ind ? indicatorsSourceId : null],
    );
  }
  const invalid = await db.query<{ cusec: string }>(
    `SELECT cusec FROM h3_census_sections WHERE ine_municipality = $1 AND (boundary IS NULL OR ST_IsEmpty(boundary) OR NOT ST_IsValid(boundary))`,
    [ineMunicipality],
  );
  if (invalid.rows.length > 0) {
    throw new Error(`invalid section boundaries: ${invalid.rows.map((r) => r.cusec).join(", ")}`);
  }
  return {
    sections: seen.size,
    withIndicators: [...seen].filter((c) => byCusec.has(c)).length,
    boundariesWithoutIndicators: [...seen].filter((c) => !byCusec.has(c)).sort(),
    indicatorsWithoutBoundary: [...byCusec.keys()].filter((c) => !seen.has(c)).sort(),
  };
}

export interface SectionAssignStats {
  readonly assigned: number;
  readonly unassigned: readonly string[];
  /** Buildings whose point lies on a boundary shared by two sections. */
  readonly ties: number;
}

/**
 * Each building goes to the section containing its point-on-surface. A point
 * exactly on a shared boundary touches two sections; the lower CUSEC is taken
 * and the tie is counted, not hidden.
 */
export async function assignBuildingsToSections(db: Db, ineMunicipality: string): Promise<SectionAssignStats> {
  await db.query(
    `INSERT INTO h3_building_section (ref, cusec, method, ties)
     SELECT ref, cusec, $2, n - 1 FROM (
       SELECT DISTINCT ON (b.ref) b.ref, s.cusec, count(*) OVER (PARTITION BY b.ref) AS n
         FROM (SELECT ref, ST_PointOnSurface(footprint) AS p FROM h3_buildings WHERE ine_municipality = $1) b
         JOIN h3_census_sections s ON s.ine_municipality = $1 AND ST_Intersects(s.boundary, b.p)
        ORDER BY b.ref, s.cusec
     ) x
     ON CONFLICT (ref) DO UPDATE SET cusec = EXCLUDED.cusec, method = EXCLUDED.method, ties = EXCLUDED.ties`,
    [ineMunicipality, SECTION_METHOD],
  );
  const un = await db.query<{ ref: string }>(
    `SELECT b.ref FROM h3_buildings b LEFT JOIN h3_building_section s USING (ref)
      WHERE b.ine_municipality = $1 AND s.ref IS NULL ORDER BY b.ref`,
    [ineMunicipality],
  );
  const counts = await db.query<{ assigned: string; ties: string }>(
    `SELECT count(*)::text AS assigned, count(*) FILTER (WHERE ties > 0)::text AS ties
       FROM h3_building_section s JOIN h3_buildings b USING (ref) WHERE b.ine_municipality = $1`,
    [ineMunicipality],
  );
  return {
    assigned: Number(counts.rows[0].assigned),
    unassigned: un.rows.map((r) => r.ref),
    ties: Number(counts.rows[0].ties),
  };
}
