/**
 * H3.1 — load one municipality's Catastro buildings into PostGIS, and
 * H3.2 — derive each building's façade profile from the loaded footprints.
 *
 * The caller supplies the text streams (latin1-decoded GML) and the source
 * record. This module never downloads anything (G10 for its tests; and the
 * download is a separate, hashed, dated step so the source of every row is a
 * file someone can fetch again and compare).
 */
import type { Client, Pool, PoolClient } from "pg";
import {
  featureBlocks,
  parseBuildingFeature,
  parseBuildingPartFeature,
  type CatastroBuilding,
  type Polygon,
} from "../catastro/gml";
import { facadeProfile, type FacadeSegment } from "../orientation";
import { FACADE_SEGMENTS_SQL } from "./facades-sql";
import { H3_SCHEMA_SQL } from "./schema";

type Db = Pool | PoolClient | Client;

export interface SourceRecord {
  readonly id: string;
  readonly publisher: string;
  readonly dataset: string;
  readonly url: string;
  /** null when the publisher sends no Last-Modified (the IGN WCS). */
  readonly lastModified: string | null;
  readonly sha256: string;
  readonly retrievedAt: string;
  readonly licence: string;
}

export interface IngestStats {
  readonly buildings: number;
  readonly parts: number;
  readonly buildingsWithoutParts: number;
  readonly partsWithoutBuilding: number;
  /** Rows already stored for this municipality that this source no longer lists. */
  readonly staleRows: number;
}

export async function ensureH3Schema(db: Db): Promise<void> {
  for (const sql of H3_SCHEMA_SQL) await db.query(sql);
}

export async function upsertSource(db: Db, s: SourceRecord): Promise<void> {
  await db.query(
    `INSERT INTO h3_sources (id, publisher, dataset, url, last_modified, sha256, retrieved_at, licence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       publisher = EXCLUDED.publisher, dataset = EXCLUDED.dataset, url = EXCLUDED.url,
       last_modified = EXCLUDED.last_modified, sha256 = EXCLUDED.sha256,
       retrieved_at = EXCLUDED.retrieved_at, licence = EXCLUDED.licence`,
    [s.id, s.publisher, s.dataset, s.url, s.lastModified, s.sha256, s.retrievedAt, s.licence],
  );
}

/** WKT MULTIPOLYGON from parsed patches, coordinates written as read. */
export function toMultiPolygonWkt(polygons: readonly Polygon[]): string {
  const poly = (p: Polygon) =>
    `(${p.map((ring) => `(${ring.map(([x, y]) => `${x} ${y}`).join(",")})`).join(",")})`;
  return `MULTIPOLYGON(${polygons.map(poly).join(",")})`;
}

interface PartSummary {
  count: number;
  floorsAboveMax: number | null;
}

export interface MunicipalityIngest {
  readonly ineMunicipality: string;
  readonly catastroMunicipality: string;
  /** As the INE writes it, e.g. "Córdoba". */
  readonly municipalityName: string;
  /** climate-zones.json province key, e.g. "Córdoba". */
  readonly province: string;
  readonly source: SourceRecord;
  readonly buildingGml: AsyncIterable<string>;
  readonly buildingPartGml: AsyncIterable<string>;
  readonly batchSize?: number;
}

