import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "../storage";
import { api, monthlyEntrySchema } from "../shared-routes";
import { z } from "zod/v4";
import { registerChatRoutes } from "../replit_integrations/chat";
import { pool } from "../db";
import { createScreeningRouter } from "./screening";
import { getLlmClient, llmModel } from "../lib/llm";
import PDFDocument from "pdfkit";
import rateLimit from "express-rate-limit";
import {
  parseOptimizePayload,
  renderOptimizeFacts,
  type OptimizeFacts,
} from "./optimize-payload";
import { sizePvAndBattery, sizingFailureMessage } from "../lib/sizing";
import { type MonthlyEntry } from "@workspace/db";
import {
  resolveCarbonSource,
  carbonIntensityKgPerKwh,
  type CarbonSourceNote,
} from "../lib/emissions/carbon-source";
import { findCountry, formatMoney, ROI_YEARS, type Currency } from "../lib/emissions/countries";
import { describeSaving, resolveMoney } from "../lib/emissions/money";
import { formatDate, formatNumber, monthName, requestLocale, serverT, type Locale } from "../i18n";

// Provider, endpoint and model live in ../lib/llm, env-driven. The accessor
// stays lazy: a missing key fails the AI request, not the server boot.

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];

// Typical residential monthly weight (normalised, sum=1)
const MONTHLY_CONSUMPTION_WEIGHTS = [
  0.103, 0.094, 0.091, 0.082, 0.076, 0.072,
  0.074, 0.076, 0.079, 0.086, 0.093, 0.094,
];

