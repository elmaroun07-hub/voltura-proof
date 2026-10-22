/**
 * H3.9 — the portfolio view's reads: the ranked list with filters, one
 * building's full trace, the aggregate, and the export rows.
 *
 * Everything reads the municipality's LATEST index run. A municipality with no
 * run (or a database without the h3_ tables) raises ScreeningNotLoaded, which
 * the API turns into a typed 404 — never an empty list that reads as "no
 * building at risk".
 */
import type { Client, Pool, PoolClient } from "pg";

type Db = Pool | PoolClient | Client;

export class ScreeningNotLoaded extends Error {
  override name = "ScreeningNotLoaded";
  constructor(readonly ineMunicipality: string) {
    super(`no screening run loaded for municipality ${ineMunicipality}`);
  }
}

export const AGE_FILTERS = ["pre-1980", "1980-2006", "2007-on", "unknown"] as const;
export type AgeFilter = (typeof AGE_FILTERS)[number];

export interface ListFilters {
  readonly age?: AgeFilter;
  readonly certificate?: "with" | "without";
  /** Census district, the two digits after the municipality in the CUSEC. */
  readonly district?: string;
}

export interface BandValue {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface PortfolioRow {
  readonly rank: number;
  readonly ref: string;
  readonly dwellings: number;
  readonly year: number | null;
  readonly floors: number | null;
  readonly zone: string;
  readonly cusec: string | null;
  readonly index: BandValue;
  readonly certificateCoverage: number;
  readonly certificateCapped: boolean;
  readonly censusSection: boolean;
}

export interface Municipality {
  readonly ine: string;
  readonly name: string;
  readonly province: string;
  readonly runId: string;
  readonly method: string;
  readonly computedAt: string;
  readonly scored: number;
}

const UNDEFINED_TABLE = "42P01";

async function guarded<T>(ine: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) throw new ScreeningNotLoaded(ine);
    throw err;
  }
}