export async function ingestMunicipality(db: Db, job: MunicipalityIngest): Promise<IngestStats> {
  if (!/^\d{5}$/.test(job.ineMunicipality)) {
    throw new Error(`INE municipality code must be 5 digits, got ${JSON.stringify(job.ineMunicipality)}`);
  }
  const batchSize = job.batchSize ?? 500;

  // Parts first: floors are only published on parts.
  const parts = new Map<string, PartSummary>();
  let partCount = 0;
  for await (const block of featureBlocks(job.buildingPartGml)) {
    const p = parseBuildingPartFeature(block);
    partCount++;
    const s = parts.get(p.ref) ?? { count: 0, floorsAboveMax: null };
    s.count++;
    if (p.floorsAboveGround !== null) {
      s.floorsAboveMax =
        s.floorsAboveMax === null ? p.floorsAboveGround : Math.max(s.floorsAboveMax, p.floorsAboveGround);
    }
    parts.set(p.ref, s);
  }

  await upsertSource(db, job.source);
  await db.query(
    `INSERT INTO h3_municipalities (ine, name, province, catastro) VALUES ($1,$2,$3,$4)
     ON CONFLICT (ine) DO UPDATE SET name = EXCLUDED.name, province = EXCLUDED.province, catastro = EXCLUDED.catastro`,
    [job.ineMunicipality, job.municipalityName, job.province, job.catastroMunicipality],
  );

  const seen = new Set<string>();
  let withoutParts = 0;
  let batch: CatastroBuilding[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const b of batch) {
      const s = parts.get(b.ref);
      if (!s) withoutParts++;
      const o = values.length;
      values.push(
        b.ref,
        job.ineMunicipality,
        job.catastroMunicipality,
        job.source.id,
        toMultiPolygonWkt(b.polygons),
        b.epsg,
        b.condition,
        b.yearBeginning,
        b.yearEnd,
        b.currentUse,
        b.buildingUnits,
        b.dwellings,
        b.grossFloorAreaM2,
        s ? s.count : 0,
        s ? s.floorsAboveMax : null,
      );
      const p = (i: number) => `$${o + i}`;
      rows.push(
        `(${p(1)},${p(2)},${p(3)},${p(4)},ST_Multi(ST_Transform(ST_GeomFromText(${p(5)}, ${p(6)}::int), 25830)),` +
          `${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)})`,
      );
    }
    await db.query(
      `INSERT INTO h3_buildings (ref, ine_municipality, catastro_municipality, source_id, footprint,
         condition, year_beginning, year_end, current_use, building_units, dwellings,
         gross_floor_area_m2, part_count, floors_above_max)
       VALUES ${rows.join(",")}
       ON CONFLICT (ref) DO UPDATE SET
         ine_municipality = EXCLUDED.ine_municipality,
         catastro_municipality = EXCLUDED.catastro_municipality,
         source_id = EXCLUDED.source_id, footprint = EXCLUDED.footprint,
         condition = EXCLUDED.condition, year_beginning = EXCLUDED.year_beginning,
         year_end = EXCLUDED.year_end, current_use = EXCLUDED.current_use,
         building_units = EXCLUDED.building_units, dwellings = EXCLUDED.dwellings,
         gross_floor_area_m2 = EXCLUDED.gross_floor_area_m2, part_count = EXCLUDED.part_count,
         floors_above_max = EXCLUDED.floors_above_max, ingested_at = now()`,
      values,
    );
    batch = [];
  };

  for await (const block of featureBlocks(job.buildingGml)) {
    const b = parseBuildingFeature(block);
    if (seen.has(b.ref)) throw new Error(`duplicate building ${b.ref} in source ${job.source.id}`);
    seen.add(b.ref);
    batch.push(b);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  let partsWithoutBuilding = 0;
  for (const ref of parts.keys()) if (!seen.has(ref)) partsWithoutBuilding++;

  const stale = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM h3_buildings WHERE ine_municipality = $1 AND source_id <> $2`,
    [job.ineMunicipality, job.source.id],
  );

  return {
    buildings: seen.size,
    parts: partCount,
    buildingsWithoutParts: withoutParts,
    partsWithoutBuilding,
    staleRows: Number(stale.rows[0].n),
  };
}

export interface FacadeRunStats {
  readonly buildings: number;
  readonly segments: number;
}

/**
 * Compute and store façade profiles for one municipality, `pageSize`
 * buildings per query.
 */
export async function computeFacades(
  db: Db,
  ineMunicipality: string,
  toleranceM: number,
  pageSize = 1000,
): Promise<FacadeRunStats> {
  if (!(toleranceM > 0 && toleranceM < 5)) {
    throw new Error(`tolerance must be in (0, 5) metres, got ${toleranceM}`);
  }
  const refs = (
    await db.query<{ ref: string }>(
      `SELECT ref FROM h3_buildings WHERE ine_municipality = $1 ORDER BY ref`,
      [ineMunicipality],
    )
  ).rows.map((r) => r.ref);

  let segmentCount = 0;
  for (let i = 0; i < refs.length; i += pageSize) {
    const page = refs.slice(i, i + pageSize);
    const res = await db.query<{
      ref: string;
      ring: number;
      azimuth_deg: number;
      length_m: number;
      shared_m: number;
    }>(FACADE_SEGMENTS_SQL, [ineMunicipality, toleranceM, page]);
    const byRef = new Map<string, FacadeSegment[]>();
    for (const r of res.rows) {
      const list = byRef.get(r.ref) ?? [];
      list.push({
        ring: Number(r.ring),
        azimuthDeg: Number(r.azimuth_deg),
        lengthM: Number(r.length_m),
        sharedM: Number(r.shared_m),
      });
      byRef.set(r.ref, list);
    }
    segmentCount += res.rows.length;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const ref of page) {
      const segs = byRef.get(ref);
      if (!segs) throw new Error(`building ${ref} produced no outline edges`);
      const prof = facadeProfile(segs);
      const o = values.length;
      values.push(
        ref,
        "postgis-party-wall-buffer-v1",
        toleranceM,
        prof.perimeterM,
        prof.partyWallM,
        JSON.stringify({ basis: prof.basis, street: prof.street, courtyard: prof.courtyard }),
      );
      rows.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::jsonb)`);
    }
    await db.query(
      `INSERT INTO h3_facades_inferred (ref, method, tolerance_m, perimeter_m, party_wall_m, exposed_m)
       VALUES ${rows.join(",")}
       ON CONFLICT (ref) DO UPDATE SET method = EXCLUDED.method, tolerance_m = EXCLUDED.tolerance_m,
         perimeter_m = EXCLUDED.perimeter_m, party_wall_m = EXCLUDED.party_wall_m,
         exposed_m = EXCLUDED.exposed_m, computed_at = now()`,
      values,
    );
  }
  return { buildings: refs.length, segments: segmentCount };
}
