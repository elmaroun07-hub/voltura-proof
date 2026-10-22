/**
 * H3.7 + H3.8 — the summer-heat screening index and its band.
 *
 * P7: this is a SCREENING index — a way to decide where to look first. It is
 * never a grade, a rating or a compliance result, and it never renders as a
 * bare number: every score carries a low and a high end.
 *
 * ── What one score describes ──────────────────────────────────────────────
 * The building's TOP-FLOOR dwelling: the one under the roof, with the
 * building's exposed street façades. (Chosen 14 Oct 2026 under the operator's
 * delegation; the building-average alternative let detached houses take
 * 96–98 % of Córdoba's top 1,000 because a block's roof heat is spread over
 * its floors, and the dwellings that overheat in a block are the top ones.)
 *
 * ── Factors (each relative to the municipality's residential median: 1 = typical)
 *   Hz  hazard      July horizontal irradiation of the building's CTE zone
 *                   (DA DB-HE/1 tabla 20/21) — the sun on the roof.
 *   Ex  exposure    (1 + façade term) / 2. The top floor has a roof in every
 *                   building, and the roof's irradiation is already Hz, so its
 *                   half is the constant 1; the other half is the building's
 *                   July irradiation on exposed street façades per metre of
 *                   perimeter (party walls contribute 0), relative to the
 *                   median. Roof and façade weigh half each because their real
 *                   split depends on storey height and floor plan, which no
 *                   public register gives. Courtyards are left out: self-shaded.
 *   En  sensitivity cooling demand, kWh/m²·year, from the Junta's certificate
 *                   register (A26): the building's own certificates where they
 *                   exist, the certified buildings of its age band otherwise.
 *   Vu  people      mean of three census-section ratios (Censo 2021):
 *                   share aged over 64 (t4_3), one-person households
 *                   (t22_1 / t21_1), unemployment (t10_1).
 *
 * ── Weights ───────────────────────────────────────────────────────────────
 * Risk thirds, after IPCC AR5 WGII (risk from the interaction of hazard,
 * exposure and vulnerability): hazard + exposure ⅓ (Hz ⅙, Ex ⅙), the
 * building's sensitivity ⅓ (En), people ⅓ (Vu). Combined as a weighted
 * geometric mean, so the contract's "×" holds and 1.0 means typical.
 *
 * ── The band ──────────────────────────────────────────────────────────────
 * Hz and Ex are points (computed from sourced tables and geometry). En and Vu
 * carry ranges:
 *   En, certified:   w is the weight on the building's own entries; the rest
 *                    falls back on its age band.
 *                    low  = w·min(entries) + (1−w)·p10(band)
 *                    mid  = w·median(entries) + (1−w)·p50(band)
 *                    high = w·max(entries) + (1−w)·p90(band)
 *                    v1: w = min(1, entries / dwellings). A single dwelling
 *                    with one certificate got w = 1 — a zero-width band — and
 *                    on Córdoba (run of 14 Oct 2026) that put every one of the
 *                    top 20 above the highest value an uncertified building
 *                    could reach.
 *                    v2: w = min(1, entries / dwellings) × entries / (entries + k),
 *                    k measured per age band from the municipality's own
 *                    certificates (Bühlmann–Straub credibility; below). One
 *                    certificate on one dwelling now counts 1 / (1 + k).
 *   En, no certificate: p10 / p50 / p90 of certified buildings of the same age
 *                    band in the municipality; with no year either, of all
 *                    certified buildings.
 *   Vu, no census section: p10 / p50 / p90 of Vu over the municipality's
 *                    placed buildings.
 * Ranking uses the HIGH end (precautionary: look first where the risk could be
 * highest; a survey in H4 collapses the band). Low ≤ mid ≤ high always.
 *
 * Certificate values are winsorised at the municipality's 99th percentile of
 * all certificates before anything else uses them. Without it, the first run on
 * Córdoba (14 Oct 2026) put a 16-dwelling block at rank 1 because one of its
 * certificates reads 1,592 kWh/m²·year (municipal median 22.8, p99 60.2): the
 * precautionary high end amplifies a data-entry error. Capped values stay
 * high — at the 99th percentile — so a genuinely bad certificate still counts;
 * the raw value stays in h3_epc_certificates.
 *
 * ── Credibility (v2) ──────────────────────────────────────────────────────
 * Bühlmann (1967), ASTIN Bulletin 4(3); Bühlmann & Straub (1970), Mitt. VSVM 70.
 * Per age band B (and `all`), over the certified scored buildings of B, on
 * their ENTRIES (one per unit, the epc/summary.ts rule), each value capped
 * before estimation:
 *   EPV = Σ_i Σ_j (x_ij − x̄_i)² / Σ_i (n_i − 1)            within a building
 *   VHM = [Σ_i n_i (x̄_i − x̄)² − (r − 1)·EPV] / (N − Σ n_i² / N)   between buildings
 *   k   = EPV / VHM
 * k is how many entries a building needs before its own evidence weighs as
 * much as its band: no constant is chosen by hand, and every run records k,
 * EPV, VHM, buildings and entries per band. If VHM ≤ 0, or no building in a
 * band has two entries, k is undefined and the run is refused (P2) — never
 * filled with a value.
 *
 * Every constant above is a parameter of IndexMethod, recorded with each run.
 */

