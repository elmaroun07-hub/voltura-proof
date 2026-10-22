/**
 * H3.7 + H3.8 in the database: read every residential building's inputs,
 * compute the municipality's references, score, rank on the high end.
 * H3-INDEX-V2: each certified building's entry values are read too, through
 * the same one-per-unit rule that counted h3_building_epc.entries.
 */
import type { Client, Pool, PoolClient } from "pg";
import { peopleInputs } from "../census/indicators";
import { entriesOf } from "../epc/summary";
import { METHOD_V2, IndexInputError, computeReferences, scoreBuilding, type BuildingInputs, type IndexMethod, type References } from "../heat-index";

type Db = Pool | PoolClient | Client;

export interface IndexRunStats {
  readonly runId: string;
  readonly scored: number;
  readonly notScored: { readonly notResidential: number; readonly noDwellings: number };
  readonly withCertificate: number;
  /** Certificate entries of the scored buildings, and how many of them carry a cooling demand. */
  readonly entries: number;
  readonly entriesWithValue: number;
  readonly withoutCensusInput: number;
  readonly coolingCap: number;
  readonly cappedBuildings: number;
  /** v2: k, EPV, VHM, buildings and entries per band (also in the run's refs); null under v1. */
  readonly credibility: References["coolingCredibility"] | null;
}

const INPUTS_SQL = `
SELECT b.ref, b.dwellings, b.year_end, b.current_use,
       c.july_roof_kwh_m2, c.july_street_kwh_per_m, f.perimeter_m,
       e.entries, e.cooling_demand_median, e.cooling_demand_min, e.cooling_demand_max,
       cs.indicators
  FROM h3_buildings b
  JOIN h3_facades_inferred f USING (ref)
  JOIN h3_building_climate c USING (ref)
  LEFT JOIN h3_building_epc e USING (ref)
  LEFT JOIN h3_building_section s USING (ref)
  LEFT JOIN h3_census_sections cs ON cs.cusec = s.cusec
 WHERE b.ine_municipality = $1
 ORDER BY b.ref`;

type Row = {
  ref: string; dwellings: number | null; year_end: number | null; current_use: string | null;
  july_roof_kwh_m2: string; july_street_kwh_per_m: string; perimeter_m: string;
  entries: number | null; cooling_demand_median: string | null; cooling_demand_min: string | null; cooling_demand_max: string | null;
  indicators: Record<string, number | null> | null;
};

/**
 * Certificates of the municipality's summarised buildings, from the source
 * their summary was built from, in file order — what summariseBuilding saw.
 */
const CERTIFICATES_SQL = `
SELECT c.ref, c.unit_ref, to_char(c.cert_date, 'YYYY-MM-DD') AS cert_date, c.date_valid, c.cooling_demand
  FROM h3_epc_certificates c
  JOIN h3_building_epc e ON e.ref = c.ref AND e.source_id = c.source_id
  JOIN h3_buildings b ON b.ref = c.ref
 WHERE b.ine_municipality = $1
 ORDER BY c.ref, c.ordinal`;

export type CertificateRow = {
  ref: string; unit_ref: string | null; cert_date: string | null; date_valid: boolean; cooling_demand: string | null;
};

/** Per building: its entries (one per unit, epc/summary.ts) and the cooling demand of each that has one. */
export function entryValues(rows: readonly CertificateRow[]): Map<string, { entries: number; values: number[] }> {
  const byRef = new Map<string, { unitRef: string | null; date: string | null; dateValid: boolean; demand: string | null }[]>();
  for (const r of rows) {
    const list = byRef.get(r.ref) ?? [];
    list.push({ unitRef: r.unit_ref, date: r.cert_date, dateValid: r.date_valid, demand: r.cooling_demand });
    byRef.set(r.ref, list);
  }
  const out = new Map<string, { entries: number; values: number[] }>();
  for (const [ref, certs] of byRef) {
    const entries = entriesOf(certs);
    out.set(ref, { entries: entries.length, values: entries.filter((e) => e.demand !== null).map((e) => Number(e.demand)) });
  }
  return out;
}

