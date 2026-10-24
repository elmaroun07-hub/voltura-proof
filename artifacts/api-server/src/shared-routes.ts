import { z } from 'zod/v4';
import { calculationInputSchema, calculations } from '@workspace/db';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// ── LLM payload tolerance ────────────────────────────────────────────────────
// NOTE: mirrored in artifacts/green-energy-calculator/src/lib/api.ts — keep in sync.
// `response_format: json_object` guarantees the model returns valid JSON, but NOT
// the shape of any value. In production `explanation` arrives as a plain string,
// an object of labelled parts, or an array of bullets, varying between calls.
// Normalize all three to readable text; return "" when nothing usable is present
// so the .pipe() below FAILS the parse rather than emitting an empty explanation.

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function normalizeText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || typeof value !== 'object' || depth > 2) return '';

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item, depth + 1))
      .filter(Boolean)
      .join(' ');
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([key, val]) => {
      const text = normalizeText(val, depth + 1);
      return text ? `${humanizeKey(key)}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

// Exported for the /api/optimize payload boundary, which validates the model's
// prose before the route ever builds a response. One normalizer, used by the
// thing that checks the model and by the thing that types the response — P5.
export const modelProseSchema = z
  .unknown()
  .transform((value) => normalizeText(value))
  .pipe(z.string().min(1, 'could not be normalized to readable text'));

// H-OPT sizing record. Every field is computed by `lib/sizing.ts` from NASA
// POWER irradiance and the user's metered annual usage; none of it comes from a
// model. It travels in the response because a recommended array size means
// nothing without the irradiance, the load and the four assumptions it was
// divided by — the same argument `irradiancePeriod` settled for the mean.
const sizingSchema = z.object({
  pvKwp: z.number(),
  pvWatts: z.number(),
  batteryKwh: z.number(),
  annualUsageKwh: z.number(),
  dailyUsageKwh: z.number(),
  nightUsageKwh: z.number(),
  nightShare: z.number(),
  darkHours: z.number(),
  irradianceKwhM2Day: z.number(),
  coverageTarget: z.number(),
  performanceRatio: z.number(),
  roundTripEfficiency: z.number(),
  usableDepthOfDischarge: z.number(),
  daysPerYear: z.number(),
});

// H-SRC-ES-UK. Location-based carbon, resolved per electric system. Mirrors
// SourcedLocationFactor in ../lib/emissions/countries.ts.
const sourcedCarbonFactorSchema = z.object({
  status: z.literal('sourced'),
  system: z.string(),
  valueGPerKwh: z.number(),
  basis: z.literal('generation'),
  authority: z.string(),
  publication: z.object({
    title: z.string(),
    url: z.string(),
    published: z.string(),
    retrieved: z.string(),
  }),
  activityYear: z.number(),
});

// Mirrors CarbonSourceNote in ../lib/emissions/carbon-source.ts. Five honest
// states, no sixth where a number ships without saying which of these it is.
const carbonSourceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('sourced'),
    country: z.string(),
    factor: sourcedCarbonFactorSchema,
  }),
  z.object({
    status: z.literal('pending'),
    country: z.string(),
    system: z.string().nullable(),
    reason: z.enum(['system_factor_pending', 'system_undetermined']),
    detail: z.string(),
  }),
  z.object({
    status: z.literal('unsourced_legacy'),
    country: z.string(),
    valueKgPerKwh: z.number(),
  }),
  z.object({
    status: z.literal('unknown_country'),
    attempted: z.string(),
  }),
  z.object({
    status: z.literal('not_reached'),
  }),
]);

// A1 provenance record: where each user-facing number's inputs came from.
const resolutionSchema = z.object({
  locationInput: z.string(),
  geocodeStatus: z.enum(['resolved', 'failed']),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  irradianceSource: z.enum(['nasa-live', 'fallback-lat', 'not-reached']),
  // H1.8: the period the figure was actually computed over, not the period
  // that was requested. Null whenever no NASA figure was used at all.
  // A mean is meaningless without the years it spans, so this travels with it.
  irradiancePeriod: z
    .object({ start: z.number(), end: z.number() })
    .nullable(),
  nasaHttpStatus: z.union([
    z.number(),
    z.literal('not-called'),
    z.literal('request-failed'),
  ]),
  nasaKeysRequested: z.array(z.string()),
  nasaKeysPresent: z.array(z.string()),
  irradianceMonthly: z.array(z.number()),
  // H-SRC-ES. Populated alongside geocoding for both /api/calculate and
  // /api/optimize — see routes.ts's ResolutionRecord for why it is shared.
  carbonSource: carbonSourceSchema,
});

// H-SRC-ES-UK. The money block: every part USED with its source named, or
// PENDING with a typed reason. Mirrors MoneyBlock in ../lib/emissions/money.ts.
const currencySchema = z.enum(['EUR', 'GBP']);
const taxBasisSchema = z.enum(['all_taxes_included', 'vat_where_applicable', 'excl_vat']);

const tariffUsedSchema = z.union([
  z.object({ status: z.literal('used'), source: z.literal('user'), value: z.number(), label: z.string() }),
  z.object({
    status: z.literal('used'),
    source: z.literal('registry'),
    value: z.number(),
    label: z.string(),
    taxBasis: taxBasisSchema,
    authority: z.string(),
    period: z.object({ label: z.string(), start: z.string(), end: z.string() }),
    reviewBy: z.string(),
    publicationUrl: z.string(),
  }),
  z.object({
    status: z.literal('pending'),
    reason: z.enum(['country_not_in_registry', 'registry_tariff_pending', 'registry_tariff_stale']),
    detail: z.string(),
  }),
]);

const installCostUsedSchema = z.union([
  z.object({ status: z.literal('used'), source: z.literal('user'), amount: z.number() }),
  z.object({
    status: z.literal('used'),
    source: z.literal('registry_band'),
    amount: z.number(),
    perKw: z.number(),
    kwp: z.number(),
    band: z.object({ fromKw: z.number(), toKw: z.number() }),
    taxBasis: taxBasisSchema,
    authority: z.string(),
    edition: z.string(),
    label: z.string(),
  }),
  z.object({
    status: z.literal('used'),
    source: z.literal('registry_range'),
    low: z.number(),
    high: z.number(),
    perKwLow: z.number(),
    perKwHigh: z.number(),
    kwp: z.number(),
    taxBasis: taxBasisSchema,
    authority: z.string(),
    edition: z.string(),
    label: z.string(),
  }),
  z.object({
    status: z.literal('pending'),
    reason: z.enum([
      'country_not_in_registry',
      'registry_cost_pending',
      'battery_not_in_registry_cost',
      'size_outside_registry_bands',
    ]),
    detail: z.string(),
  }),
]);

const roiUsedSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('computed'),
    // null = never paid back within the horizon: a state, never a number (D7).
    paybackYears: z.number().nullable(),
    curve: z.array(z.object({ year: z.number(), cumulativeSavings: z.number(), netPosition: z.number() })),
    lifetimeSavings: z.number(),
  }),
  z.object({ status: z.literal('pending'), detail: z.string() }),
]);

const moneyBlockSchema = z.object({
  // Null only for a country outside the registry: no currency is known, so none is guessed.
  currency: currencySchema.nullable(),
  tariff: tariffUsedSchema,
  annualSavings: z.number().nullable(),
  installCost: installCostUsedSchema,
  roi: roiUsedSchema,
});

// NOTE: mirrored in artifacts/green-energy-calculator/src/lib/api.ts — keep in sync;
// nothing compares the two automatically.
export const monthlyEntrySchema = z.object({
  month: z.number(),
  name: z.string(),
  generationKwh: z.number(),
  consumptionKwh: z.number(),
  savingsKwh: z.number(),
  gridImportKwh: z.number(),
  co2Kg: z.number(),
  // The flows the engine records (H-D8D52). Generated = pvDirect + batteryCharge
  // + surplus; Consumed = pvDirect + batteryDischarge + gridImport. Each rounded
  // to 0.1 kWh. A stored row written before H-D8D52 has none of them.
  pvDirectKwh: z.number(),
  batteryChargeKwh: z.number(),
  batteryDischargeKwh: z.number(),
  surplusKwh: z.number(),
});

export const api = {
  calculations: {
    create: {
      method: 'POST' as const,
      path: '/api/calculate',
      input: calculationInputSchema,
      responses: {
        200: z.object({
          // The calculations row this response was stored as - the row the PDF
          // route renders. Taken from the insert itself, never derived.
          id: z.number().int().positive(),
          savingsKwh: z.number(),
          co2Reduction: z.number(),
          carbonIntensity: z.number(),
          avgIrradiance: z.number(),
          irradianceSource: z.string(),
          recommendation: z.string(),
          breakdown: z.object({
            solar: z.number(),
            grid: z.number(),
            battery: z.number(),
          }),
          monthlyData: z.array(monthlyEntrySchema),
          money: moneyBlockSchema,
          resolution: resolutionSchema,
        }),
        400: errorSchemas.validation,
      },
    },
    history: {
      method: 'GET' as const,
      path: '/api/history',
      responses: {
        200: z.array(z.custom<typeof calculations.$inferSelect>()),
      },
    },
    optimize: {
      method: 'POST' as const,
      path: '/api/optimize',
      input: z.object({
        // 24 hourly weights describing WHEN the load happens. A shape, not a
        // magnitude: the server normalizes it to sum 1. The old prompt called
        // this "24h Energy Pattern (kWh)" and the client's fixed profile sums
        // to 102, so every recommendation was sized for a 102 kWh/day house.
        energyPattern: z
          .array(z.number().min(0, 'an hourly weight cannot be negative'))
          .length(24, 'energyPattern must carry one weight per hour of the day'),
        // H-D17: same cap as calculationInputSchema.location - it reaches the
        // same geocoder.
        location: z.string().max(200),
        // The magnitude, and it is REQUIRED. There is no default: a missing
        // usage is a 400, never a substituted 5,000 (G5, P2). Bounds match
        // `calculationInputSchema.energyUsage` so the two routes cannot
        // disagree about what a plausible household is.
        annualUsageKwh: z.number().min(100).max(100000),
      }),
      responses: {
        200: z.object({
          // Computed, never model-supplied. `llmNumberSchema` used to sit here,
          // tolerating "5000" from a model because a model was choosing the
          // size. It no longer is, so a string here is now a defect and fails.
          optimalPv: z.number(),
          optimalBattery: z.number(),
          explanation: modelProseSchema,
          sizing: sizingSchema,
          resolution: resolutionSchema,
        }),
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

export type CalculationResponse = z.infer<typeof api.calculations.create.responses[200]>;
export type HistoryResponse = z.infer<typeof api.calculations.history.responses[200]>;
export type CalculationInput = z.infer<typeof calculationInputSchema>;