export class IndexInputError extends Error {
  override name = "IndexInputError";
}

export type AgeBand = "pre-1980" | "1980-2006" | "2007-on";

/**
 * Thermal-regulation eras: NBE-CT-79 (Real Decreto 2429/1979) was Spain's
 * first thermal standard; CTE DB-HE (Real Decreto 314/2006) applies to
 * buildings permitted from 2007.
 */
export function ageBand(year: number | null): AgeBand | null {
  if (year === null) return null;
  if (year < 1980) return "pre-1980";
  if (year < 2007) return "1980-2006";
  return "2007-on";
}

export interface BuildingInputs {
  readonly ref: string;
  readonly dwellings: number;
  /** Latest construction date the Catastro records (dateOfConstruction/end). */
  readonly year: number | null;
  /** Hsol;jul on a horizontal surface in the building's zone, kWh/m². */
  readonly hsolHorizontal: number;
  /** Σ exposed street façade length × Hsol;jul of its orientation (kWh per m of height). */
  readonly streetKwhPerMetre: number;
  readonly perimeterM: number;
  readonly certificate: {
    readonly entries: number;
    readonly median: number;
    readonly min: number;
    readonly max: number;
    /**
     * Cooling demand of each entry that has one, uncapped (one per entry, the
     * epc/summary.ts rule). Required by a method with credibility; v1 reads
     * only the summary above.
     */
    readonly values?: readonly number[];
  } | null;
  readonly census: {
    readonly over64: number;
    readonly onePersonHouseholds: number;
    readonly households: number;
    readonly unemployment: number;
  } | null;
}

export interface Range {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface IndexMethod {
  readonly version: string;
  readonly weights: { readonly hazard: number; readonly exposure: number; readonly sensitivity: number; readonly people: number };
  /** Quantiles used for the ends of a prior band. */
  readonly bandQuantiles: { readonly low: number; readonly high: number };
  /** Certificate values above this quantile of the municipality's certificates are capped to it. */
  readonly certificateCapQuantile: number;
  /**
   * How far a building's own entries are trusted against its age band,
   * measured per band. Absent in v1, where entries counted by dwelling
   * coverage alone.
   */
  readonly credibility?: { readonly estimator: "buhlmann-straub"; readonly source: string };
}

export const METHOD_V1: IndexMethod = {
  version: "h3-index-v1",
  weights: { hazard: 1 / 6, exposure: 1 / 6, sensitivity: 1 / 3, people: 1 / 3 },
  bandQuantiles: { low: 0.1, high: 0.9 },
  certificateCapQuantile: 0.99,
};

/** v1 with credibility weighting (ruling of 21 Oct 2026, contracts/rulings/h3-index-v2.md). */
export const METHOD_V2: IndexMethod = {
  version: "h3-index-v2",
  weights: METHOD_V1.weights,
  bandQuantiles: METHOD_V1.bandQuantiles,
  certificateCapQuantile: METHOD_V1.certificateCapQuantile,
  credibility: {
    estimator: "buhlmann-straub",
    source: "Bühlmann (1967), ASTIN Bulletin 4(3); Bühlmann & Straub (1970), Mitteilungen der VSVM 70",
  },
};

/** Linear-interpolation quantile (Hyndman & Fan type 7, R's default). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new IndexInputError("quantile of an empty list");
  if (!(q >= 0 && q <= 1)) throw new IndexInputError(`quantile ${q} outside [0, 1]`);
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);
const range = (xs: number[], m: IndexMethod): Range => {
  const s = asc(xs);
  return { low: quantile(s, m.bandQuantiles.low), mid: quantile(s, 0.5), high: quantile(s, m.bandQuantiles.high) };
};
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

export interface Credibility {
  /** EPV / VHM: entries a building needs before its own evidence weighs as much as its band. */
  readonly k: number;
  /** Expected process variance: within a building, between its entries. */
  readonly epv: number;
  /** Variance of hypothetical means: between buildings. */
  readonly vhm: number;
  readonly buildings: number;
  readonly entries: number;
}

