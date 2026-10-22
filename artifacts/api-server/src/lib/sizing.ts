/**
 * PV and battery sizing — H-OPT.
 *
 * The whole point of this module is that it is the ONLY thing that decides how
 * big an array or a battery should be. Before it existed, `/api/optimize` asked
 * a language model, which answered from its priors: ~5.5 kWh/m2/day of
 * irradiance for Tetouan where NASA POWER gives 5.08, ~4.5 for Fuengirola where
 * NASA gives 5.05, and a 20-30 kW array against a load nobody had measured.
 * That is a P3 violation ("LLMs explain, never compute") and a P1 violation (a
 * displayed number originating in a model response) in one route.
 *
 * Pure and import-free, deliberately:
 *
 *   - no `routes.ts`, so the caller passes the hourly solar profile in rather
 *     than this module keeping a second copy of it (P5, and it avoids a cycle);
 *   - no Zod and no schema, so the arithmetic is testable without a server;
 *   - no clock, no environment, no randomness. Same inputs, same numbers,
 *     forever. That is what makes the mutation test in Gate H-OPT meaningful.
 *
 * Every failure is typed and returned. Nothing here substitutes a default for a
 * value it was not given — G5, and the reason `|| 4.0` cost this project two
 * days.
 */
import { serverT, type Locale } from "../i18n";


/**
 * The four assumptions, all dimensionless ratios in (0, 1].
 *
 * `performanceRatio` — everything between the irradiance on the panel and the
 * kWh at the meter: inverter losses, cable losses, soiling, temperature
 * derating, mismatch. 0.80 is the ordinary figure for a well-installed
 * residential roof.
 *
 * `roundTripEfficiency` — kWh out per kWh in, over a full charge/discharge
 * cycle. 0.90 for current residential lithium.
 *
 * `usableDepthOfDischarge` — the fraction of nameplate capacity the system will
 * actually cycle. 0.80 keeps a reserve rather than pretending a pack is usable
 * to zero.
 *
 * `coverageTarget` — how much of the annual load the array is sized to produce
 * over a year. 1.00: annual generation equals annual consumption.
 *
 * On 1.00, stated here because the number is easy to over-read. It is ANNUAL
 * ENERGY PARITY. It is not 100% self-consumption, not off-grid autonomy, and
 * not a promise that grid import is zero — generation and load are offset in
 * time, which is what the battery term below is for and what `simulate8760()`
 * on the calculate path actually measures. It is a definition rather than an
 * estimate, which is exactly why it was chosen: any other target smuggles in a
 * claim about tariffs or export pricing that this module does not compute and
 * cannot cite (P1). The value travels in the result so the response can say
 * which target produced the figure, and it is never a grade or a rating (P7).
 */
export const SIZING_DEFAULTS = {
  performanceRatio: 0.8,
  roundTripEfficiency: 0.9,
  usableDepthOfDischarge: 0.8,
  coverageTarget: 1.0,
} as const;

/**
 * Days used to turn an annual figure into a daily one.
 *
 * Named rather than inlined so that it is a stated assumption and not a magic
 * 365 buried in a division. Leap years move this by 0.07%, well inside the
 * spread of the irradiance mean it is divided by.
 */
export const DAYS_PER_YEAR = 365;

export type SizingAssumptions = {
  performanceRatio: number;
  roundTripEfficiency: number;
  usableDepthOfDischarge: number;
  coverageTarget: number;
};

export type SizingInputs = {
  /** Metered annual consumption, kWh/year. Never defaulted — G5. */
  annualUsageKwh: number;
  /**
   * 24 relative weights describing WHEN the load happens. A shape, not a
   * magnitude: it is normalised to sum 1 before use, so [2,2,...] and
   * [200,200,...] size identically. Reading this array as kWh is the defect
   * this block removes — the web client's fixed profile sums to 102, and the
   * old prompt called it "24h Energy Pattern (kWh)".
   */
  hourlyLoadShape: number[];
  /**
   * 24 relative weights describing when the ARRAY produces. Supplied by the
   * caller so there is one profile in the codebase rather than two. The hours
   * where this is exactly zero are the hours the battery has to carry.
   */
  hourlySolarShape: number[];
  /** Mean daily irradiance, kWh/m2/day, from the NASA parse boundary. */
  irradianceKwhM2Day: number;
  /** Overrides for the four assumptions. Absent means the documented default. */
  assumptions?: Partial<SizingAssumptions>;
};

