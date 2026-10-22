import { describe, expect, it } from "vitest";
import {
  IndexInputError,
  METHOD_V1,
  METHOD_V2,
  ageBand,
  buhlmannStraub,
  computeReferences,
  quantile,
  scoreBuilding,
  type BuildingInputs,
  type References,
} from "./heat-index";
import { entryValues, type CertificateRow } from "./db/index-db";

const census = { over64: 0.2, onePersonHouseholds: 25, households: 100, unemployment: 0.2 };
const base: BuildingInputs = {
  ref: "X",
  dwellings: 1,
  year: 1960,
  hsolHorizontal: 235.31,
  streetKwhPerMetre: 1000,
  perimeterM: 40,
  certificate: null,
  census,
};

/** A small municipality whose medians are easy to read off. */
const town: BuildingInputs[] = [
  { ...base, ref: "A", certificate: { entries: 1, median: 20, min: 20, max: 20 } },
  { ...base, ref: "B", certificate: { entries: 1, median: 30, min: 30, max: 30 } },
  { ...base, ref: "C", certificate: { entries: 1, median: 40, min: 40, max: 40 } },
  { ...base, ref: "D", year: 1990, certificate: { entries: 1, median: 25, min: 25, max: 25 } },
  { ...base, ref: "E" },
];

/**
 * Certificate values for the cap. The 1,000 puts the cap (p99 ≈ 961.6) far
 * above every value these tests use, so only the cap's own tests see it bind.
 */
const VALUES = [20, 30, 40, 25, 1000];

describe("ageBand — thermal-regulation eras", () => {
  it("splits at NBE-CT-79 (1980) and CTE DB-HE (2007)", () => {
    expect([1979, 1980, 2006, 2007, null].map(ageBand)).toEqual(["pre-1980", "1980-2006", "1980-2006", "2007-on", null]);
  });
});

describe("quantile — type 7", () => {
  it("interpolates linearly between order statistics", () => {
    expect(quantile([20, 30, 40], 0.5)).toBe(30);
    expect(quantile([20, 30, 40], 0.1)).toBeCloseTo(22, 10);
    expect(quantile([20, 30, 40], 0.9)).toBeCloseTo(38, 10);
    expect(() => quantile([], 0.5)).toThrow(IndexInputError);
  });
});

describe("computeReferences", () => {
  const r = computeReferences(town, VALUES, METHOD_V1);

  it("builds the cooling prior from certified buildings, by age band", () => {
    expect(r.coolingPrior["pre-1980"]).toMatchObject({ low: 22, mid: 30, high: 38, n: 3 });
    expect(r.coolingPrior["1980-2006"]).toMatchObject({ low: 25, mid: 25, high: 25, n: 1 });
    // No certified 2007-on building: that band is the all-buildings prior, flagged n = 0.
    expect(r.coolingPrior["2007-on"].n).toBe(0);
    expect(r.coolingPrior["2007-on"].mid).toBe(r.coolingPrior.all.mid);
  });

  it("medians: E (uncertified, pre-1980) sits at its band's median, 30", () => {
    expect(r.median.coolingDemand).toBe(30); // [20, 25, 30, 30, 40]
    expect(r.median.hsolHorizontal).toBe(235.31);
    expect(r.median.facadeIrradiationPerMetre).toBe(25);
  });

  it("refuses a municipality with no certified building or no census", () => {
    expect(() => computeReferences([{ ...base }], [], METHOD_V1)).toThrow(/no certified/);
    expect(() => computeReferences([{ ...base, census: null, certificate: { entries: 1, median: 1, min: 1, max: 1 } }], [1], METHOD_V1)).toThrow(/census/);
  });
});