export async function computeIndex(db: Db, ineMunicipality: string, method: IndexMethod = METHOD_V2): Promise<IndexRunStats> {
  const rows = (await db.query<Row>(INPUTS_SQL, [ineMunicipality])).rows;
  const perBuilding = entryValues((await db.query<CertificateRow>(CERTIFICATES_SQL, [ineMunicipality])).rows);
  let entries = 0;
  let entriesRead = 0;
  let entriesWithValue = 0;
  let notResidential = 0;
  let noDwellings = 0;
  const inputs: BuildingInputs[] = [];
  for (const r of rows) {
    if (r.current_use !== "1_residential") { notResidential++; continue; }
    if (!(r.dwellings !== null && r.dwellings > 0)) { noDwellings++; continue; }
    const hasCert = r.entries !== null && r.cooling_demand_median !== null;
    const read = perBuilding.get(r.ref);
    if (r.entries !== null) {
      entries += r.entries;
      entriesRead += read?.entries ?? 0;
    }
    if (hasCert) entriesWithValue += read?.values.length ?? 0;
    inputs.push({
      ref: r.ref,
      dwellings: r.dwellings,
      year: r.year_end,
      hsolHorizontal: Number(r.july_roof_kwh_m2),
      streetKwhPerMetre: Number(r.july_street_kwh_per_m),
      perimeterM: Number(r.perimeter_m),
      certificate: hasCert
        ? {
            entries: r.entries!,
            median: Number(r.cooling_demand_median),
            min: Number(r.cooling_demand_min),
            max: Number(r.cooling_demand_max),
            values: read?.values ?? [],
          }
        : null,
      census: peopleInputs(r.indicators),
    });
  }
  // The entries read here must be the entries the summary counted, or the
  // estimate and the weight would describe different evidence.
  if (entriesRead !== entries) {
    throw new IndexInputError(`entries read (${entriesRead}) ≠ Σ h3_building_epc.entries of scored buildings (${entries})`);
  }
  const values = (
    await db.query<{ v: string }>(
      `SELECT c.cooling_demand AS v FROM h3_epc_certificates c JOIN h3_buildings b USING (ref)
        WHERE b.ine_municipality = $1 AND c.cooling_demand IS NOT NULL`,
      [ineMunicipality],
    )
  ).rows.map((r) => Number(r.v));
  const refs = computeReferences(inputs, values, method);
  const scores = inputs.map((b) => scoreBuilding(b, refs));
  const ranked = [...scores].sort(
    (a, b) => b.index.high - a.index.high || b.index.mid - a.index.mid || (a.ref < b.ref ? -1 : 1),
  );
  const runId = `${method.version}-${ineMunicipality}-${new Date().toISOString()}`;
  await db.query(
    `INSERT INTO h3_index_runs (id, ine_municipality, method, refs, scored, not_scored) VALUES ($1,$2,$3,$4,$5,$6)`,
    [runId, ineMunicipality, JSON.stringify(method), JSON.stringify(refs), scores.length, JSON.stringify({ notResidential, noDwellings })],
  );
  for (let i = 0; i < ranked.length; i += 1000) {
    const page = ranked.slice(i, i + 1000);
    const values: unknown[] = [];
    const tuples: string[] = [];
    page.forEach((s, j) => {
      const k = values.length;
      values.push(s.ref, runId, s.index.low, s.index.mid, s.index.high, i + j + 1, JSON.stringify(s.factors), JSON.stringify(s.completeness));
      tuples.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7}::jsonb,$${k + 8}::jsonb)`);
    });
    await db.query(
      `INSERT INTO h3_index (ref, run_id, index_low, index_mid, index_high, rank_high, factors, completeness)
       VALUES ${tuples.join(",")}
       ON CONFLICT (ref) DO UPDATE SET run_id = EXCLUDED.run_id, index_low = EXCLUDED.index_low,
         index_mid = EXCLUDED.index_mid, index_high = EXCLUDED.index_high, rank_high = EXCLUDED.rank_high,
         factors = EXCLUDED.factors, completeness = EXCLUDED.completeness`,
      values,
    );
  }
  return {
    runId,
    scored: scores.length,
    notScored: { notResidential, noDwellings },
    withCertificate: inputs.filter((b) => b.certificate !== null).length,
    entries,
    entriesWithValue,
    withoutCensusInput: inputs.filter((b) => b.census === null).length,
    coolingCap: refs.coolingCap.value,
    cappedBuildings: scores.filter((x) => x.completeness.certificateCapped).length,
    credibility: refs.coolingCredibility ?? null,
  };
}