/**
 * Bühlmann–Straub structural parameters, one group of values per building.
 * Throws where k is undefined; it never substitutes a value.
 */
export function buhlmannStraub(groups: readonly (readonly number[])[]): Credibility {
  if (groups.some((g) => g.length === 0)) throw new IndexInputError("a building with no entry cannot enter the estimate");
  if (groups.some((g) => g.some((x) => !Number.isFinite(x)))) throw new IndexInputError("an entry is not a finite number");
  if (!groups.some((g) => g.length >= 2)) {
    throw new IndexInputError("no building has two or more entries: the within-building variance, and so k, is undefined");
  }
  const n = groups.map((g) => g.length);
  const N = sum(n);
  const means = groups.map((g) => sum(g) / g.length);
  const grand = sum(means.map((m, i) => n[i] * m)) / N;
  const epv = sum(groups.map((g, i) => sum(g.map((x) => (x - means[i]) ** 2)))) / sum(n.map((x) => x - 1));
  const vhm = (sum(means.map((m, i) => n[i] * (m - grand) ** 2)) - (groups.length - 1) * epv) / (N - sum(n.map((x) => x * x)) / N);
  if (!(vhm > 0)) throw new IndexInputError(`between-building variance is ${vhm}: k is undefined`);
  return { k: epv / vhm, epv, vhm, buildings: groups.length, entries: N };
}

/** Everything a score is measured against, computed from the municipality's own buildings. */
export interface References {
  readonly method: IndexMethod;
  readonly buildings: number;
  /** kWh/m²·year: the winsorising cap, and how many certificates it was taken over. */
  readonly coolingCap: { readonly value: number; readonly certificates: number };
  readonly median: {
    readonly hsolHorizontal: number;
    readonly facadeIrradiationPerMetre: number;
    readonly coolingDemand: number;
    readonly over64: number;
    readonly onePersonShare: number;
    readonly unemployment: number;
  };
  /** Cooling demand of certified buildings (their median), by age band and overall. */
  readonly coolingPrior: Readonly<Record<AgeBand | "all", Range & { readonly n: number }>>;
  /** v2: credibility per band; null for a band with no certified building (no building uses it). Absent in v1. */
  readonly coolingCredibility?: Readonly<Record<AgeBand | "all", Credibility | null>>;
  /** Vu over buildings with a census section. */
  readonly peoplePrior: Range;
}

function facadeTerm(b: BuildingInputs): number {
  if (!(b.perimeterM > 0)) throw new IndexInputError(`${b.ref}: perimeter must be positive`);
  if (!(b.streetKwhPerMetre >= 0)) throw new IndexInputError(`${b.ref}: façade irradiation must be ≥ 0`);
  return b.streetKwhPerMetre / b.perimeterM;
}

function onePersonShare(c: NonNullable<BuildingInputs["census"]>, ref: string): number {
  if (!(c.households > 0)) throw new IndexInputError(`${ref}: census section has no households`);
  return c.onePersonHouseholds / c.households;
}

/**
 * Medians and priors for one municipality. Throws if a prior would be empty.
 * `certificateValues` are the cooling demands of every certificate naming the
 * municipality's buildings — the population the cap is taken over.
 */