export type SizingFailure =
  | { kind: "non-positive-usage"; annualUsageKwh: number }
  | { kind: "non-positive-irradiance"; irradianceKwhM2Day: number }
  | {
      kind: "bad-shape";
      which: "load" | "solar";
      reason: "length" | "non-finite" | "negative" | "zero-sum";
    }
  | { kind: "bad-assumption"; name: keyof SizingAssumptions; value: number }
  | { kind: "no-dark-hours" };

export type Sizing = {
  /** The recommendation. kWp is DC nameplate; watts is the same number. */
  pvKwp: number;
  pvWatts: number;
  batteryKwh: number;

  /** What it was computed from, so the response can show its own inputs. */
  annualUsageKwh: number;
  dailyUsageKwh: number;
  nightUsageKwh: number;
  nightShare: number;
  darkHours: number;
  irradianceKwhM2Day: number;

  /** Under which assumptions. */
  coverageTarget: number;
  performanceRatio: number;
  roundTripEfficiency: number;
  usableDepthOfDischarge: number;
  daysPerYear: number;
};

export type SizingResult =
  | { ok: true; sizing: Sizing }
  | { ok: false; failure: SizingFailure };

const HOURS_PER_DAY = 24;

/** Round to a fixed number of decimals without the float tail. */
function round(value: number, decimals: number): number {
  return parseFloat(value.toFixed(decimals));
}

/** A ratio has to be a finite number in (0, 1]. Zero would divide by zero. */
function badRatio(value: number): boolean {
  return !Number.isFinite(value) || value <= 0 || value > 1;
}

function checkShape(
  shape: number[],
  which: "load" | "solar",
): SizingFailure | null {
  if (shape.length !== HOURS_PER_DAY) {
    return { kind: "bad-shape", which, reason: "length" };
  }
  for (const v of shape) {
    if (!Number.isFinite(v)) return { kind: "bad-shape", which, reason: "non-finite" };
    if (v < 0) return { kind: "bad-shape", which, reason: "negative" };
  }
  const sum = shape.reduce((a, b) => a + b, 0);
  // A shape that sums to zero carries no information about when anything
  // happens, and normalising it would be 0/0. Rejected rather than smoothed
  // into a flat profile, which would be an invented answer.
  if (sum <= 0) return { kind: "bad-shape", which, reason: "zero-sum" };
  return null;
}

/**
 * Size an array and a battery for one location and one household.
 *
 *   PV_kWp      = (coverage x daily_kWh / performance_ratio) / irradiance
 *   Battery_kWh = (night_kWh / round_trip_eff) / usable_DoD
 *
 * `daily_kWh` is the metered annual usage divided by the year — never the sum
 * of the hourly shape, which is a set of weights and has no units.
 *
 * `night_kWh` is the share of that daily load falling in the hours the supplied
 * solar profile is exactly zero. Defining night from the profile rather than
 * from a constant means the battery figure moves if the profile ever moves,
 * and it means "night" here is a property of the model in use rather than an
 * opinion about when it gets dark.
 *
 * The coverage target multiplies the PV load and NOT the battery load. Sizing
 * an array to a fraction of the year's consumption does not make the night
 * shorter; the battery still has to carry the night it is asked to carry. At
 * the default coverage of 1.00 the distinction changes no number, which is
 * exactly when it is cheap to get right.
 */