// Hourly solar production profile (fraction of daily output)
const SOLAR_HOURLY_PROFILE: number[] = (() => {
  const raw = Array.from({ length: 24 }, (_, h) => {
    if (h < 6 || h > 20) return 0;
    return Math.exp(-0.5 * Math.pow((h - 12) / 3.5, 2));
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
})();

// Hourly consumption profile (fraction of daily consumption)
const CONSUMPTION_HOURLY_PROFILE = [
  0.024, 0.020, 0.018, 0.017, 0.018, 0.025,
  0.045, 0.060, 0.055, 0.045, 0.042, 0.040,
  0.042, 0.040, 0.042, 0.048, 0.058, 0.075,
  0.082, 0.072, 0.058, 0.048, 0.040, 0.034,
];

// ML consumption prediction: [month,hour,irradiance,temp] → kWh
function mlPredictConsumption(month: number, hour: number, irradiance: number, temp: number): number {
  const seasonFactor = 1 + 0.25 * Math.cos((month * Math.PI) / 6);
  const hourFactor = CONSUMPTION_HOURLY_PROFILE[hour] * 24;
  const tempEffect = 1 + 0.012 * Math.max(0, 25 - temp) + 0.010 * Math.max(0, temp - 28);
  const lightingReduction = irradiance > 0.2 ? 0.08 : 0;
  return 0.5 * seasonFactor * hourFactor * tempEffect * (1 - lightingReduction);
}

// Tilt + orientation efficiency multiplier
function panelEfficiencyFactor(roofAngle: number, orientation: string): number {
  const orientationFactor: Record<string, number> = { south: 1.0, east: 0.87, west: 0.87, north: 0.70 };
  const oFactor = orientationFactor[orientation] ?? 1.0;
  // Optimal tilt ≈ 35°; penalty for deviation
  const tiltDelta = Math.abs(roofAngle - 35);
  const tiltFactor = 1 - 0.003 * tiltDelta;
  return Math.max(0.4, oFactor * tiltFactor);
}

// Geocode location string to lat/lon via Nominatim
async function geocode(
  location: string,
): Promise<{ lat: number; lon: number; country: string; countryCode: string; regionCode: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=1&accept-language=en`;
    const res = await fetch(url, {
      headers: { "User-Agent": "GreenEnergyCalculator/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    if (!data.length) return null;
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      country: data[0].address?.country ?? "",
      // ISO 3166-1 alpha-2, lowercase ("sg"). The carbon lookup keys on this
      // and nothing else (D16); `country` above is a label. Empty when
      // Nominatim gave none, and empty resolves to no figure.
      countryCode: data[0].address?.country_code ?? "",
      // ISO 3166-2 level-4 code (e.g. "ES-CN"). Decides which REE electric
      // system a Spanish address is on. Empty when Nominatim gave none, and
      // empty is never read as "peninsular" (see spainElectricSystem).
      regionCode: data[0].address?.["ISO3166-2-lvl4"] ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * NASA POWER keys monthly data YYYYMM. The previous code built `2022${m}` from
 * ["JAN","FEB",...], so every one of the twelve lookups missed, and the
 * `|| 4.0` / `|| 15.0` defaults on the read supplied fabricated values for
 * every location on Earth while the response still reported live NASA data.
 *
 * The month list is explicit and is never read off the response: NASA appends
 * YYYY13 as the annual mean, so Object.keys() would yield thirteen entries and
 * a wrong annual figure.
 */
const NASA_MONTH_KEYS = ["01","02","03","04","05","06","07","08","09","10","11","12"];

/**
 * NASA POWER's documented fill value for a month it has no data for.
 *
 * It is FINITE, so `Number.isFinite` — the only guard this code had — accepts
 * it, and -999 flows through as though it were an irradiance reading. H1.0.
 *
 * Compared exactly, not by threshold. A threshold like `v < -900` would be a
 * guess about values NASA has never documented, and P2 forbids guessing.
 * Physically impossible readings are rejected separately below, by physics
 * rather than by sentinel-hunting.
 */
const NASA_FILL_VALUE = -999;

/**
 * The irradiance period. 2022 alone is a single year, not a climate normal,
 * and a single anomalous year moves a euro figure a user reads. H1.8.
 *
 * A parameter with a stated default, per the block's own constraint — never
 * hardcoded at a call site. The period actually used is reported in the
 * response, because the number means nothing without it.
 */
const NASA_PERIOD_START = 2019;
const NASA_PERIOD_END = 2023;

/**
 * Why a read fails, in the caller's terms.
 *
 * `fill-value` and `partial-coverage` are DATA defects: NASA answered, and the
 * answer cannot support a number. They become a typed error and no figure at
 * all — never a substitution, which is the whole of H1.0.
 *
 * `http`, `request-failed` and `malformed` are TRANSPORT defects: NASA did not
 * answer. Those keep the existing labelled latitude fallback, which is not a
 * silent default — it is reported as `fallback-lat` and rendered as such.
 * H1.0 is about the fill value; widening it to kill the transport fallback
 * would be a different change and is not taken here.
 */
type NasaFailure =
  | { kind: "http"; status: number }
  | { kind: "request-failed" }
  | { kind: "malformed"; status: number }
  | { kind: "non-finite-value"; parameter: string; keys: string[] }
  | { kind: "fill-value"; parameter: string; keys: string[] }
  | {
      kind: "partial-coverage";
      parameter: string;
      missing: string[];
      yearsRequested: number;
      monthsExpected: number;
      monthsPresent: number;
    };

type NasaProbe = {
  httpStatus: number | "not-called" | "request-failed";
  keysRequested: string[];
  keysPresent: string[];
  period: { start: number; end: number } | null;
  data: { irradiance: number[]; temperature: number[] } | null;
  failure: NasaFailure | null;
};

/**
 * How one value NASA sent is classified, before anything is averaged.
 *
 * Extracted from `readNasaSeries` under A20, unchanged in behaviour, so the
 * guard can be exercised **directly** against the real fixture. Gate H1 (ii)
 * demands the fill value be proven rejected against an unedited live response,
 * and that response is a DAILY one — `20260821`, not `202608`. Production is
 * monthly-only and stays that way: building a daily parse to make the fixture
 * reachable would add a surface the `-999` family can re-enter through, which
 * is the opposite of what the H-series is for. So the boundary is factored
 * instead: one classifier, called by the monthly reader, callable by a test
 * with whatever keys the real file happens to carry.
 *
 * This function is the guard. If it stops rejecting `-999`, the product
 * resumes fabricating, whatever the caller's key scheme.
 */
export type NasaValueClass =
  | { kind: "fill" }
  | { kind: "non-finite" }
  | { kind: "value"; value: number };

export function classifyNasaValue(rawValue: unknown): NasaValueClass {
  // Type first, and NEVER Number() before this check.
  //
  // Number(null) === 0 and Number("") === 0. Both are finite, so a
  // Number.isFinite guard accepts them and a month NASA sent as null becomes
  // 0 kWh/m2/day - a plausible-looking winter reading that no instrument
  // produced. This is the same defect as `|| 4.0`, one coercion further down.
  const isNumeric =
    typeof rawValue === "number" ||
    (typeof rawValue === "string" && rawValue.trim() !== "");
  if (!isNumeric) return { kind: "non-finite" };

  const value = Number(rawValue);
  // Compared exactly, not by threshold. A threshold like `v < -900` would be a
  // guess about values NASA has never documented, and P2 forbids guessing.
  if (value === NASA_FILL_VALUE) return { kind: "fill" };
  if (!Number.isFinite(value)) return { kind: "non-finite" };

  return { kind: "value", value };
}

/**
 * The typed answer for a DATA defect — NASA replied, and the reply cannot
 * support a number.
 *
 * Extracted from the calculate handler under A20 so that "the result is a
 * typed 422" is assertable as a pure function rather than only through a live
 * request. Behaviour unchanged: same status, same codes, same wording, which
 * A3.6 and A3.7 pin by exact substring.
 */
export function nasaDataFailureToHttp(
  f: Extract<NasaFailure, { kind: "fill-value" } | { kind: "partial-coverage" }>,
  locale: Locale,
): { status: 422; code: "nasa_fill_value" | "nasa_partial_coverage"; message: string } {
  // H2b: the wording comes from the catalog in the request's language. The
  // English entries are A3.6/A3.7's pinned text, byte for byte; the codes and
  // the status are unchanged. NASA's fill value, parameter names and keys are
  // NASA's own identifiers and print raw in both languages.
  const t = serverT(locale);
  if (f.kind === "fill-value") {
    return {
      status: 422,
      code: "nasa_fill_value",
      message: t("error.nasaFill", { fill: NASA_FILL_VALUE, parameter: f.parameter, keys: f.keys.join(", ") }),
    };
  }

  return {
    status: 422,
    code: "nasa_partial_coverage",
    message: t("error.nasaPartial", {
      present: f.monthsPresent,
      expected: f.monthsExpected,
      parameter: f.parameter,
      years: f.yearsRequested,
      missing: f.missing.length ? t("error.nasaPartialMissing", { list: f.missing.join(", ") }) : "",
    }),
  };
}

/**
 * Read one NASA parameter across the whole period and return the twelve
 * monthly means — or the reason it cannot.
 *
 * This is THE parse boundary (A11). Every value NASA sends is filtered here,
 * once, on the way in. Guarding at a call site was the rejected design: it
 * leaves every other call site open, which is exactly how `-999` survived.
 *
 * Three rejections, all typed and none substituting. Two are FATAL to the
 * request; the third is not, and the difference is deliberate:
 *
 *   1. absent key   -> partial coverage. FATAL. A mean over three years when
 *                      five were requested, reported as five, is the `4.0`
 *                      defect wearing a different constant. A11's named
 *                      failure mode for 1.8, and the likelier one.
 *   2. the fill value -> FATAL. H1.0. NASA answered "I have no data for this
 *                      month" in a finite number, and no figure can be built
 *                      on it.
 *   3. non-finite   -> NOT fatal. null, "", {} and friends: the key is there
 *                      and the value is garbage. That is a malformed response,
 *                      which the existing design already answers with the
 *                      labelled latitude fallback and reports as
 *                      `fallback-lat`. Gate A3.5 pins that behaviour and it is
 *                      not H1.0's to change - H1.0 is about the fill value.
 *                      Promoting this to a hard error would silently retire a
 *                      tested honesty guarantee under cover of a different task.
 */
function readNasaSeries(
  raw: Record<string, unknown>,
  parameter: string,
  years: number[],
): { values: number[] } | { failure: NasaFailure } {
  const monthlyMeans: number[] = [];
  const missing: string[] = [];
  const fillHits: string[] = [];
  const nonFinite: string[] = [];
  let monthsPresent = 0;

  for (const mm of NASA_MONTH_KEYS) {
    const perYear: number[] = [];

    for (const year of years) {
      const key = `${year}${mm}`;
      if (!(key in raw)) { missing.push(key); continue; }

      // The classification lives in `classifyNasaValue` (A20) — the same
      // function a test can point at the real daily fixture. The old code
      // only escaped the null-coercion defect because its test deleted keys,
      // making Number(undefined) NaN; a null in a live response would have
      // sailed straight through.
      const classified = classifyNasaValue(raw[key]);
      if (classified.kind === "fill") { fillHits.push(key); continue; }
      if (classified.kind === "non-finite") { nonFinite.push(key); continue; }

      perYear.push(classified.value);
      monthsPresent++;
    }

    // Only reached when nothing was rejected; the guards below fire first.
    if (perYear.length > 0) {
      monthlyMeans.push(perYear.reduce((a, b) => a + b, 0) / perYear.length);
    }
  }

  // Fill value first: it is the most specific diagnosis, and a response
  // carrying -999 usually carries missing keys too. Reporting "partial
  // coverage" for what is really a fill value would send the next reader
  // hunting the wrong defect.
  if (fillHits.length > 0) {
    return { failure: { kind: "fill-value", parameter, keys: fillHits.slice(0, 6) } };
  }

  // Non-finite before partial coverage, for the same reason: "the value is
  // garbage" is a sharper finding than "some months are absent", and this one
  // is not fatal.
  if (nonFinite.length > 0) {
    return { failure: { kind: "non-finite-value", parameter, keys: nonFinite.slice(0, 6) } };
  }

  const monthsExpected = NASA_MONTH_KEYS.length * years.length;
  if (missing.length > 0 || monthsPresent !== monthsExpected) {
    return {
      failure: {
        kind: "partial-coverage",
        parameter,
        missing: missing.slice(0, 6),
        yearsRequested: years.length,
        monthsExpected,
        monthsPresent,
      },
    };
  }

  return { values: monthlyMeans.map((v) => parseFloat(v.toFixed(4))) };
}

async function fetchNasaPower(
  lat: number,
  lon: number,
  period: { start: number; end: number } = { start: NASA_PERIOD_START, end: NASA_PERIOD_END },
): Promise<NasaProbe> {
  const years: number[] = [];
  for (let y = period.start; y <= period.end; y++) years.push(y);

  // The first three month keys of the period, in the order NASA returns them.
  // Compared against keysPresent to prove our YYYYMM format still matches the
  // response shape - that comparison is what caught the YYYYMON mismatch, so
  // the two lists must stay directly comparable.
  const keysRequested = NASA_MONTH_KEYS.slice(0, 3).map((mm) => `${period.start}${mm}`);
  const miss = (
    httpStatus: number | "not-called" | "request-failed",
    failure: NasaFailure,
    keysPresent: string[] = [],
  ): NasaProbe => ({ httpStatus, keysRequested, keysPresent, period: null, data: null, failure });

  try {
    const url =
      `https://power.larc.nasa.gov/api/temporal/monthly/point` +
      `?parameters=ALLSKY_SFC_SW_DWN,T2M&community=RE` +
      `&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}` +
      `&start=${period.start}&end=${period.end}&format=JSON`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    // An out-of-range period is rejected rather than filled - the monthly
    // endpoint answers "Your end date out of range". That arrives here as a
    // non-2xx and stays a transport failure, which is correct: we asked for
    // something that does not exist, so there is nothing to report a period on.
    if (!res.ok) return miss(res.status, { kind: "http", status: res.status });
    const data: any = await res.json();
    const param = data?.properties?.parameter;
    if (!param) return miss(res.status, { kind: "malformed", status: res.status });
    const irr = param["ALLSKY_SFC_SW_DWN"];
    const temp = param["T2M"];
    if (!irr || !temp) return miss(res.status, { kind: "malformed", status: res.status });

    // Object.keys is deliberate and must NOT be rewritten to
    // monthKeys.filter((k) => k in irr). This field's job is to report the
    // shape the response actually arrived in, including a shape we did not
    // anticipate; built from the keys we expected it would have returned []
    // when the YYYYMM/YYYYMON mismatch was live, which is the evidence that
    // found that defect. Diagnostic only - never feeds a calculated number.
    const keysPresent = Object.keys(irr).slice(0, 3);

    // Every parameter through the same boundary. Guarding irradiance and not
    // temperature would leave -999 reaching the consumption model.
    const irrRead = readNasaSeries(irr, "ALLSKY_SFC_SW_DWN", years);
    if ("failure" in irrRead) return miss(res.status, irrRead.failure, keysPresent);
    const tempRead = readNasaSeries(temp, "T2M", years);
    if ("failure" in tempRead) return miss(res.status, tempRead.failure, keysPresent);

    return {
      httpStatus: res.status,
      keysRequested,
      keysPresent,
      period: { start: period.start, end: period.end },
      data: { irradiance: irrRead.values, temperature: tempRead.values },
      failure: null,
    };
  } catch {
    // A request was issued and no HTTP response came back.
    return miss("request-failed", { kind: "request-failed" });
  }
}

// Fallback irradiance by latitude
export function fallbackIrradiance(lat: number): { irradiance: number[]; temperature: number[] } {
  // Was `Math.abs(lat || 45)`. `||` is falsy-coalescing, so it also fired at
  // latitude 0 and silently moved the equator to 45 degrees north. Deleted, not
  // replaced: this function receives a real latitude or it is not called.
  if (!Number.isFinite(lat)) {
    throw new Error(`fallbackIrradiance received a non-finite latitude: ${lat}`);
  }
  const absLat = Math.abs(lat);
  const baseIrr = Math.max(2.5, 6.5 - absLat * 0.06);
  const irradiance = MONTH_NAMES.map((_, i) => {
    const seasonalFactor = 1 + 0.45 * Math.cos(((i + 6) * Math.PI) / 6);
    return parseFloat((baseIrr * seasonalFactor).toFixed(2));
  });
  const temperature = [3,4,8,12,17,21,23,22,18,13,7,3].map((t) => t + (15 - absLat) * 0.3);
  return { irradiance, temperature };
}

/**
 * The provenance record every location-derived response carries.
 *
 * Mirrors `resolutionSchema` in ../shared-routes. Written out rather than
 * inferred so this module does not import a Zod schema to describe a plain
 * object; the schema is the contract with the client, this is the contract
 * inside the server, and `shared-routes.test.ts` fails if they drift.
 */
type ResolutionRecord = {
  locationInput: string;
  geocodeStatus: "resolved" | "failed";
  lat: number | null;
  lon: number | null;
  irradianceSource: "nasa-live" | "fallback-lat" | "not-reached";
  irradiancePeriod: { start: number; end: number } | null;
  nasaHttpStatus: number | "not-called" | "request-failed";
  nasaKeysRequested: string[];
  nasaKeysPresent: string[];
  irradianceMonthly: number[];
  /**
   * H-SRC-ES. Resolved alongside geocoding, for BOTH /api/calculate and
   * /api/optimize (this record is shared — see the header above). Attaching
   * it here rather than only where /api/calculate consumes it is what "no
   * silent defaults" means for a field neither route can compute without a
   * decision about what an unresolved country means: every caller of
   * resolveLocationIrradiance sees the same honest answer, whether or not it
   * goes on to act on it. /api/optimize carries the field and does not act on
   * it — it has never priced a CO2 figure and this block does not add that.
   */
  carbonSource: CarbonSourceNote;
};

/** The same record once geocoding has succeeded: lat and lon are real. */
type ResolvedResolutionRecord = ResolutionRecord & { lat: number; lon: number };

type IrradianceRejection = {
  ok: false;
  status: 422;
  body: {
    message: string;
    code: "geocode_failed" | "nasa_fill_value" | "nasa_partial_coverage";
    field: "location";
    resolution: ResolutionRecord;
  };
};

type IrradianceResolved = {
  ok: true;
  lat: number;
  lon: number;
  country: string;
  irradianceMonthly: number[];
  temperatureMonthly: number[];
  /** The twelve-month mean, at the precision the response reports it. */
  avgIrradiance: number;
  irradianceSource: "nasa-live" | "fallback-lat";
  irradiancePeriod: { start: number; end: number } | null;
  resolution: ResolvedResolutionRecord;
};

/**
 * Location string in, irradiance and provenance out — or a typed 422.
 *
 * Extracted at H-OPT, behaviour unchanged, because `/api/optimize` needs
 * exactly this and had none of it: it passed the raw location string to a
 * language model, which answered with its own priors (~5.5 kWh/m2/day for
 * Tetouan where this path computes 5.08). Two routes quoting two different
 * irradiances for one town is a P5 failure before it is anything else, and the
 * only durable fix is that there is one path, not two that agree today.
 *
 * `avgIrradiance` is rounded HERE, to the two decimals the calculate response
 * has always reported, and the optimizer sizes from that same rounded figure.
 * Sizing from the unrounded mean would put a number in the recommendation that
 * no field of any response contains — a small and very hard-to-find version of
 * the defect this block is closing.
 */
async function resolveLocationIrradiance(
  locationInput: string,
  locale: Locale,
): Promise<IrradianceResolved | IrradianceRejection> {
  // A failure used to fall through to lat 45, lon 10 — northern Italy — and
  // produce a complete, confident result computed from a location the user
  // never asked about, with nothing on screen saying so. Some requests that
  // used to "succeed" now fail here. That is the point.
  const geo = await geocode(locationInput);
  if (!geo) {
    return {
      ok: false,
      status: 422,
      body: {
        message: serverT(locale)("error.geocodeFailed"),
        code: "geocode_failed",
        field: "location",
        // Provenance matters most at the moment a request cannot be served.
        resolution: {
          locationInput,
          geocodeStatus: "failed",
          lat: null,
          lon: null,
          irradianceSource: "not-reached",
          irradiancePeriod: null,
          nasaHttpStatus: "not-called",
          nasaKeysRequested: [],
          nasaKeysPresent: [],
          irradianceMonthly: [],
          // Geocoding itself failed — there is no country to resolve a
          // carbon figure for, so this is "not_reached", never a guess.
          carbonSource: { status: "not_reached" as const },
        },
      },
    };
  }

  const { lat, lon } = geo;
  // Resolved once, here, and carried on every branch below — the success
  // path and both NASA-failure rejections. H-SRC-ES: replaces the old
  // detectCarbonIntensity(), which only ran inside /api/calculate's own
  // handler and silently substituted 0.4 for a country neither the sourced
  // registry nor the legacy table carried (D15). This function never
  // substitutes; it names one of four states, and the caller decides what to
  // do with "unknown_country" (see the /api/calculate handler below).
  const carbonSource = resolveCarbonSource(geo.countryCode, geo.country, locationInput, geo.regionCode);
  const nasaProbe = await fetchNasaPower(lat, lon);

  // H1.0 / H1.8. A data defect is fatal to the request: NASA answered and the
  // answer cannot carry a number, so no number is produced. Not a fallback,
  // not a shorter mean quietly relabelled — a typed error and nothing else.
  const f = nasaProbe.failure;
  if (f && (f.kind === "fill-value" || f.kind === "partial-coverage")) {
    const typed = nasaDataFailureToHttp(f, locale);
    return {
      ok: false,
      status: 422,
      body: {
        message: typed.message,
        code: typed.code,
        field: "location",
        resolution: {
          locationInput,
          geocodeStatus: "resolved",
          lat,
          lon,
          irradianceSource: "not-reached",
          irradiancePeriod: null,
          nasaHttpStatus: nasaProbe.httpStatus,
          nasaKeysRequested: nasaProbe.keysRequested,
          nasaKeysPresent: nasaProbe.keysPresent,
          irradianceMonthly: [],
          carbonSource,
        },
      },
    };
  }

  let nasaData = nasaProbe.data;
  let irradiancePeriod = nasaProbe.period;
  let irradianceSource: "nasa-live" | "fallback-lat" = "nasa-live";
  if (!nasaData) {
    // Transport failure only - NASA did not answer. Labelled, never silent.
    nasaData = fallbackIrradiance(lat);
    irradianceSource = "fallback-lat";
    irradiancePeriod = null;
  }

  const { irradiance: irrMonthly, temperature: tempMonthly } = nasaData;

  return {
    ok: true,
    lat,
    lon,
    country: geo.country,
    irradianceMonthly: irrMonthly,
    temperatureMonthly: tempMonthly,
    avgIrradiance: parseFloat((irrMonthly.reduce((a, b) => a + b, 0) / 12).toFixed(2)),
    irradianceSource,
    irradiancePeriod,
    // Provenance record. Not debug logging - it stays in the response body so a
    // user-facing number can say where its inputs came from.
    resolution: {
      locationInput,
      geocodeStatus: "resolved",
      lat: parseFloat(lat.toFixed(4)),
      lon: parseFloat(lon.toFixed(4)),
      irradianceSource,
      irradiancePeriod,
      nasaHttpStatus: nasaProbe.httpStatus,
      nasaKeysRequested: nasaProbe.keysRequested,
      nasaKeysPresent: nasaProbe.keysPresent,
      irradianceMonthly: irrMonthly,
      carbonSource,
    },
  };
}

/**
 * What one hour of the dispatch did with every kWh (H-D8D52). These are records
 * of the dispatch, not a change to it: the battery charges, discharges and
 * loses energy exactly as before. The losses stay where the dispatch takes
 * them - on the way into the battery and on the way out.
 */
export interface HourFlows {
  generationKwh: number;
  consumptionKwh: number;
  /** PV straight to the load. */
  pvDirectKwh: number;
  /** PV sent into the battery, before the charge loss. */
  batteryChargeKwh: number;
  /** PV that neither the load nor the battery could take. Not exported and not valued - the engine sells nothing. */
  surplusKwh: number;
  /** Battery energy that reached the load, after the discharge loss. */
  batteryDischargeKwh: number;
  gridImportKwh: number;
  /** Added to the state of charge: the charge, less its loss. */
  storedKwh: number;
  /** Taken from the state of charge: the delivered energy, plus its loss. */
  drawnKwh: number;
  /** State of charge at the end of the hour. */
  socKwh: number;
}

export type FlowSums = Omit<HourFlows, "socKwh">;

/** A monthly row as sent and stored: the fields it always had, plus the recorded flows, each rounded to 0.1 kWh. */
export type MonthlyFlows = MonthlyEntry &
  Pick<FlowSums, "pvDirectKwh" | "batteryChargeKwh" | "batteryDischargeKwh" | "surplusKwh">;

export interface Simulation {
  /** Display-rounded, as the response and the stored row carry it. */
  monthly: MonthlyFlows[];
  /** Exact monthly sums, before display rounding. */
  months: FlowSums[];
  /** Exact yearly sums: the sum of `months`. */
  year: FlowSums;
  socStartKwh: number;
  socEndKwh: number;
}

const noFlows = (): FlowSums => ({
  generationKwh: 0,
  consumptionKwh: 0,
  pvDirectKwh: 0,
  batteryChargeKwh: 0,
  surplusKwh: 0,
  batteryDischargeKwh: 0,
  gridImportKwh: 0,
  storedKwh: 0,
  drawnKwh: 0,
});

// 8760-hour annual battery simulation
export function simulate8760(
  annualKwh: number,
  pvWattage: number,
  batteryCapacityKwh: number,
  batteryEfficiency: number,
  panelFactor: number,
  irradianceMonthly: number[],
  temperatureMonthly: number[],
  systemEfficiency: number,
  /** Called once per simulated hour with that hour's record. Tests use it; the route does not. */
  onHour?: (month: number, hour: HourFlows) => void,
): Simulation {
  const chargeEff = Math.sqrt(batteryEfficiency);
  const dischargeEff = Math.sqrt(batteryEfficiency);
  let soc = 0; // state of charge in kWh

  const monthly: MonthlyFlows[] = MONTH_NAMES.map((name, m) => ({
    month: m + 1,
    name,
    generationKwh: 0,
    consumptionKwh: 0,
    savingsKwh: 0,
    gridImportKwh: 0,
    co2Kg: 0,
    pvDirectKwh: 0,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    surplusKwh: 0,
  }));
  const months: FlowSums[] = MONTH_NAMES.map(noFlows);

  // Compute total predicted consumption to scale to actual annual usage
  let totalPredicted = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < DAYS_IN_MONTH[m]; d++) {
      for (let h = 0; h < 24; h++) {
        const irrH = irradianceMonthly[m] * SOLAR_HOURLY_PROFILE[h];
        totalPredicted += mlPredictConsumption(m, h, irrH, temperatureMonthly[m]);
      }
    }
  }
  const consumptionScale = annualKwh / (totalPredicted || 1);

  for (let m = 0; m < 12; m++) {
    const dailyIrr = irradianceMonthly[m];
    const temp = temperatureMonthly[m];
    let mGen = 0, mCons = 0, mGrid = 0;
    const sums = months[m];

    for (let d = 0; d < DAYS_IN_MONTH[m]; d++) {
      for (let h = 0; h < 24; h++) {
        const irrH = dailyIrr * SOLAR_HOURLY_PROFILE[h];
        const genH = (pvWattage / 1000) * irrH * systemEfficiency * panelFactor;
        const consH = mlPredictConsumption(m, h, irrH, temp) * consumptionScale;

        mGen += genH;
        mCons += consH;

        // The dispatch below is unchanged; `hour` records what it did.
        const hour: HourFlows = { ...noFlows(), generationKwh: genH, consumptionKwh: consH, socKwh: 0 };
        const net = genH - consH;
        if (net > 0) {
          const chargeAmount = Math.min(net * chargeEff, batteryCapacityKwh - soc);
          soc += chargeAmount;
          hour.pvDirectKwh = consH;
          hour.storedKwh = chargeAmount;
          hour.batteryChargeKwh = chargeAmount / chargeEff;
          // What the battery could not take (D52) - dropped here, unrecorded, before H-D8D52.
          hour.surplusKwh = net - hour.batteryChargeKwh;
        } else {
          const needed = -net;
          const fromBattery = Math.min(needed, soc * dischargeEff);
          soc -= fromBattery / dischargeEff;
          mGrid += Math.max(0, needed - fromBattery);
          hour.pvDirectKwh = genH;
          // What the battery delivered (D8) - spent here, unrecorded, before H-D8D52.
          hour.batteryDischargeKwh = fromBattery;
          hour.drawnKwh = fromBattery / dischargeEff;
          hour.gridImportKwh = Math.max(0, needed - fromBattery);
        }
        hour.socKwh = soc;

        for (const k of Object.keys(sums) as (keyof FlowSums)[]) sums[k] += hour[k];
        onHour?.(m, hour);
      }
    }

    monthly[m].generationKwh = parseFloat(mGen.toFixed(1));
    monthly[m].consumptionKwh = parseFloat(mCons.toFixed(1));
    monthly[m].gridImportKwh = parseFloat(mGrid.toFixed(1));
    monthly[m].savingsKwh = parseFloat(Math.max(0, mCons - mGrid).toFixed(1));
    monthly[m].pvDirectKwh = parseFloat(sums.pvDirectKwh.toFixed(1));
    monthly[m].batteryChargeKwh = parseFloat(sums.batteryChargeKwh.toFixed(1));
    monthly[m].batteryDischargeKwh = parseFloat(sums.batteryDischargeKwh.toFixed(1));
    monthly[m].surplusKwh = parseFloat(sums.surplusKwh.toFixed(1));
  }

  const year = noFlows();
  for (const sums of months) {
    for (const k of Object.keys(year) as (keyof FlowSums)[]) year[k] += sums[k];
  }

  return { monthly, months, year, socStartKwh: 0, socEndKwh: soc };
}