describe("the certificate cap — a data-entry error cannot carry a building to the top", () => {
  // 100 certificates 1..100 → p99 (type 7) = 99.01.
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  const r = computeReferences(town, values, METHOD_V1);

  it("is the 99th percentile of every certificate value", () => {
    expect(r.coolingCap).toEqual({ value: expect.closeTo(99.01, 9), certificates: 100 });
  });

  it("a 1,592 kWh/m² certificate counts as the cap, and is flagged", () => {
    const wild = scoreBuilding({ ...base, ref: "W", dwellings: 16, certificate: { entries: 5, median: 16.37, min: 15.85, max: 1592.18 } }, r);
    const atCap = scoreBuilding({ ...base, ref: "K", dwellings: 16, certificate: { entries: 5, median: 16.37, min: 15.85, max: r.coolingCap.value } }, r);
    expect(wild.index.high).toBeCloseTo(atCap.index.high, 12);
    expect(wild.completeness.certificateCapped).toBe(true);
    expect(atCap.completeness.certificateCapped).toBe(false);
  });
});

describe("scoreBuilding", () => {
  const r = computeReferences(town, VALUES, METHOD_V1);

  it("a typical building scores 1.0 with every factor at 1", () => {
    const s = scoreBuilding({ ...base, ref: "T", certificate: { entries: 1, median: 30, min: 30, max: 30 } }, r);
    for (const f of Object.values(s.factors)) expect(f.mid).toBeCloseTo(1, 12);
    expect(s.index).toEqual({ low: expect.closeTo(1, 12), mid: expect.closeTo(1, 12), high: expect.closeTo(1, 12) });
  });

  it("weights are risk thirds: doubling cooling demand multiplies the index by 2^(1/3)", () => {
    const s = scoreBuilding({ ...base, ref: "T", certificate: { entries: 1, median: 60, min: 60, max: 60 } }, r);
    expect(s.index.mid).toBeCloseTo(2 ** (1 / 3), 12);
    expect(METHOD_V1.weights).toEqual({ hazard: 1 / 6, exposure: 1 / 6, sensitivity: 1 / 3, people: 1 / 3 });
  });

  it("exposure is half roof (constant) and half façade: no exposed façade gives 0.5, not 0", () => {
    const s = scoreBuilding({ ...base, ref: "T", streetKwhPerMetre: 0 }, r);
    expect(s.factors.exposure.mid).toBe(0.5);
    expect(s.index.mid).toBeGreaterThan(0);
  });

  it("a fully certified dwelling has a zero-width cooling band", () => {
    const s = scoreBuilding(town[0], r);
    expect(s.factors.sensitivity.low).toBe(s.factors.sensitivity.high);
    expect(s.completeness.certificateCoverage).toBe(1);
  });

  it("an uncertified building carries its age band's p10–p90", () => {
    const s = scoreBuilding(town[4], r);
    expect(s.factors.sensitivity).toEqual({ low: 22 / 30, mid: 1, high: 38 / 30 });
    expect(s.completeness).toMatchObject({ certificateCoverage: 0, coolingPrior: "pre-1980" });
  });

  it("one certified unit of four narrows the band by a quarter, not to a point", () => {
    const s = scoreBuilding({ ...base, ref: "T", dwellings: 4, certificate: { entries: 1, median: 40, min: 40, max: 40 } }, r);
    const lowKwh = 0.25 * 40 + 0.75 * 22;
    const highKwh = 0.25 * 40 + 0.75 * 38;
    expect(s.factors.sensitivity.low).toBeCloseTo(lowKwh / 30, 12);
    expect(s.factors.sensitivity.high).toBeCloseTo(highKwh / 30, 12);
    expect(s.completeness.certificateCoverage).toBe(0.25);
  });

  it("no census section: people takes the municipal p10–p90, and says so", () => {
    const s = scoreBuilding({ ...town[4], census: null }, r);
    expect(s.factors.people).toEqual(r.peoplePrior);
    expect(s.completeness.censusSection).toBe(false);
  });

  it("no year and no certificate: the all-buildings prior", () => {
    const s = scoreBuilding({ ...town[4], year: null }, r);
    expect(s.completeness.coolingPrior).toBe("all");
    expect(s.completeness.constructionYear).toBe(false);
  });

  it("low ≤ mid ≤ high for every building", () => {
    for (const b of [...town, { ...town[4], census: null, year: null }]) {
      const s = scoreBuilding(b, r);
      expect(s.index.low).toBeLessThanOrEqual(s.index.mid);
      expect(s.index.mid).toBeLessThanOrEqual(s.index.high);
    }
  });

  it("refuses inputs that cannot be scored rather than defaulting them", () => {
    expect(() => scoreBuilding({ ...base, perimeterM: 0 }, r)).toThrow(IndexInputError);
    expect(() => scoreBuilding({ ...base, certificate: { entries: 1, median: 50, min: 60, max: 70 } }, r)).toThrow(IndexInputError);
    expect(() => scoreBuilding({ ...base, dwellings: 0, certificate: { entries: 1, median: 30, min: 30, max: 30 } }, r)).toThrow(IndexInputError);
  });

  it("never names itself a grade, a rating or a compliance result (P7)", () => {
    const text = JSON.stringify(scoreBuilding(town[0], r)) + JSON.stringify(METHOD_V1);
    expect(text).not.toMatch(/grade|rating|compliance/i);
  });
});