export function sizePvAndBattery(inputs: SizingInputs): SizingResult {
  const assumptions: SizingAssumptions = {
    ...SIZING_DEFAULTS,
    ...inputs.assumptions,
  };

  for (const name of Object.keys(SIZING_DEFAULTS) as (keyof SizingAssumptions)[]) {
    const value = assumptions[name];
    if (badRatio(value)) {
      return { ok: false, failure: { kind: "bad-assumption", name, value } };
    }
  }

  if (!Number.isFinite(inputs.annualUsageKwh) || inputs.annualUsageKwh <= 0) {
    return {
      ok: false,
      failure: { kind: "non-positive-usage", annualUsageKwh: inputs.annualUsageKwh },
    };
  }

  // Zero irradiance is a division by zero and a negative one is not a reading.
  // The parse boundary in routes.ts already rejects the -999 fill value, so
  // this guard is the second line rather than the first — but a sizing function
  // that trusts its caller to have guarded is a sizing function that will one
  // day be called by something else.
  if (!Number.isFinite(inputs.irradianceKwhM2Day) || inputs.irradianceKwhM2Day <= 0) {
    return {
      ok: false,
      failure: {
        kind: "non-positive-irradiance",
        irradianceKwhM2Day: inputs.irradianceKwhM2Day,
      },
    };
  }

  const loadBad = checkShape(inputs.hourlyLoadShape, "load");
  if (loadBad) return { ok: false, failure: loadBad };
  const solarBad = checkShape(inputs.hourlySolarShape, "solar");
  if (solarBad) return { ok: false, failure: solarBad };

  const loadSum = inputs.hourlyLoadShape.reduce((a, b) => a + b, 0);
  const darkHourIndexes: number[] = [];
  for (let h = 0; h < HOURS_PER_DAY; h++) {
    if (inputs.hourlySolarShape[h] === 0) darkHourIndexes.push(h);
  }

  // A profile that never reaches zero has no night, so there is nothing for a
  // battery to carry and no honest figure to return. Typed error, not 0 kWh:
  // "you need no battery" is a claim, and this is not the input that supports
  // it.
  if (darkHourIndexes.length === 0) {
    return { ok: false, failure: { kind: "no-dark-hours" } };
  }

  const nightWeight = darkHourIndexes.reduce(
    (a, h) => a + inputs.hourlyLoadShape[h],
    0,
  );
  const nightShare = nightWeight / loadSum;

  const dailyUsageKwh = inputs.annualUsageKwh / DAYS_PER_YEAR;
  const nightUsageKwh = dailyUsageKwh * nightShare;

  const pvKwpRaw =
    (assumptions.coverageTarget * dailyUsageKwh) /
    assumptions.performanceRatio /
    inputs.irradianceKwhM2Day;

  const batteryKwhRaw =
    nightUsageKwh / assumptions.roundTripEfficiency / assumptions.usableDepthOfDischarge;

  // kWp to three decimals is whole watts, so the two PV fields are the same
  // number rather than two roundings of it.
  const pvKwp = round(pvKwpRaw, 3);

  return {
    ok: true,
    sizing: {
      pvKwp,
      pvWatts: Math.round(pvKwp * 1000),
      batteryKwh: round(batteryKwhRaw, 2),

      annualUsageKwh: inputs.annualUsageKwh,
      dailyUsageKwh: round(dailyUsageKwh, 3),
      nightUsageKwh: round(nightUsageKwh, 3),
      nightShare: round(nightShare, 4),
      darkHours: darkHourIndexes.length,
      irradianceKwhM2Day: inputs.irradianceKwhM2Day,

      coverageTarget: assumptions.coverageTarget,
      performanceRatio: assumptions.performanceRatio,
      roundTripEfficiency: assumptions.roundTripEfficiency,
      usableDepthOfDischarge: assumptions.usableDepthOfDischarge,
      daysPerYear: DAYS_PER_YEAR,
    },
  };
}

/** Why a sizing failed, in one line a person can read. */
export function sizingFailureMessage(failure: SizingFailure, locale: Locale): string {
  // H2b: worded from the server catalog in the request's language. The
  // values echoed back are the request's own, printed raw in both languages.
  const t = serverT(locale);
  switch (failure.kind) {
    case "non-positive-usage":
      return t("sizing.nonPositiveUsage", { value: String(failure.annualUsageKwh) });
    case "non-positive-irradiance":
      return t("sizing.nonPositiveIrradiance", { value: String(failure.irradianceKwhM2Day) });
    case "bad-shape":
      return t("sizing.badShape", { which: failure.which, reason: failure.reason });
    case "bad-assumption":
      return t("sizing.badAssumption", { name: failure.name, value: String(failure.value) });
    case "no-dark-hours":
      return t("sizing.noDarkHours");
  }
}