/**
 * /api/optimize is one of only two routes that spend money on a paid API, and
 * it was open. Conservative on purpose: a single Mistral completion per request,
 * and no legitimate visitor runs the optimizer ten times in a quarter hour.
 * Keyed on IP by the library default - no custom key generator, no store, no
 * bypass list.
 */
const optimizeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Written per request, in the language it asked for (H2b).
  message: (req: { get(name: string): string | undefined }) => ({ message: serverT(requestLocale(req))("error.rateLimited") }),
});

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  registerChatRoutes(app);

  // H3.9 — the screening portfolio (read-only; see routes/screening.ts).
  app.use(createScreeningRouter(pool));

  // Enhanced PDF report
  //
  // Session-scoped since H-S (finding F2). This route previously read no header
  // and took a sequential integer, so /api/calculate/1/pdf, /2/pdf, /3/pdf
  // walked every calculation ever made and rendered location, usage, PV size,
  // battery, tariff and roof angle for each. No id was needed at all - not a
  // replay of someone's session, an enumeration oracle.
  app.get("/api/calculate/:id/pdf", async (req, res) => {
    // 2b.4: the report is written in the language the request asked for
    // (Accept-Language, which the web app sets from the reader's choice);
    // Spanish when it asked for nothing.
    const locale = requestLocale(req);
    const t = serverT(locale);
    try {
      // Header only, same as every other session-carrying route. Absent means
      // reject before any lookup: 400 says the request was malformed, and says
      // nothing about whether the row exists.
      // Header only, same as every other session-carrying route. Absent means
      // reject before any lookup: 400 says the request was malformed, and says
      // nothing about whether the row exists.
      const sessionId = req.get("x-session-id");
      if (!sessionId) { res.status(400).json({ message: t("error.sessionHeader") }); return; }

      const id = parseInt(req.params.id);
      // Scoped lookup. "Not yours" and "does not exist" collapse to the same
      // undefined inside the query, so the 404 below cannot confirm a row
      // exists. A 403 here would have re-opened exactly the oracle this closes.
      const calc = await storage.getCalculationById(id, sessionId);
      if (!calc) { res.status(404).json({ message: t("error.calcNotFound") }); return; }

      // G7: the stored orientation is an enum and is never printed raw. It is
      // checked BEFORE the document starts streaming, so a corrupted row gets
      // a 500 rather than half a PDF.
      const ORIENTATION = {
        north: "pdf.orientation.north",
        south: "pdf.orientation.south",
        east: "pdf.orientation.east",
        west: "pdf.orientation.west",
      } as const;
      const orientation = calc.panelOrientation as keyof typeof ORIENTATION;
      if (!Object.prototype.hasOwnProperty.call(ORIENTATION, orientation)) {
        // The input schema admits only these four; anything else is a corrupted
        // row, refused rather than printed.
        throw new Error(`calculations.panelOrientation holds an unknown value: ${String(calc.panelOrientation)}`);
      }

      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=energy-report-${id}.pdf`);
      doc.pipe(res);

      // Header
      doc.rect(0, 0, doc.page.width, 80).fill("#10b981");
      doc.fillColor("white").fontSize(22).font("Helvetica-Bold")
        .text(t("pdf.title"), 50, 25, { align: "center" });
      doc.fillColor("#d1fae5").fontSize(11)
        .text(t("pdf.generated", { date: formatDate(locale, new Date(), { day: "numeric", month: "long", year: "numeric" }) }), 50, 52, { align: "center" });
      doc.fillColor("#1f2937");

      // Pagination (N1). `y` is kept by hand: every draw below passes its own
      // coordinates. PDFKit starts a new page by itself when a text() call
      // would cross the bottom margin, but `y` knows nothing of that and keeps
      // growing, so every later draw lands past the bottom too and forces a
      // page of its own - twelve pages, one table cell each. So nothing below
      // is drawn without asking ensureRoom first, and it is the only addPage().
      let y = 100;
      const pageBottom = () => doc.page.height - doc.page.margins.bottom;
      /** Room for a block `h` tall at `y`? If not, start a page. True when it started one. */
      const ensureRoom = (h: number): boolean => {
        if (y + h <= pageBottom()) return false;
        doc.addPage();
        y = doc.page.margins.top;
        return true;
      };
      // Numbers take the REQUEST's locale, never the host default: the host
      // could print a narrow no-break space (fr-FR), which WinAnsi cannot
      // encode (P.2). es-ES and en-GB both encode: es-ES groups with "." and
      // separates decimals with ",", and puts a no-break space (0xA0, in
      // WinAnsi) before the euro sign.
      const num = (n: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, n, options);


      // Summary section - the heading goes with its first row
      ensureRoom(30 + 22);
      doc.fontSize(14).font("Helvetica-Bold").text(t("pdf.summary"), 50, y);
      doc.moveTo(50, y + 18).lineTo(doc.page.width - 50, y + 18).strokeColor("#e5e7eb").stroke();
      y += 30;

      const pdfCurrency = (calc.renewableMix as { currency?: Currency } | null)?.currency;
      const pdfTariff =
        calc.annualSavingsEur == null
          ? t("pdf.pending")
          : pdfCurrency
            ? t("pdf.perKwh", { price: formatMoney(locale, calc.electricityTariff, pdfCurrency, 3) })
            : t("pdf.currencyNotRecorded", {
                n: t("pdf.perKwh", { price: num(calc.electricityTariff, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) }),
              });

      const summaryRows = [
        [t("pdf.location"), calc.location],
        [t("pdf.annualUsage"), t("unit.kwh", { n: num(calc.energyUsage) })],
        [t("pdf.pvSize"), t("unit.w", { n: num(calc.pvWattage) })],
        [t("pdf.batteryCapacity"), t("unit.kwh", { n: num(calc.batteryCapacity) })],
        [t("pdf.batteryEfficiency"), t("unit.percent", { n: num(Math.round(calc.batteryEfficiency * 100)) })],
        [t("pdf.tariff"), pdfTariff],
        [t("pdf.orientation"), t(ORIENTATION[orientation])],
        [t("pdf.roofAngle"), t("unit.degrees", { n: num(calc.roofAngle) })],
      ];

      summaryRows.forEach(([label, value], i) => {
        ensureRoom(22);
        if (i % 2 === 0) doc.rect(50, y, doc.page.width - 100, 22).fill("#f9fafb");
        doc.fillColor("#6b7280").fontSize(10).font("Helvetica").text(label, 58, y + 6);
        doc.fillColor("#111827").font("Helvetica-Bold").text(value, 0, y + 6, { align: "right", width: doc.page.width - 70 });
        y += 22;
      });

      y += 10;

      // Results section - the heading goes with its first row
      ensureRoom(32 + 22);
      doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f2937").text(t("pdf.results"), 50, y);
      y += 20;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#e5e7eb").stroke();
      y += 12;


      // Payback + lifetime for PDF — read persisted values for an exact match to the app.



      // Money rows read the persisted values only. A null saving is a calculation
      // that was never priced (no sourced tariff), and renders "pending" - the
      // old path recomputed one here from a 900/500/1200 estimate that had no source.
      const pdfMoney = (n: number | null | undefined): string =>
        n == null
          ? t("pdf.pending")
          : pdfCurrency
            ? formatMoney(locale, n, pdfCurrency)
            : t("pdf.currencyNotRecorded", { n: num(Math.round(n)) });
      // "Not paid back within the horizon" is a state, not a number (D7). The
      // calculate handler writes lifetimeSavingsEur only when ROI was computed,
      // so it tells the states apart: absent = no ROI, "pending"; present with
      // no payback = the savings never covered the cost. Rows written before
      // H-PDF carry 25 for "never" and still print "25.0 years" - they cannot
      // be told from a real 25.0 without a recompute (F-f).
      const pdfPayback =
        calc.lifetimeSavingsEur == null
          ? t("pdf.pending")
          : calc.paybackYears == null
            ? t("pdf.paybackNotWithin", { n: ROI_YEARS })
            : t("pdf.paybackYears", { n: num(calc.paybackYears, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });

      // N3: lifetimeSavingsEur is the GROSS 25-year saving, and was printed as
      // "Net Gain" - "€30,975" on a row whose install cost was 200,000. The net
      // is computed here, at render time, from the two persisted figures the
      // ROI curve was built from (written together, see the calculate handler),
      // so old rows get it with no migration. The row exists only when the cost
      // is known: a missing cost is never 0. The sign is a literal ASCII
      // hyphen-minus rather than whatever the locale data supplies, because
      // U+2212 is not WinAnsi (N2's class).
      const pdfNet = (lifetime: number, cost: number): string => {
        const net = lifetime - cost;
        return net < 0 ? `-${pdfMoney(-net)}` : pdfMoney(net);
      };
      const netRows =
        calc.installationCostEur == null
          ? []
          : [[
              t("pdf.net", { years: ROI_YEARS }),
              calc.lifetimeSavingsEur == null ? t("pdf.pending") : pdfNet(calc.lifetimeSavingsEur, calc.installationCostEur),
              "#2563eb",
            ]];

      const resultRows = [
        [t("pdf.annualSaved"), t("unit.kwh", { n: num(calc.savingsKwh) }), "#10b981"],
        [t("pdf.annualCostSavings"), pdfMoney(calc.annualSavingsEur), "#10b981"],
        [t("pdf.payback"), pdfPayback, "#2563eb"],
        [t("pdf.lifetime", { years: ROI_YEARS }), pdfMoney(calc.lifetimeSavingsEur), "#2563eb"],
        ...netRows,
        // "CO2", not U+2082: a subscript two is not WinAnsi and printed as "CO ‚" (N2).
        [t("pdf.co2"), t("unit.kg", { n: num(calc.co2Reduction) }), "#059669"],
        [t("pdf.trees"), t("pdf.treesValue", { n: num(Math.round(calc.co2Reduction / 20)) }), "#059669"],
      ];

      resultRows.forEach(([label, value, color], i) => {
        ensureRoom(22);
        if (i % 2 === 0) doc.rect(50, y, doc.page.width - 100, 22).fill("#f0fdf4");
        doc.fillColor("#6b7280").fontSize(10).font("Helvetica").text(label, 58, y + 6);
        doc.fillColor(color).font("Helvetica-Bold").text(value, 0, y + 6, { align: "right", width: doc.page.width - 70 });
        y += 22;
      });

      y += 20;

      // Monthly breakdown table
      if (calc.monthlyData && (calc.monthlyData as MonthlyEntry[]).length > 0) {
        // A row stored before H-D8D52 carries no recorded flows, so its surplus
        // is not known: it gets no surplus column and a line saying so - never a
        // 0 in the column (T7, F-c).
        const recorded = monthlyEntrySchema.array().safeParse(calc.monthlyData);
        // The month label comes from the month NUMBER in the report's language,
        // not from the English name stored beside it (H2b).
        const kwh = (n: number) => t("unit.kwh", { n: num(n) });
        // A row too old to carry a month number is matched by the English
        // abbreviation it stored (MONTH_NAMES, this file's own list) — a lookup,
        // not a guess. A row with neither prints the label it stored, as stored.
        const monthLabel = (r: { month?: unknown; name?: unknown }): string => {
          const m =
            typeof r.month === "number" && Number.isInteger(r.month) && r.month >= 1 && r.month <= 12
              ? r.month
              : MONTH_NAMES.indexOf(String(r.name)) + 1;
          return m >= 1 ? monthName(locale, m) : String(r.name);
        };
        const rows = recorded.success
          ? recorded.data.map((r) => [monthLabel(r), kwh(r.generationKwh), kwh(r.consumptionKwh), kwh(r.savingsKwh), kwh(r.gridImportKwh), kwh(r.surplusKwh)])
          : (calc.monthlyData as MonthlyEntry[]).map((r) => [monthLabel(r), kwh(r.generationKwh), kwh(r.consumptionKwh), kwh(r.savingsKwh), kwh(r.gridImportKwh)]);
        const headers = [
          t("pdf.col.month"),
          t("pdf.col.generated"),
          t("pdf.col.consumed"),
          t("pdf.col.saved"),
          t("pdf.col.gridImport"),
          ...(recorded.success ? [t("pdf.col.surplus")] : []),
        ];
        const colW = (doc.page.width - 100) / headers.length;
        const headerRow = () => {
          headers.forEach((h, i) => {
            doc.rect(50 + i * colW, y, colW, 20).fill("#10b981");
            doc.fillColor("white").fontSize(9).font("Helvetica-Bold").text(h, 54 + i * colW, y + 6, { width: colW - 4 });
          });
          y += 20;
        };

        // The heading, the header row and the first month go together, so the
        // heading is never left alone at the foot of a page.
        ensureRoom(28 + 20 + 18);
        doc.fontSize(14).font("Helvetica-Bold").fillColor("#1f2937").text(t("pdf.monthly"), 50, y);
        y += 20;
        doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#e5e7eb").stroke();
        y += 8;
        headerRow();

        rows.forEach((cells, i) => {
          // A table that continues on a new page repeats its header row.
          if (ensureRoom(18)) headerRow();
          if (i % 2 === 0) doc.rect(50, y, doc.page.width - 100, 18).fill("#f9fafb");
          cells.forEach((cell, j) => {
            doc.fillColor("#374151").fontSize(8.5).font("Helvetica").text(cell, 54 + j * colW, y + 5, { width: colW - 4 });
          });
          y += 18;
        });

        if (!recorded.success) {
          ensureRoom(22);
          doc.fillColor("#6b7280").fontSize(9).font("Helvetica")
            .text(t("pdf.surplusNotRecorded"), 54, y + 6, { width: doc.page.width - 108 });
          y += 22;
        }
      }

      // Footer - below the last block, or at the top of a page of its own
      y += 30;
      ensureRoom(22);
      doc.rect(50, y, doc.page.width - 100, 1).fill("#e5e7eb");
      doc.fillColor("#9ca3af").fontSize(9).font("Helvetica")
        // No irradiance claim here, in either direction. This footer renders a
        // persisted calculations row, and that row carries no provenance - no
        // source, no year - so the PDF cannot know whether the figures came
        // from NASA or from the latitude fallback. Naming a year it cannot
        // verify would read as a verified fact on the artefact most likely to
        // be forwarded onward. Silence is the honest option until the row can
        // carry the fact.
        .text(t("pdf.footer"), 50, y + 10, { align: "center" });

      doc.end();
    } catch (err) {
      console.error("PDF generation error:", err);
      res.status(500).json({ message: t("error.pdfFailed") });
    }
  });

  // Main calculation endpoint
  app.post(api.calculations.create.path, async (req, res) => {
    // H2b: every sentence in this response is written in the language the
    // request asked for; Spanish when it asked for nothing.
    const locale = requestLocale(req);
    const t = serverT(locale);
    try {
      // Header only: never defaulted, never generated server-side, never taken
      // from the body. Absent means reject, before any work is done.
      const sessionId = req.get("x-session-id");
      if (!sessionId) {
        return res.status(400).json({ message: t("error.sessionHeader") });
      }

      const input = api.calculations.create.input.parse(req.body);

      // Geocode, then NASA, then provenance — one path, shared with
      // /api/optimize since H-OPT so the two routes cannot quote different
      // irradiance for the same town.
      const resolved = await resolveLocationIrradiance(input.location, locale);
      if (!resolved.ok) {
        return res.status(resolved.status).json(resolved.body);
      }

      const {
        irradianceMonthly: irrMonthly,
        temperatureMonthly: tempMonthly,
        avgIrradiance,
        irradianceSource,
        resolution,
      } = resolved;

      // H-SRC-ES: carbon intensity was resolved already, inside
      // resolveLocationIrradiance, alongside geocoding — resolution.carbonSource
      // names one of four states (see ../lib/emissions/carbon-source.ts).
      // "unknown_country" is the D15 case that used to silently become 0.4;
      // it is now a typed 400, decided here rather than buried in a lookup.
      if (resolution.carbonSource.status === "unknown_country") {
        return res.status(400).json({
          message: t("error.unknownCarbonCountry", { attempted: resolution.carbonSource.attempted }),
          code: "unknown_carbon_country",
          field: "location",
          resolution,
        });
      }
      // A registry country whose factor for THIS address's electric system is
      // not sourced (an island, or an address whose system cannot be told).
      // The peninsular factor is never substituted (A21) — a typed 400.
      if (resolution.carbonSource.status === "pending") {
        return res.status(400).json({
          // The sentence is built from the typed reason, in the request's
          // language; the English `detail` stays in the provenance record.
          message: t("error.carbonPending", {
            detail:
              resolution.carbonSource.reason === "system_undetermined"
                ? t("carbon.systemUndetermined")
                : t("carbon.systemFactorPending", { system: resolution.carbonSource.system ?? "" }),
          }),
          code: "carbon_factor_pending",
          field: "location",
          resolution,
        });
      }
      const carbonIntensity = carbonIntensityKgPerKwh(resolution.carbonSource);

      const panelFactor = panelEfficiencyFactor(input.roofAngle, input.panelOrientation);
      const SYSTEM_EFFICIENCY = 0.78;

      // 8760-hour simulation
      const sim = simulate8760(
        input.energyUsage,
        input.pvWattage,
        input.batteryCapacity,
        input.batteryEfficiency,
        panelFactor,
        irrMonthly,
        tempMonthly,
        SYSTEM_EFFICIENCY
      );
      const monthlyData = sim.monthly;

      // Totals from simulation
      const totalSavingsKwh = monthlyData.reduce((a, m) => a + m.savingsKwh, 0);
      const totalGridKwh = monthlyData.reduce((a, m) => a + m.gridImportKwh, 0);
      const annualCo2Reduction = parseFloat((totalSavingsKwh * carbonIntensity).toFixed(1));
      // Money: a tariff, an install cost and a payback, each either USED with
      // its source named or PENDING with a typed reason. No default tariff, no
      // default currency, no auto-estimated install cost (P0.7, P0.8).
      const money = resolveMoney({
        country: findCountry(resolved.country),
        userTariff: input.electricityTariff ?? null,
        userInstallCost: input.installationCost != null && input.installationCost > 0 ? input.installationCost : null,
        savingsKwh: totalSavingsKwh,
        pvKw: input.pvWattage / 1000,
        batteryKwh: input.batteryCapacity,
        now: new Date(),
        locale,
      });

      // Enrich monthly CO2
      monthlyData.forEach((m) => {
        m.co2Kg = parseFloat((m.savingsKwh * carbonIntensity).toFixed(1));
      });

      // Energy mix (D8). Each slice is a recorded annual sum - PV straight to the
      // load, battery energy delivered, grid import - as a share of the recorded
      // consumption. The formula it replaces subtracted the generation share from
      // the savings share, which can never exceed it, so "From Battery" came out
      // 0% in every case measured at fc04551, in both generation regimes.
      const share = (kwh: number) => Math.round((kwh / sim.year.consumptionKwh) * 100);
      const breakdown = {
        solar: share(sim.year.pvDirectKwh),
        battery: share(sim.year.batteryDischargeKwh),
        grid: share(sim.year.gridImportKwh),
      };
      // Coverage for the recommendation prose, computed as before (the prose is out of fence).
      const solarPct = Math.round((totalSavingsKwh / input.energyUsage) * 100);

      // Recommendation. Amounts are rendered in the calculation's own currency,
      // or the sentence says the saving is not priced. No literal symbol.
      // H2b: the same three sentences, from the catalog, in the request's
      // language; the figures and the branches are unchanged. English prints
      // the wattage unformatted, as it always has; Spanish groups it.
      const watts = (w: number) => (locale === "en" ? String(w) : formatNumber(locale, w));
      const saving = describeSaving(money, locale);
      let recommendation = "";
      if (solarPct >= 100) {
        recommendation =
          money.annualSavings !== null && money.currency !== null
            ? t("rec.fullWithExport", {
                w: watts(input.pvWattage),
                value: formatMoney(locale, money.annualSavings * 0.1, money.currency),
              })
            : t("rec.full", { w: watts(input.pvWattage), saving });
      } else if (solarPct >= 70) {
        recommendation = t("rec.good", { pct: solarPct, saving });
      } else {
        recommendation = t("rec.low", { pct: solarPct, saving, w: watts(Math.round(input.pvWattage * 1.5)) });
      }

      const result = {
        savingsKwh: Math.round(totalSavingsKwh),
        co2Reduction: Math.round(annualCo2Reduction),
        carbonIntensity,
        avgIrradiance,
        irradianceSource,
        recommendation,
        breakdown,
        monthlyData,
        money,
        resolution,
      };

      // The row this calculation was stored as. Its id is what the PDF button
      // downloads, so it goes back in this response - the web used to guess it
      // from the newest history row, a different request that could still be
      // the previous calculation (D51, D53).
      const saved = await storage.createCalculation({
        location: input.location,
        energyUsage: input.energyUsage,
        pvWattage: input.pvWattage,
        batteryCapacity: input.batteryCapacity,
        // The column is NOT NULL (no DDL here, G3). A tariff that was pending
        // is stored as 0 - a value the input schema rejects (min 0.01), so it
        // can only mean "no tariff was applied", and History/PDF read
        // annualSavingsEur === null as pending, never this column.
        electricityTariff: money.tariff.status === "used" ? money.tariff.value : 0,
        batteryEfficiency: input.batteryEfficiency,
        panelOrientation: input.panelOrientation,
        roofAngle: input.roofAngle,
        savingsKwh: result.savingsKwh,
        co2Reduction: result.co2Reduction,
        annualSavingsEur: money.annualSavings,
        // The table has no currency column (no DDL, G3), so the currency the
        // money was computed in travels here so the PDF can render it.
        renewableMix: {
          solar: result.breakdown.solar + result.breakdown.battery,
          wind: 0,
          ...(money.currency ? { currency: money.currency } : {}),
        },
        monthlyData,
        installationCostEur:
          money.installCost.status === "used" && money.installCost.source !== "registry_range"
            ? money.installCost.amount
            : null,
        // The PDF reads this pair (D7): lifetime written with no payback = ROI
        // computed and never paid back within ROI_YEARS; both null = no ROI.
        paybackYears: money.roi.status === "computed" ? money.roi.paybackYears : null,
        lifetimeSavingsEur: money.roi.status === "computed" ? money.roi.lifetimeSavings : null,
        sessionId,
      });

      return res.json({ ...result, id: saved.id });
    } catch (err) {
      if (err instanceof z.ZodError) {
        const field = err.issues[0].path.join(".");
        // English keeps zod's own wording, as before; Spanish names the field.
        return res.status(400).json({ message: locale === "en" ? err.issues[0].message : t("error.invalidField", { field }), field });
      }
      console.error("Calculation error:", err);
      return res.status(500).json({ message: t("error.internal") });
    }
  });

  app.get(api.calculations.history.path, async (req, res) => {
    const sessionId = req.get("x-session-id");
    if (!sessionId) {
      return res.status(400).json({ message: serverT(requestLocale(req))("error.sessionHeader") });
    }

    const history = await storage.getHistory(sessionId);
    return res.json(history);
  });

  /**
   * /api/optimize — H-OPT.
   *
   * What this route used to do: hand the location STRING and a 24-entry array
   * to a language model and print what came back. It never called NASA. The
   * model answered from its priors — ~5.5 kWh/m2/day for Tetouan where the
   * calculator computes 5.08, ~4.5 for Fuengirola where it computes 5.05 — and
   * it read the array as absolute kWh, so every request was sized for the
   * client's fixed 102 kWh/day profile. A 20-30 kW array came back where the
   * answer is around 3.4 kWp. P3 and P1 in one handler.
   *
   * What it does now, in order: geocode through the shared resolver, take the
   * same NASA 2019-2023 mean through the same parse boundary, size with a pure
   * function, and only then show the model the figures and ask for prose. The
   * model cannot move a number because no number it returns is read.
   */
  app.post(api.calculations.optimize.path, optimizeLimiter, async (req, res) => {
    const locale = requestLocale(req);
    const t = serverT(locale);
    try {
      const { energyPattern, location, annualUsageKwh } =
        api.calculations.optimize.input.parse(req.body);

      const resolved = await resolveLocationIrradiance(location, locale);
      if (!resolved.ok) {
        return res.status(resolved.status).json(resolved.body);
      }

      // The solar profile is passed in rather than re-declared in lib/sizing,
      // so "the hours the array produces nothing" means the same thing here as
      // it does in the 8760 simulation. One profile. P5.
      const sized = sizePvAndBattery({
        annualUsageKwh,
        hourlyLoadShape: energyPattern,
        hourlySolarShape: SOLAR_HOURLY_PROFILE,
        irradianceKwhM2Day: resolved.avgIrradiance,
      });

      if (!sized.ok) {
        // Reachable only for inputs Zod admits and physics does not — a load
        // shape of 24 zeros is the live one. A typed 422 in the same shape as
        // every other refusal on this path, never a substituted size.
        return res.status(422).json({
          message: sizingFailureMessage(sized.failure, locale),
          code: "sizing_failed",
          field: "energyPattern",
          resolution: resolved.resolution,
        });
      }

      const facts: OptimizeFacts = {
        location,
        // The 4-decimal coordinates the response reports, not the raw ones:
        // the model must not be shown a number no field of the answer carries.
        lat: resolved.resolution.lat,
        lon: resolved.resolution.lon,
        irradianceSource: resolved.irradianceSource,
        irradiancePeriod: resolved.irradiancePeriod,
        sizing: sized.sizing,
      };
      const factsText = renderOptimizeFacts(facts);

      const response = await getLlmClient().chat.completions.create({
        model: llmModel(),
        messages: [
          {
            role: "system",
            content:
              "You are an energy consultant writing for a homeowner. The system size has ALREADY been computed from satellite irradiance data and the household's metered consumption. You are not being asked to size anything and you must not propose a different size. Explain, in plain prose, why the given array and battery suit this location and this load. " +
              "Return JSON with exactly one key: explanation (a single plain string of prose). The explanation MUST be a string — never an object, never an array, never nested. " +
              "Every numeral you write must be copied exactly from the figures given to you. Do not round them, do not convert their units, and do not introduce any other number — no payback periods, no costs, no efficiencies, no irradiance of your own. A number that is not in the list makes the whole answer unusable and it will be discarded.",
          },
          {
            role: "user",
            content: `${factsText}\n\nWrite the explanation.`,
          },
        ],
        response_format: { type: "json_object" },
      });
      const rawContent = response.choices[0].message.content ?? "{}";

      // Validate at the boundary; never echo the model payload straight out.
      // Zod detail and the rejected figures go to the logs, the client gets
      // readable prose only.
      const result = parseOptimizePayload(rawContent, factsText);

      if (!result.ok) {
        console.error(
          "[optimize] unusable model payload — reason:",
          result.reason,
          "| raw:",
          rawContent,
          "| issues:",
          JSON.stringify(result.issues),
        );
        return res.status(502).json({
          message: t("error.optimizeModel"),
          code: "invalid_model_response",
        });
      }

      return res.json({
        // G6: both figures come from the sizing function, and the response
        // carries the inputs they were computed from so the tab can show them.
        optimalPv: sized.sizing.pvWatts,
        optimalBattery: sized.sizing.batteryKwh,
        explanation: result.explanation,
        sizing: sized.sizing,
        resolution: resolved.resolution,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        const field = err.issues[0].path.join(".");
        return res.status(400).json({ message: locale === "en" ? err.issues[0].message : t("error.invalidField", { field }), field });
      }
      console.error("Optimization error:", err);
      return res.status(500).json({ message: t("error.optimizeFailed") });
    }
  });

  return httpServer;
}