// ── H3-INDEX-V2 ───────────────────────────────────────────────────────────

describe("Bühlmann–Straub — k measured, not chosen", () => {
  it("matches a hand-computed three-building example exactly", () => {
    // A: 10, 20 · B: 30 · C: 40, 50, 60. Means 15, 30, 50; n-weighted mean 35.
    // EPV = (25 + 25 + 0 + 100 + 0 + 100) / (1 + 0 + 2) = 250/3
    // VHM = [2·400 + 1·25 + 3·225 − 2·250/3] / (6 − 14/6) = (4000/3) / (11/3) = 4000/11
    // k   = (250/3) / (4000/11) = 11/48
    const c = buhlmannStraub([[10, 20], [30], [40, 50, 60]]);
    expect(c.epv).toBeCloseTo(250 / 3, 12);
    expect(c.vhm).toBeCloseTo(4000 / 11, 12);
    expect(c.k).toBeCloseTo(11 / 48, 12);
    expect(c).toMatchObject({ buildings: 3, entries: 6 });
  });

  it("refuses VHM ≤ 0 rather than defaulting k", () => {
    // Both buildings average 20: no between-building variance.
    expect(() => buhlmannStraub([[10, 30], [20, 20]])).toThrow(IndexInputError);
    expect(() => buhlmannStraub([[10, 30], [20, 20]])).toThrow(/between-building variance/);
  });

  it("refuses a band in which no building has two entries", () => {
    expect(() => buhlmannStraub([[10], [20], [30]])).toThrow(/two or more entries/);
  });
});

/** Pre-1980 buildings with repeat entries, so k is defined in that band and in all. */
const v2town: BuildingInputs[] = [
  { ...base, ref: "A", dwellings: 2, certificate: { entries: 2, median: 15, min: 10, max: 20, values: [10, 20] } },
  { ...base, ref: "B", certificate: { entries: 1, median: 30, min: 30, max: 30, values: [30] } },
  { ...base, ref: "C", dwellings: 3, certificate: { entries: 3, median: 50, min: 40, max: 60, values: [40, 50, 60] } },
  { ...base, ref: "E" },
];
const V2VALUES = [10, 20, 30, 40, 50, 60, 1000];

