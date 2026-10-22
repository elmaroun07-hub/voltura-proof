/**
 * H3.6 (A26) in the database: certificates naming the municipality's
 * buildings, and one summary per certified building.
 */
import type { Client, Pool, PoolClient } from "pg";
import { certificateBlocks, parseCertificate, type EpcCertificate, type EpcRejection } from "../epc/register";
import { summariseBuilding } from "../epc/summary";

type Db = Pool | PoolClient | Client;

export interface EpcLoadStats {
  readonly certificatesInFile: number;
  readonly matched: number;
  /** Certificates whose building is not among this municipality's loaded buildings. */
  readonly unmatchedBuilding: number;
  readonly rejected: Readonly<Record<EpcRejection, number>>;
  readonly buildingsWithCertificate: number;
  readonly buildingsInMunicipality: number;
}

export async function loadEpcRegister(
  db: Db,
  ineMunicipality: string,
  chunks: AsyncIterable<string>,
  fileDate: string,
  sourceId: string,
  batchSize = 500,
): Promise<EpcLoadStats> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) throw new Error(`fileDate must be yyyy-mm-dd, got ${fileDate}`);
  const refs = new Set(
    (await db.query<{ ref: string }>(`SELECT ref FROM h3_buildings WHERE ine_municipality = $1`, [ineMunicipality])).rows.map(
      (r) => r.ref,
    ),
  );
  const byBuilding = new Map<string, EpcCertificate[]>();
  const rejected: Record<EpcRejection, number> = { "malformed-ref": 0, "unit-list-spans-parcels": 0 };
  let ordinal = 0;
  let matched = 0;
  let unmatched = 0;
  let batch: { ordinal: number; c: EpcCertificate }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const { ordinal: o, c } of batch) {
      const k = values.length;
      values.push(
        sourceId, o, c.buildingRef, c.unitRef, c.refForm, c.date, c.dateValid, c.buildingType, c.scope,
        c.procedure, c.coolingDemand, c.coolingLetter, c.coolingScale === null ? null : JSON.stringify(c.coolingScale),
      );
      rows.push(`(${Array.from({ length: 13 }, (_, i) => `$${k + i + 1}`).join(",")})`);
    }
    await db.query(
      `INSERT INTO h3_epc_certificates (source_id, ordinal, ref, unit_ref, ref_form, cert_date, date_valid,
         building_type, scope, procedure, cooling_demand, cooling_letter, cooling_scale)
       VALUES ${rows.join(",")}
       ON CONFLICT (source_id, ordinal) DO UPDATE SET ref = EXCLUDED.ref, unit_ref = EXCLUDED.unit_ref,
         ref_form = EXCLUDED.ref_form, cert_date = EXCLUDED.cert_date, date_valid = EXCLUDED.date_valid,
         building_type = EXCLUDED.building_type, scope = EXCLUDED.scope, procedure = EXCLUDED.procedure,
         cooling_demand = EXCLUDED.cooling_demand, cooling_letter = EXCLUDED.cooling_letter,
         cooling_scale = EXCLUDED.cooling_scale`,
      values,
    );
    batch = [];
  };

  for await (const block of certificateBlocks(chunks)) {
    ordinal++;
    const r = parseCertificate(block, fileDate);
    if (!r.ok) {
      rejected[r.reason]++;
      continue;
    }
    if (!refs.has(r.cert.buildingRef)) {
      unmatched++;
      continue;
    }
    matched++;
    const list = byBuilding.get(r.cert.buildingRef) ?? [];
    list.push(r.cert);
    byBuilding.set(r.cert.buildingRef, list);
    batch.push({ ordinal, c: r.cert });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  const summaries = [...byBuilding.values()].map(summariseBuilding);
  for (let i = 0; i < summaries.length; i += batchSize) {
    const page = summaries.slice(i, i + batchSize);
    const values: unknown[] = [];
    const rows: string[] = [];
    for (const s of page) {
      const k = values.length;
      values.push(
        s.buildingRef, sourceId, s.certificates, s.entries, s.unitsCertified, s.entriesWithInvalidDate,
        s.coolingDemandMedian, s.coolingDemandMin, s.coolingDemandMax, JSON.stringify(s.letters), s.latestDate,
      );
      rows.push(`(${Array.from({ length: 11 }, (_, j) => `$${k + j + 1}`).join(",")})`);
    }
    await db.query(
      `INSERT INTO h3_building_epc (ref, source_id, certificates, entries, units_certified, entries_invalid_date,
         cooling_demand_median, cooling_demand_min, cooling_demand_max, letters, latest_date)
       VALUES ${rows.join(",")}
       ON CONFLICT (ref) DO UPDATE SET source_id = EXCLUDED.source_id, certificates = EXCLUDED.certificates,
         entries = EXCLUDED.entries, units_certified = EXCLUDED.units_certified,
         entries_invalid_date = EXCLUDED.entries_invalid_date,
         cooling_demand_median = EXCLUDED.cooling_demand_median, cooling_demand_min = EXCLUDED.cooling_demand_min,
         cooling_demand_max = EXCLUDED.cooling_demand_max, letters = EXCLUDED.letters, latest_date = EXCLUDED.latest_date`,
      values,
    );
  }

  return {
    certificatesInFile: ordinal,
    matched,
    unmatchedBuilding: unmatched,
    rejected,
    buildingsWithCertificate: byBuilding.size,
    buildingsInMunicipality: refs.size,
  };
}
