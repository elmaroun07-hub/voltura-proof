/**
 * H3.3 + H3.4 in the database: sample the terrain model at each building,
 * resolve its CTE zone, and price its exposed façades in July.
 *
 * Needs h3_facades_inferred filled first (computeFacades): exposure is
 * computed on the exposed façades, not on the raw perimeter.
 */
import type { Client, Pool, PoolClient } from "pg";
import { julyExposure, zoneFor } from "../climate";
import { sampleCell, type AsciiGrid } from "../dem/ascii-grid";
import type { FacadeProfile } from "../orientation";

type Db = Pool | PoolClient | Client;

export const ALTITUDE_BASIS = "ign-mdt25-cell-at-point-on-surface";
export const IRRADIATION_SOURCE =
  "DA DB-HE/1 (enero 2020) tabla 20/21 via @workspace/cte solar-irradiation";

export interface ClimateRunStats {
  readonly buildings: number;
  readonly byZone: Record<string, number>;
}

export async function computeClimate(
  db: Db,
  ineMunicipality: string,
  province: string,
  grid: AsciiGrid,
  demSourceId: string,
  pageSize = 2000,
): Promise<ClimateRunStats> {
  const rows = (
    await db.query<{ ref: string; x: number; y: number; exposed_m: Omit<FacadeProfile, "perimeterM" | "partyWallM"> | null }>(
      `SELECT b.ref, ST_X(p) AS x, ST_Y(p) AS y, f.exposed_m
         FROM (SELECT ref, ST_PointOnSurface(footprint) AS p FROM h3_buildings WHERE ine_municipality = $1) b
         LEFT JOIN h3_facades_inferred f USING (ref)
        ORDER BY b.ref`,
      [ineMunicipality],
    )
  ).rows;

  const byZone: Record<string, number> = {};
  for (let i = 0; i < rows.length; i += pageSize) {
    const page = rows.slice(i, i + pageSize);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const r of page) {
      if (!r.exposed_m) {
        throw new Error(`building ${r.ref} has no façade profile; run computeFacades first`);
      }
      const altitude = sampleCell(grid, Number(r.x), Number(r.y));
      const z = zoneFor(province, altitude);
      const e = julyExposure(z, {
        basis: "inferred-from-footprint",
        perimeterM: 0,
        partyWallM: 0,
        street: r.exposed_m.street,
        courtyard: r.exposed_m.courtyard,
      });
      byZone[z.zone] = (byZone[z.zone] ?? 0) + 1;
      const o = values.length;
      values.push(
        r.ref, demSourceId, altitude, ALTITUDE_BASIS, province, z.zone, z.summer,
        e.streetKwhPerMetreHeight, e.streetMeanHsolJul, e.courtyardKwhPerMetreHeight, e.roofHsolJul,
        IRRADIATION_SOURCE,
      );
      tuples.push(`(${Array.from({ length: 12 }, (_, k) => `$${o + k + 1}`).join(",")})`);
    }
    await db.query(
      `INSERT INTO h3_building_climate (ref, dem_source_id, altitude_m, altitude_basis, province, zone, summer,
         july_street_kwh_per_m, july_street_mean_kwh_m2, july_courtyard_kwh_per_m, july_roof_kwh_m2, irradiation_source)
       VALUES ${tuples.join(",")}
       ON CONFLICT (ref) DO UPDATE SET dem_source_id = EXCLUDED.dem_source_id, altitude_m = EXCLUDED.altitude_m,
         altitude_basis = EXCLUDED.altitude_basis, province = EXCLUDED.province, zone = EXCLUDED.zone,
         summer = EXCLUDED.summer, july_street_kwh_per_m = EXCLUDED.july_street_kwh_per_m,
         july_street_mean_kwh_m2 = EXCLUDED.july_street_mean_kwh_m2,
         july_courtyard_kwh_per_m = EXCLUDED.july_courtyard_kwh_per_m,
         july_roof_kwh_m2 = EXCLUDED.july_roof_kwh_m2, irradiation_source = EXCLUDED.irradiation_source,
         computed_at = now()`,
      values,
    );
  }
  return { buildings: rows.length, byZone };
}
