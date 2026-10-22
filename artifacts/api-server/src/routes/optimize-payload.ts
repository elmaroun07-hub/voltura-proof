import { modelProseSchema } from "../shared-routes";
import { serverCatalog } from "../i18n";
import type { Sizing } from "../lib/sizing";

/**
 * The /api/optimize model boundary — H-OPT.
 *
 * What changed, and why the shape of this file changed with it. The model used
 * to be asked for `optimal_pv_watts` and `optimal_battery_kwh` and this module
 * validated them. It no longer chooses either: `routes.ts` computes both from
 * NASA POWER irradiance and the user's own annual usage, and the model is given
 * those figures and asked for prose. So the two jobs here are now:
 *
 *   1. render the computed figures into the text the model is shown, and
 *   2. check that every numeral coming back was one of them.
 *
 * (2) is the part that matters. A model handed correct numbers will still, at
 * some rate, write a different one — a rounded figure, a remembered irradiance,
 * an invented payback. P1 says every number a user reads is computed or cited;
 * a figure the model made up is neither, and the only mechanical way to hold
 * that line is to refuse prose containing numerals that were not in the input.
 *
 * The check is deliberately STRICT and its cost is stated rather than
 * discovered: prose saying "over 24 hours" is rejected when 24 is not among the
 * figures, and the request 502s. That is the correct direction to fail. A false
 * 502 is a visible error the user can retry; a fabricated euro figure is a
 * number they act on. The prompt tells the model the rule, which is what keeps
 * the rate low.
 *
 * Extracted from the route handler so the contract is unit-testable without
 * booting Express or calling a provider — a mock of the *route* is what let the
 * earlier payload bug survive two fixes.
 */

export type OptimizeFacts = {
  /** The location as the geocoder resolved it, echoed for the model's prose. */
  location: string;
  lat: number;
  lon: number;
  /**
   * `nasa-live` or `fallback-lat`, exactly as `resolution.irradianceSource`
   * carries it. It is a machine enum and is mapped below before it reaches the
   * prompt: the model writes prose for a person to read, so a raw `nasa-live`
   * in the input is a raw `nasa-live` one echo away from a screen (G7). This
   * map is prompt-only — the UI has its own at its render site, which is where
   * G7's gate inspects, and neither reads the other.
   */
  irradianceSource: "nasa-live" | "fallback-lat";
  irradiancePeriod: { start: number; end: number } | null;
  sizing: Sizing;
};

/** Percent, for prose. `0.8` is unreadable in a sentence; `80%` is not. */
function asPercent(ratio: number): number {
  return parseFloat((ratio * 100).toFixed(2));
}

function irradianceProvenanceLine(f: OptimizeFacts): string {
  switch (f.irradianceSource) {
    case "nasa-live": {
      if (f.irradiancePeriod === null) {
        throw new Error("nasa-live facts carry no irradiancePeriod");
      }
      const { start, end } = f.irradiancePeriod;
      // An en dash, not a hyphen: a hyphen between two years reads as a minus
      // sign to the figure scanner below, and "2019-2023" would then yield the
      // token -2023. The range is one fact and both years are stated.
      const span = start === end ? `${start}` : `${start}–${end}`;
      return `Irradiance source: NASA POWER satellite measurement, ${span} monthly mean`;
    }
    case "fallback-lat":
      return "Irradiance source: estimated from latitude because NASA POWER did not answer";
  }
}

/**
 * The text the model is shown, and — by construction — the set of figures it is
 * allowed to use.
 *
 * The allow-list is not maintained alongside this string; it is DERIVED from
 * it, by running the same scanner over it that runs over the answer. That is
 * what makes "no figure that was not in the input" literally true rather than
 * approximately true, and it means a line added here cannot be forgotten in a
 * list somewhere else.
 *
 * Ratios appear twice, as a percentage and as the ratio itself, because both
 * are the same fact and prose reaches for either. Nothing else is duplicated.
 */
export function renderOptimizeFacts(f: OptimizeFacts): string {
  const s = f.sizing;
  return [
    `Location, as resolved by the geocoder: ${f.location}`,
    `Latitude: ${f.lat}`,
    `Longitude: ${f.lon}`,
    `Mean daily irradiance: ${s.irradianceKwhM2Day} kWh/m2/day`,
    irradianceProvenanceLine(f),
    `Metered annual electricity use: ${s.annualUsageKwh} kWh/year`,
    `Average daily use: ${s.dailyUsageKwh} kWh/day`,
    `Use during the ${s.darkHours} hours the array produces nothing: ${s.nightUsageKwh} kWh/day`,
    `System performance ratio: ${asPercent(s.performanceRatio)}% (${s.performanceRatio})`,
    `Battery round-trip efficiency: ${asPercent(s.roundTripEfficiency)}% (${s.roundTripEfficiency})`,
    `Usable depth of discharge: ${asPercent(s.usableDepthOfDischarge)}% (${s.usableDepthOfDischarge})`,
    `Coverage target: ${asPercent(s.coverageTarget)}% (${s.coverageTarget}) of annual consumption, met by annual generation`,
    `COMPUTED recommendation — PV array: ${s.pvKwp} kWp (${s.pvWatts} W)`,
    `COMPUTED recommendation — battery: ${s.batteryKwh} kWh`,
  ].join("\n");
}