export function computeReferences(
  buildings: readonly BuildingInputs[],
  certificateValues: readonly number[],
  method: IndexMethod = METHOD_V1,
): References {
  if (buildings.length === 0) throw new IndexInputError("no buildings to reference");
  const certified = buildings.filter((b) => b.certificate !== null);
  if (certified.length === 0 || certificateValues.length === 0) {
    throw new IndexInputError("no certified building: the cooling prior would be empty");
  }
  const coolingCap = { value: quantile(asc([...certificateValues]), method.certificateCapQuantile), certificates: certificateValues.length };
  const cap = (v: number) => Math.min(v, coolingCap.value);
  const byBand: Record<AgeBand, number[]> = { "pre-1980": [], "1980-2006": [], "2007-on": [] };
  const groupsByBand: Record<AgeBand, number[][]> = { "pre-1980": [], "1980-2006": [], "2007-on": [] };
  const entryValues = (b: BuildingInputs): number[] => {
    const v = b.certificate!.values;
    if (!v || v.length === 0 || v.length > b.certificate!.entries) {
      throw new IndexInputError(`${b.ref}: credibility needs the value of each certificate entry`);
    }
    // Capped BEFORE estimation, so one data-entry error cannot inflate the variances.
    return v.map(cap);
  };
  for (const b of certified) {
    const band = ageBand(b.year);
    if (band) byBand[band].push(cap(b.certificate!.median));
    if (band && method.credibility) groupsByBand[band].push(entryValues(b));
  }
  const withBand = (xs: number[]) => ({ ...range(xs, method), n: xs.length });
  const coolingPrior = {
    all: withBand(certified.map((b) => cap(b.certificate!.median))),
  } as Record<AgeBand | "all", Range & { n: number }>;
  for (const band of Object.keys(byBand) as AgeBand[]) {
    // A band with no certified building falls back on all certified buildings,
    // recorded by n = 0 on that band rather than by an invented value.
    coolingPrior[band] = byBand[band].length ? withBand(byBand[band]) : { ...coolingPrior.all, n: 0 };
  }
  let coolingCredibility: Record<AgeBand | "all", Credibility | null> | undefined;
  if (method.credibility) {
    const of = (key: AgeBand | "all", groups: number[][]) => {
      try {
        return buhlmannStraub(groups);
      } catch (e) {
        throw e instanceof IndexInputError ? new IndexInputError(`cooling credibility, band ${key}: ${e.message}`) : e;
      }
    };
    coolingCredibility = { all: of("all", certified.map(entryValues)), "pre-1980": null, "1980-2006": null, "2007-on": null };
    for (const band of Object.keys(groupsByBand) as AgeBand[]) {
      if (groupsByBand[band].length) coolingCredibility[band] = of(band, groupsByBand[band]);
    }
  }

  const placed = buildings.filter((b) => b.census !== null);
  if (placed.length === 0) throw new IndexInputError("no building has a census section");
  const median = {
    hsolHorizontal: quantile(asc(buildings.map((b) => b.hsolHorizontal)), 0.5),
    facadeIrradiationPerMetre: quantile(asc(buildings.map(facadeTerm)), 0.5),
    // Median of each building's central cooling demand, before any band.
    coolingDemand: 0,
    over64: quantile(asc(placed.map((b) => b.census!.over64)), 0.5),
    onePersonShare: quantile(asc(placed.map((b) => onePersonShare(b.census!, b.ref))), 0.5),
    unemployment: quantile(asc(placed.map((b) => b.census!.unemployment)), 0.5),
  };
  for (const [k, v] of Object.entries(median)) {
    if (k !== "coolingDemand" && !(v > 0)) throw new IndexInputError(`median ${k} is ${v}; ratios to it are undefined`);
  }
  const partial = {
    method, buildings: buildings.length, coolingCap, median, coolingPrior,
    ...(coolingCredibility ? { coolingCredibility } : {}),
    peoplePrior: { low: 0, mid: 0, high: 0 },
  };
  median.coolingDemand = quantile(asc(buildings.map((b) => coolingRange(b, partial).mid)), 0.5);
  if (!(median.coolingDemand > 0)) throw new IndexInputError(`median coolingDemand is ${median.coolingDemand}`);
  const peoplePrior = range(placed.map((b) => peoplePoint(b.census!, b.ref, partial)), method);
  return { ...partial, peoplePrior };
}