describe("METHOD_V2 — one certificate no longer replaces the age estimate", () => {
  const r = computeReferences(v2town, V2VALUES, METHOD_V2);
  const k = r.coolingCredibility!["pre-1980"]!.k;

  it("records k, EPV, VHM, buildings and entries per band with the run", () => {
    expect(r.method.version).toBe("h3-index-v2");
    expect(r.coolingCredibility!["pre-1980"]).toEqual(buhlmannStraub([[10, 20], [30], [40, 50, 60]]));
    expect(r.coolingCredibility!.all).toEqual(r.coolingCredibility!["pre-1980"]);
    // No certified building in these bands: no estimate, and no building uses one.
    expect(r.coolingCredibility!["1980-2006"]).toBeNull();
    expect(r.coolingCredibility!["2007-on"]).toBeNull();
  });

  it("one entry on one dwelling weighs 1/(1+k), not 1", () => {
    const s = scoreBuilding({ ...base, ref: "T", certificate: { entries: 1, median: 60, min: 60, max: 60, values: [60] } }, r);
    expect(k).toBeGreaterThan(0);
    expect(s.completeness.certificateWeight).toBeCloseTo(1 / (1 + k), 12);
    expect(s.completeness.certificateWeight).toBeLessThan(1);
    // The page shows coverage as a share of dwellings: still 100 % of one dwelling.
    expect(s.completeness.certificateCoverage).toBe(1);
    // The band no longer collapses to a point.
    expect(s.factors.sensitivity.high).toBeGreaterThan(s.factors.sensitivity.low);
    const p = r.coolingPrior["pre-1980"];
    const w = 1 / (1 + k);
    expect(s.factors.sensitivity.high * r.median.coolingDemand).toBeCloseTo(w * 60 + (1 - w) * p.high, 9);
  });

  it("weight is coverage × entries/(entries + k)", () => {
    const s = scoreBuilding({ ...base, ref: "T", dwellings: 4, certificate: { entries: 2, median: 30, min: 25, max: 35, values: [25, 35] } }, r);
    expect(s.completeness.certificateWeight).toBeCloseTo(0.5 * (2 / (2 + k)), 12);
    expect(s.completeness.certificateCoverage).toBe(0.5);
  });

  it("k → 0 reproduces v1 exactly", () => {
    const r1 = computeReferences(v2town, V2VALUES, METHOD_V1);
    const zero = { k: 0, epv: 0, vhm: 1, buildings: 0, entries: 0 };
    const r0: References = { ...r1, coolingCredibility: { all: zero, "pre-1980": zero, "1980-2006": zero, "2007-on": zero } };
    for (const b of [...v2town, { ...base, ref: "T", dwellings: 5, certificate: { entries: 2, median: 22, min: 18, max: 26, values: [18, 26] } }]) {
      expect(scoreBuilding(b, r0).index, b.ref).toEqual(scoreBuilding(b, r1).index);
    }
  });

  it("caps each entry before estimation", () => {
    // 100 certificates 1..100 → cap 99.01; C's 600 enters the estimate as 99.01.
    const capped = computeReferences(
      [...v2town.slice(0, 2), { ...v2town[2], certificate: { entries: 3, median: 50, min: 40, max: 600, values: [40, 50, 600] } }, v2town[3]],
      Array.from({ length: 100 }, (_, i) => i + 1),
      METHOD_V2,
    );
    const cap = capped.coolingCap.value;
    expect(capped.coolingCredibility!["pre-1980"]).toEqual(buhlmannStraub([[10, 20], [30], [40, 50, cap]]));
    // Uncapped, the one 600 inflates the within-building variance past the between-building spread.
    expect(() => buhlmannStraub([[10, 20], [30], [40, 50, 600]])).toThrow(/between-building variance/);
  });

  it("refuses a band where k is undefined, rather than defaulting it", () => {
    const single = v2town.map((b) =>
      b.certificate
        ? { ...b, dwellings: 1, certificate: { entries: 1, median: b.certificate.min, min: b.certificate.min, max: b.certificate.min, values: [b.certificate.min] } }
        : b,
    );
    expect(() => computeReferences(single, V2VALUES, METHOD_V2)).toThrow(IndexInputError);
    expect(() => computeReferences(single, V2VALUES, METHOD_V2)).toThrow(/band all: no building has two or more entries/);
    const flat: BuildingInputs[] = [
      { ...base, ref: "A", dwellings: 2, certificate: { entries: 2, median: 20, min: 10, max: 30, values: [10, 30] } },
      { ...base, ref: "B", dwellings: 2, certificate: { entries: 2, median: 20, min: 20, max: 20, values: [20, 20] } },
    ];
    expect(() => computeReferences(flat, [10, 30, 20, 20], METHOD_V2)).toThrow(/between-building variance/);
  });

  it("refuses a certified building without its entry values", () => {
    const bare: BuildingInputs = { ...base, ref: "Z", certificate: { entries: 1, median: 30, min: 30, max: 30 } };
    expect(() => computeReferences([...v2town, bare], V2VALUES, METHOD_V2)).toThrow(/value of each certificate entry/);
  });

  it("low ≤ mid ≤ high for every building", () => {
    const extra: BuildingInputs[] = [
      { ...v2town[3], census: null, year: null },
      { ...base, ref: "T", certificate: { entries: 1, median: 5, min: 5, max: 5, values: [5] } },
    ];
    for (const b of [...v2town, ...extra]) {
      const s = scoreBuilding(b, r);
      expect(s.index.low, b.ref).toBeLessThanOrEqual(s.index.mid);
      expect(s.index.mid, b.ref).toBeLessThanOrEqual(s.index.high);
    }
  });

  it("never names itself a grade, a rating or a compliance result (P7)", () => {
    const text = JSON.stringify(scoreBuilding(v2town[0], r)) + JSON.stringify(METHOD_V2) + JSON.stringify(r);
    expect(text).not.toMatch(/grade|rating|compliance/i);
  });
});