/** Municipalities with at least one index run, newest run each. */
export async function listMunicipalities(db: Db): Promise<Municipality[]> {
  try {
    const r = await db.query(
      `SELECT DISTINCT ON (m.ine) m.ine, m.name, m.province, r.id AS run_id, r.method->>'version' AS method,
              r.computed_at, r.scored
         FROM h3_municipalities m JOIN h3_index_runs r ON r.ine_municipality = m.ine
        ORDER BY m.ine, r.computed_at DESC`,
    );
    return r.rows.map((x) => ({
      ine: x.ine, name: x.name, province: x.province, runId: x.run_id, method: x.method,
      computedAt: new Date(x.computed_at).toISOString(), scored: x.scored,
    }));
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

async function latestRun(db: Db, ine: string): Promise<{ id: string; scored: number }> {
  const r = await db.query(
    `SELECT id, scored FROM h3_index_runs WHERE ine_municipality = $1 ORDER BY computed_at DESC LIMIT 1`,
    [ine],
  );
  if (r.rows.length === 0) throw new ScreeningNotLoaded(ine);
  return { id: r.rows[0].id, scored: r.rows[0].scored };
}

function filterSql(f: ListFilters, params: unknown[]): string {
  const where: string[] = [];
  if (f.age) {
    if (f.age === "unknown") where.push("b.year_end IS NULL");
    else if (f.age === "pre-1980") where.push("b.year_end < 1980");
    else if (f.age === "1980-2006") where.push("b.year_end >= 1980 AND b.year_end < 2007");
    else where.push("b.year_end >= 2007");
  }
  if (f.certificate === "with") where.push("(i.completeness->>'certificateCoverage')::numeric > 0");
  if (f.certificate === "without") where.push("(i.completeness->>'certificateCoverage')::numeric = 0");
  if (f.district) {
    params.push(f.district);
    where.push(`substr(s.cusec, 6, 2) = $${params.length}`);
  }
  return where.length ? `AND ${where.join(" AND ")}` : "";
}

const ROW_SELECT = `
SELECT i.rank_high, i.ref, b.dwellings, b.year_end, b.floors_above_max, c.zone, s.cusec,
       i.index_low, i.index_mid, i.index_high, i.completeness
  FROM h3_index i
  JOIN h3_buildings b USING (ref)
  JOIN h3_building_climate c USING (ref)
  LEFT JOIN h3_building_section s USING (ref)
 WHERE i.run_id = $1`;

function toRow(x: Record<string, unknown>): PortfolioRow {
  const c = x.completeness as { certificateCoverage: number; certificateCapped: boolean; censusSection: boolean };
  return {
    rank: Number(x.rank_high),
    ref: String(x.ref),
    dwellings: Number(x.dwellings),
    year: x.year_end === null ? null : Number(x.year_end),
    floors: x.floors_above_max === null ? null : Number(x.floors_above_max),
    zone: String(x.zone),
    cusec: x.cusec === null ? null : String(x.cusec),
    index: { low: Number(x.index_low), mid: Number(x.index_mid), high: Number(x.index_high) },
    certificateCoverage: c.certificateCoverage,
    certificateCapped: c.certificateCapped,
    censusSection: c.censusSection,
  };
}

export async function listBuildings(
  db: Db,
  ine: string,
  filters: ListFilters,
  page: { limit: number; offset: number },
): Promise<{ runId: string; total: number; rows: PortfolioRow[] }> {
  return guarded(ine, async () => {
    const run = await latestRun(db, ine);
    const params: unknown[] = [run.id];
    const where = filterSql(filters, params);
    const total = await db.query(`SELECT count(*)::int AS n FROM (${ROW_SELECT} ${where}) x`, params);
    params.push(page.limit, page.offset);
    const r = await db.query(
      `${ROW_SELECT} ${where} ORDER BY i.rank_high LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { runId: run.id, total: total.rows[0].n, rows: r.rows.map(toRow) };
  });
}

/** Every input behind one building's score, with the sources it was read from. */
export async function buildingTrace(db: Db, ine: string, ref: string) {
  return guarded(ine, async () => {
    const run = await latestRun(db, ine);
    const r = await db.query(
      `SELECT b.ref, b.dwellings, b.building_units, b.year_beginning, b.year_end, b.floors_above_max,
              b.current_use, b.condition, b.gross_floor_area_m2, ST_Area(b.footprint) AS footprint_m2,
              b.source_id AS catastro_source,
              f.perimeter_m, f.party_wall_m, f.exposed_m, f.method AS facade_method, f.tolerance_m,
              c.altitude_m, c.altitude_basis, c.zone, c.july_street_kwh_per_m, c.july_roof_kwh_m2,
              c.irradiation_source, c.dem_source_id,
              s.cusec, cs.indicators, cs.indicators_source_id, cs.boundary_source_id,
              e.certificates, e.entries, e.units_certified, e.cooling_demand_median,
              e.cooling_demand_min, e.cooling_demand_max, e.letters, e.latest_date, e.source_id AS epc_source,
              i.rank_high, i.index_low, i.index_mid, i.index_high, i.factors, i.completeness,
              run.method, run.refs, run.computed_at, run.scored
         FROM h3_index i
         JOIN h3_index_runs run ON run.id = i.run_id
         JOIN h3_buildings b USING (ref)
         JOIN h3_facades_inferred f USING (ref)
         JOIN h3_building_climate c USING (ref)
         LEFT JOIN h3_building_section s USING (ref)
         LEFT JOIN h3_census_sections cs ON cs.cusec = s.cusec
         LEFT JOIN h3_building_epc e USING (ref)
        WHERE i.run_id = $1 AND i.ref = $2`,
      [run.id, ref],
    );
    if (r.rows.length === 0) return null;
    const x = r.rows[0];
    const sourceIds = [x.catastro_source, x.dem_source_id, x.indicators_source_id, x.boundary_source_id, x.epc_source].filter(
      (v): v is string => typeof v === "string",
    );
    const sources = (await db.query(`SELECT * FROM h3_sources WHERE id = ANY($1::text[]) ORDER BY id`, [sourceIds])).rows;
    return { runId: run.id, row: x, sources };
  });
}

export interface PortfolioSummary {
  readonly runId: string;
  readonly scored: number;
  readonly dwellings: number;
  readonly certified: number;
  /** Ten groups by rank on the high end: 1 = the tenth to look at first. */
  readonly deciles: readonly {
    readonly decile: number;
    readonly buildings: number;
    readonly dwellings: number;
    readonly withCertificate: number;
    readonly medianMid: number;
  }[];
  /** First decile buildings with no certificate evidence: where a survey would add most. */
  readonly gap: { readonly buildings: number; readonly dwellings: number };
  /** Census districts present, for the filter. */
  readonly districts: readonly string[];
}

export async function portfolioSummary(db: Db, ine: string): Promise<PortfolioSummary> {
  return guarded(ine, async () => {
    const run = await latestRun(db, ine);
    const r = await db.query(
      `WITH x AS (
         SELECT i.rank_high, i.index_mid, b.dwellings,
                ((i.completeness->>'certificateCoverage')::numeric > 0) AS certified,
                ntile(10) OVER (ORDER BY i.rank_high) AS decile
           FROM h3_index i JOIN h3_buildings b USING (ref) WHERE i.run_id = $1)
       SELECT decile, count(*)::int AS buildings, sum(dwellings)::int AS dwellings,
              count(*) FILTER (WHERE certified)::int AS with_certificate,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY index_mid) AS median_mid,
              count(*) FILTER (WHERE decile = 1 AND NOT certified)::int AS gap_buildings,
              coalesce(sum(dwellings) FILTER (WHERE decile = 1 AND NOT certified), 0)::int AS gap_dwellings
         FROM x GROUP BY decile ORDER BY decile`,
      [run.id],
    );
    const deciles = r.rows.map((d) => ({
      decile: d.decile, buildings: d.buildings, dwellings: d.dwellings,
      withCertificate: d.with_certificate, medianMid: Number(d.median_mid),
    }));
    const first = r.rows.find((d) => d.decile === 1);
    const districts = (
      await db.query<{ d: string }>(
        `SELECT DISTINCT substr(s.cusec, 6, 2) AS d FROM h3_index i JOIN h3_building_section s USING (ref)
          WHERE i.run_id = $1 ORDER BY d`,
        [run.id],
      )
    ).rows.map((x) => x.d);
    return {
      runId: run.id,
      scored: deciles.reduce((s, d) => s + d.buildings, 0),
      dwellings: deciles.reduce((s, d) => s + d.dwellings, 0),
      certified: deciles.reduce((s, d) => s + d.withCertificate, 0),
      deciles,
      gap: { buildings: first ? first.gap_buildings : 0, dwellings: first ? first.gap_dwellings : 0 },
      districts,
    };
  });
}

/** Every scored building, ranked, for the CSV export. */
export async function exportRows(db: Db, ine: string): Promise<{ runId: string; rows: PortfolioRow[] }> {
  return guarded(ine, async () => {
    const run = await latestRun(db, ine);
    const r = await db.query(`${ROW_SELECT} ORDER BY i.rank_high`, [run.id]);
    return { runId: run.id, rows: r.rows.map(toRow) };
  });
}