/**
 * Every run of digits in a piece of text, as a number, or `null` for a run that
 * cannot be read unambiguously.
 *
 * `null` is a REJECTION, not a skip. A token this cannot parse is a token whose
 * value is uncertain, and an uncertain figure in a user-facing sentence is the
 * thing the whole check exists to stop.
 *
 * `.` is always a decimal point. European dot-grouping is deliberately not
 * supported: under it "3.391" — which is a real kWp figure this route produces
 * — would read as 3391, and a rule that can silently multiply a number by a
 * thousand has no business guarding one.
 */
export function normalizeFigureToken(token: string): number | null {
  // Sentence punctuation clings to the last digit: "5.05." and "3,".
  let t = token.replace(/[.,]+$/, "");
  const negative = t.startsWith("-");
  if (negative) t = t.slice(1);
  if (t === "") return null;

  let plain: string;
  if (/^\d+$/.test(t) || /^\d+\.\d+$/.test(t)) {
    plain = t;
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    // Thousands grouping: 1,800 and 1,234.56.
    plain = t.replace(/,/g, "");
  } else if (/^\d+,\d{1,2}$/.test(t)) {
    // Decimal comma: 5,05. Unambiguous — a thousands group is three digits.
    plain = t.replace(",", ".");
  } else {
    return null;
  }

  const value = Number(plain);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Digit runs, with their sign and any separators still attached. */
const FIGURE_TOKEN = /-?\d[\d.,]*/g;

export type ExtractedFigure = { token: string; value: number | null };

export function extractFigures(text: string): ExtractedFigure[] {
  return (text.match(FIGURE_TOKEN) ?? []).map((token) => ({
    token,
    value: normalizeFigureToken(token),
  }));
}

/** The figures a piece of prose is permitted to contain. */
export function allowedFigures(factsText: string): Set<number> {
  const allowed = new Set<number>();
  for (const f of extractFigures(factsText)) {
    if (f.value !== null) allowed.add(f.value);
  }
  return allowed;
}

/**
 * Figures in `prose` that are not in `allowed`, plus any token that could not
 * be read at all. First few only — the response is a 502 either way, and the
 * log line exists to be read.
 */
export function unsupportedFigures(prose: string, allowed: Set<number>): string[] {
  const bad: string[] = [];
  for (const f of extractFigures(prose)) {
    if (f.value === null || !allowed.has(f.value)) bad.push(f.token);
  }
  return bad.slice(0, 8);
}

export type OptimizeIssue = { path: string; message: string };

export type OptimizePayloadResult =
  | { ok: true; explanation: string }
  | {
      ok: false;
      reason: "not_json" | "invalid_shape" | "unsupported_figure";
      issues: OptimizeIssue[];
    };

/**
 * Turn one raw model completion into validated prose, or a structured failure.
 * Never throws.
 *
 * `factsText` is the exact string the model was shown. Passing anything else —
 * a summary of it, a rebuilt version of it — breaks the one property this
 * function has: that the permitted figures and the shown figures are the same
 * list.
 */
export function parseOptimizePayload(
  rawContent: string,
  factsText: string,
): OptimizePayloadResult {
  let rec: unknown;

  try {
    rec = JSON.parse(rawContent) as unknown;
  } catch {
    return {
      ok: false,
      reason: "not_json",
      issues: [{ path: "", message: "model response was not valid JSON" }],
    };
  }

  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    return {
      ok: false,
      reason: "invalid_shape",
      issues: [{ path: "", message: "model response was not a JSON object" }],
    };
  }

  // Only `explanation` is read. `optimal_pv_watts` and `optimal_battery_kwh`
  // are ignored even when present: the sizes are computed, and a model that
  // volunteers one must not be able to change a number by doing so. P3.
  const parsed = modelProseSchema.safeParse(
    (rec as Record<string, unknown>)["explanation"],
  );

  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_shape",
      issues: parsed.error.issues.map((issue) => ({
        path: ["explanation", ...issue.path].join("."),
        message: issue.message,
      })),
    };
  }

  const explanation = parsed.data;
  const bad = unsupportedFigures(explanation, allowedFigures(factsText));
  if (bad.length > 0) {
    return {
      ok: false,
      reason: "unsupported_figure",
      issues: bad.map((token) => ({
        path: "explanation",
        message: `figure ${token} is not among the figures the model was given`,
      })),
    };
  }

  return { ok: true, explanation };
}

/** User-facing copy for a failed optimization. Never contains Zod detail. */
// The route writes this in the request's language from the server catalog
// (H2b); this export is the English entry, kept for the payload tests.
export const OPTIMIZE_FAILURE_MESSAGE = serverCatalog.en["error.optimizeModel"];