describe("METHOD_V1 stays reproducible (pinned at a5c3df2)", () => {
  // Computed by the v1 code at a5c3df2 on this town, before v2 existed.
  const pinTown: BuildingInputs[] = [
    ...town,
    {
      ...base, ref: "F", dwellings: 4, streetKwhPerMetre: 1500,
      census: { over64: 0.3, onePersonHouseholds: 40, households: 100, unemployment: 0.1 },
      certificate: { entries: 3, median: 33, min: 21, max: 52 },
    },
  ];
  const PIN: Record<string, number[]> = {
    A: [0.8664196470521208, 0.8664196470521208, 0.8664196470521208],
    B: [0.9918029100085936, 0.9918029100085936, 0.9918029100085936],
    C: [1.0916203513634535, 1.0916203513634535, 1.0916203513634535],
    D: [0.933322271867135, 0.933322271867135, 0.933322271867135],
    E: [0.9077388128791728, 1.0080648644111045, 1.0721725808377363],
    F: [0.9789109746648709, 1.1248999157792878, 1.2836195316486076],
  };

  it("scores every building exactly as before", () => {
    const r = computeReferences(pinTown, [20, 30, 40, 25, 1000, 21, 33, 52], METHOD_V1);
    for (const b of pinTown) {
      const s = scoreBuilding(b, r);
      expect([s.index.low, s.index.mid, s.index.high], b.ref).toEqual(PIN[b.ref]);
      expect(s.completeness.certificateWeight).toBe(s.completeness.certificateCoverage);
    }
    expect(r.coolingCredibility).toBeUndefined();
    expect(METHOD_V1).toEqual({
      version: "h3-index-v1",
      weights: { hazard: 1 / 6, exposure: 1 / 6, sensitivity: 1 / 3, people: 1 / 3 },
      bandQuantiles: { low: 0.1, high: 0.9 },
      certificateCapQuantile: 0.99,
    });
  });
});

describe("entry values — entries, not certificates (the epc/summary.ts rule, reused)", () => {
  const row = (unit: string | null, date: string, demand: string | null): CertificateRow => ({
    ref: "2642106UG4924S", unit_ref: unit, cert_date: date, date_valid: true, cooling_demand: demand,
  });

  it("a unit certified twice counts once, as its latest", () => {
    const m = entryValues([
      row("2642106UG4924S0001AB", "2019-03-01", "41"),
      row("2642106UG4924S0001AB", "2024-05-02", "29"),
      row("2642106UG4924S0002BC", "2020-01-01", "33"),
    ]);
    expect(m.get("2642106UG4924S")).toEqual({ entries: 2, values: [29, 33] });
  });

  it("parcel-wide certificates count as one more entry; an entry without a demand is counted, not valued", () => {
    const m = entryValues([row(null, "2015-01-01", "20"), row(null, "2021-01-01", "24"), row("2642106UG4924S0001AB", "2022-01-01", null)]);
    expect(m.get("2642106UG4924S")).toEqual({ entries: 2, values: [24] });
  });
});
