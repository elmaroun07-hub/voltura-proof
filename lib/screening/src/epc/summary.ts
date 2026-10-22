/**
 * H3.6 — one building's certificate evidence, from all certificates that name it.
 *
 * Rule, so the reader can check it:
 *   - One entry per certified unit: its latest certificate with a valid date
 *     (a unit re-certified in 2019 and 2024 counts once, as 2024). A unit whose
 *     only certificates carry invalid dates keeps its latest by publication
 *     order, flagged.
 *   - Certificates naming the parcel, or a list of its units, count as one
 *     more entry: the latest of them.
 *   - The building's cooling demand is the MEDIAN of those entries, with the
 *     range beside it. A median, because the register holds modelled outliers
 *     (one Córdoba certificate reads 1,592 kWh/m²·year against a median of
 *     22.75); they stay in the range, visible, rather than being dropped.
 *   - No entry, no evidence: the summary is null and the index treats the
 *     certificate input as absent (P2). Nothing is imputed here.
 */
import type { EpcCertificate, EpcLetter } from "./register";

export interface BuildingEpcSummary {
  readonly buildingRef: string;
  /** Every certificate naming the building. */
  readonly certificates: number;
  /** Entries after the one-per-unit rule. */
  readonly entries: number;
  readonly unitsCertified: number;
  readonly entriesWithInvalidDate: number;
  readonly coolingDemandMedian: number | null;
  readonly coolingDemandMin: number | null;
  readonly coolingDemandMax: number | null;
  readonly letters: Readonly<Record<EpcLetter, number>>;
  readonly latestDate: string | null;
}

type Ranked = Pick<EpcCertificate, "unitRef" | "date" | "dateValid">;

function better<C extends Ranked>(a: C, b: C): C {
  if (a.dateValid !== b.dateValid) return a.dateValid ? a : b;
  // Same validity: the later date wins; on equal or missing dates, the later in the file.
  if (a.date !== null && b.date !== null && a.date !== b.date) return a.date > b.date ? a : b;
  return b;
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The rule above, alone: one building's certificates (in file order) to its
 * entries. Exported so the index reads the same entries the summary counts.
 */
export function entriesOf<C extends Ranked>(certs: readonly C[]): C[] {
  const perUnit = new Map<string, C>();
  let whole: C | null = null;
  for (const c of certs) {
    if (c.unitRef !== null) {
      const prev = perUnit.get(c.unitRef);
      perUnit.set(c.unitRef, prev ? better(prev, c) : c);
    } else {
      whole = whole ? better(whole, c) : c;
    }
  }
  return [...perUnit.values(), ...(whole ? [whole] : [])];
}

/** `certs` must all name the same building, in file order. */
export function summariseBuilding(certs: readonly EpcCertificate[]): BuildingEpcSummary {
  if (certs.length === 0) throw new Error("summariseBuilding needs at least one certificate");
  const ref = certs[0].buildingRef;
  if (certs.some((c) => c.buildingRef !== ref)) throw new Error("certificates for more than one building");

  const entries = entriesOf(certs);
  const unitsCertified = entries.filter((e) => e.unitRef !== null).length;
  const demands = entries.map((e) => e.coolingDemand).filter((d): d is number => d !== null);
  const letters: Record<EpcLetter, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
  for (const e of entries) if (e.coolingLetter) letters[e.coolingLetter]++;
  const dates = entries.map((e) => (e.dateValid ? e.date : null)).filter((d): d is string => d !== null).sort();
  return {
    buildingRef: ref,
    certificates: certs.length,
    entries: entries.length,
    unitsCertified,
    entriesWithInvalidDate: entries.filter((e) => !e.dateValid).length,
    coolingDemandMedian: demands.length ? median(demands) : null,
    coolingDemandMin: demands.length ? Math.min(...demands) : null,
    coolingDemandMax: demands.length ? Math.max(...demands) : null,
    letters,
    latestDate: dates.length ? dates[dates.length - 1] : null,
  };
}