function coolingRange(
  b: BuildingInputs,
  r: Pick<References, "coolingPrior" | "coolingCap" | "coolingCredibility">,
): Range & { coverage: number; weight: number; prior: AgeBand | "all"; capped: boolean } {
  const band = ageBand(b.year);
  const key: AgeBand | "all" = band ?? "all";
  const p = r.coolingPrior[key];
  if (b.certificate === null) return { low: p.low, mid: p.mid, high: p.high, coverage: 0, weight: 0, prior: key, capped: false };
  const c = b.certificate;
  if (!(c.entries > 0) || !(c.min <= c.median && c.median <= c.max)) {
    throw new IndexInputError(`${b.ref}: certificate summary is inconsistent`);
  }
  if (!(b.dwellings > 0)) throw new IndexInputError(`${b.ref}: dwellings must be positive`);
  const coverage = Math.min(1, c.entries / b.dwellings);
  let w = coverage;
  if (r.coolingCredibility) {
    const cred = r.coolingCredibility[key];
    if (!cred) throw new IndexInputError(`${b.ref}: band ${key} has no credibility estimate`);
    w = coverage * (c.entries / (c.entries + cred.k));
  }
  // Capping commutes with min, median and max: they are order statistics.
  const cap = (v: number) => Math.min(v, r.coolingCap.value);
  return {
    low: w * cap(c.min) + (1 - w) * p.low,
    mid: w * cap(c.median) + (1 - w) * p.mid,
    high: w * cap(c.max) + (1 - w) * p.high,
    coverage,
    weight: w,
    prior: key,
    capped: c.max > r.coolingCap.value,
  };
}

function peoplePoint(c: NonNullable<BuildingInputs["census"]>, ref: string, r: Pick<References, "median">): number {
  const m = r.median;
  return (c.over64 / m.over64 + onePersonShare(c, ref) / m.onePersonShare + c.unemployment / m.unemployment) / 3;
}

export interface Score {
  readonly ref: string;
  readonly method: string;
  readonly factors: {
    readonly hazard: Range;
    readonly exposure: Range;
    readonly sensitivity: Range;
    readonly people: Range;
  };
  readonly index: Range;
  readonly completeness: {
    /** Share of the building's dwellings evidenced by a certificate (0–1). */
    readonly certificateCoverage: number;
    /**
     * Weight the building's own entries carry against its age band (0–1):
     * the coverage in v1; coverage × entries / (entries + k) in v2. Kept apart
     * from the coverage, which the page shows as a share of dwellings.
     */
    readonly certificateWeight: number;
    /** Which cooling prior filled the rest. */
    readonly coolingPrior: AgeBand | "all";
    /** True when at least one of its certificates was above the cap. */
    readonly certificateCapped: boolean;
    readonly censusSection: boolean;
    readonly constructionYear: boolean;
  };
}

const point = (v: number): Range => ({ low: v, mid: v, high: v });

export function scoreBuilding(b: BuildingInputs, r: References): Score {
  const m = r.median;
  const w = r.method.weights;
  if (!(b.hsolHorizontal > 0)) throw new IndexInputError(`${b.ref}: horizontal irradiation must be positive`);
  const hazard = point(b.hsolHorizontal / m.hsolHorizontal);
  const exposure = point((1 + facadeTerm(b) / m.facadeIrradiationPerMetre) / 2);
  const cool = coolingRange(b, r);
  const sensitivity = { low: cool.low / m.coolingDemand, mid: cool.mid / m.coolingDemand, high: cool.high / m.coolingDemand };
  const people = b.census ? point(peoplePoint(b.census, b.ref, r)) : r.peoplePrior;
  const at = (k: "low" | "mid" | "high") => {
    const parts: [number, number][] = [
      [hazard[k], w.hazard],
      [exposure[k], w.exposure],
      [sensitivity[k], w.sensitivity],
      [people[k], w.people],
    ];
    for (const [v] of parts) if (!(v > 0)) throw new IndexInputError(`${b.ref}: a factor is ${v}; the geometric mean needs > 0`);
    const total = parts.reduce((s, [, wt]) => s + wt, 0);
    return Math.exp(parts.reduce((s, [v, wt]) => s + wt * Math.log(v), 0) / total);
  };
  return {
    ref: b.ref,
    method: r.method.version,
    factors: { hazard, exposure, sensitivity, people },
    index: { low: at("low"), mid: at("mid"), high: at("high") },
    completeness: {
      certificateCoverage: cool.coverage,
      certificateWeight: cool.weight,
      coolingPrior: cool.prior,
      certificateCapped: cool.capped,
      censusSection: b.census !== null,
      constructionYear: b.year !== null,
    },
  };
}
