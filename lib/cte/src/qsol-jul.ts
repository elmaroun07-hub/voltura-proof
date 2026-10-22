/**
 * qsol;jul — solar control parameter of the thermal envelope.
 *
 * This is the ONLY summer-performance indicator the Spanish building code
 * defines. Implementing it means implementing a regulation rather than
 * inventing a metric, which is why it is the right first module.
 *
 *   qsol;jul = Σₖ( Fsh;obst · ggl;sh;wi · (1 − FF) · Aw;p · Hsol;jul ) / A_util
 *
 * Result is in kWh/m²·month.
 *
 * Limits (DB-HE, Tabla 3.1.2-HE1):
 *   - Private residential use: 2.00 kWh/m²·month
 *   - Other uses:              4.00 kWh/m²·month
 * The limit is set by BUILDING USE, not by summer climate zone.
 *
 * Source: DB-HE (2019 revision, RD 732/2019), consolidated text.
 *   https://www.codigotecnico.org/pdf/Documentos/HE/DccHE.pdf
 *
 * SCOPE WARNING — read before naming anything in the UI.
 * qsol;jul measures SOLAR GAIN THROUGH OPENINGS. It does not model fabric
 * U-values, thermal mass, ventilation, or internal gains. It is a solar
 * control score, not a heat-habitability score. Do not present it as the
 * latter.
 */

import { formatZone, type ClimateZone } from './cte-zones';
import {
  SOLAR_IRRADIATION_JULY,
  getHsolJul,
  orientationFromAzimuth,
  MissingIrradiationError,
  type Archipelago,
  type Surface,
  type Orientation as CteOrientation,
} from './solar-irradiation';

export { SOLAR_IRRADIATION_JULY };
export type { Archipelago };

/** Orientation of an opening. Spanish code in comments for cross-reference. */
export type Orientation =
  | 'N' // Norte
  | 'NE' // Noreste
  | 'E' // Este
  | 'SE' // Sureste
  | 'S' // Sur
  | 'SW' // Suroeste (SO)
  | 'W' // Oeste (O)
  | 'NW' // Noroeste (NO)
  | 'HORIZONTAL';

export type BuildingUse = 'RESIDENTIAL_PRIVATE' | 'OTHER';

/** qsol;jul limit in kWh/m²·month, by building use. Tabla 3.1.2-HE1. */
export const QSOL_JUL_LIMIT: Readonly<Record<BuildingUse, number>> =
  Object.freeze({
    RESIDENTIAL_PRIVATE: 2.0,
    OTHER: 4.0,
  });

export interface Opening {
  /** Stable identifier, e.g. "living-room-south-1". Used in the breakdown. */
  readonly id: string;
  /** Aw;p — total area of the opening (frame included), m². */
  readonly areaM2: number;
  /** FF — frame fraction, 0 to 1. The glazed fraction is (1 − FF). */
  readonly frameFraction: number;
  /**
   * ggl;sh;wi — total solar energy transmittance of the glazing WITH the
   * mobile shading device activated, 0 to 1.
   * Values come from DA DB-HE/1. See SOLAR_FACTORS below.
   */
  readonly gWithShading: number;
  /**
   * Fsh;obst — correction factor for shading from remote obstacles
   * (overhangs, fins, neighbouring buildings), 0 to 1.
   * 1.0 means no obstruction.
   */
  readonly obstacleShadingFactor: number;
  readonly orientation: Orientation;
}

export interface QsolJulInput {
  readonly openings: readonly Opening[];
  /** A_util — useful (conditioned) floor area, m². */
  readonly usefulFloorAreaM2: number;
  readonly climateZone: ClimateZone;
  readonly buildingUse: BuildingUse;
  /**
   * REQUIRED, never defaulted. Eleven zone codes appear in both the peninsular
   * and Canary tables with different values; C2 south is 88.17 peninsular vs
   * 55.33 canary (59.4% overstatement). Defaulting to 'peninsular' here is
   * exactly that bug, so the archipelago must be resolved from the province
   * via archipelagoForProvince() before calling this.
   */
  readonly archipelago: Archipelago;
}

export interface OpeningContribution {
  readonly id: string;
  /** kWh/month contributed by this opening, before dividing by A_util. */
  readonly gainKWhPerMonth: number;
  /** Share of the total gain, 0 to 1. Drives "which window is the problem". */
  readonly shareOfTotal: number;
  readonly orientation: Orientation;
}

export interface QsolJulSuccess {
  readonly ok: true;
  /** qsol;jul in kWh/m²·month. */
  readonly qsolJul: number;
  readonly limit: number;
  readonly compliant: boolean;
  /** qsolJul / limit. >1 means non-compliant. */
  readonly ratio: number;
  /** Sorted descending by contribution — the retrofit priority list. */
  readonly contributions: readonly OpeningContribution[];
}

export type QsolJulError =
  | { readonly ok: false; readonly code: 'NO_OPENINGS' }
  | { readonly ok: false; readonly code: 'INVALID_FLOOR_AREA'; readonly value: number }
  | {
      readonly ok: false;
      readonly code: 'INVALID_OPENING';
      readonly openingId: string;
      readonly field: keyof Opening;
      readonly value: number;
      readonly expected: string;
    }
  | {
      readonly ok: false;
      readonly code: 'MISSING_SOLAR_IRRADIATION';
      readonly orientation: Orientation;
      readonly zone: string;
      readonly hint: string;
    };

export type QsolJulResult = QsolJulSuccess | QsolJulError;

/**
 * Domain orientation (English) → CTE data key (Spanish, as printed in the PDF).
 *
 * ⚠️ 'O' is OESTE — WEST. Reading it as an abbreviation for East writes a 180°
 * error that produces entirely plausible numbers. Likewise SO = Suroeste = SW
 * and NO = Noroeste = NW.
 *
 * `satisfies` keeps this exhaustive: adding an Orientation without adding its
 * surface here fails to compile rather than silently dropping a window.
 */
const ORIENTATION_TO_SURFACE = {
  N: 'N',
  NE: 'NE',
  E: 'E',
  SE: 'SE',
  S: 'S',
  SW: 'SO',
  W: 'O',
  NW: 'NO',
  HORIZONTAL: 'horiz',
} satisfies Record<Orientation, Surface>;

/**
 * CTE data key (Spanish) → domain orientation (English). Inverse of the map
 * above, minus HORIZONTAL, which no compass bearing can produce.
 */
const SURFACE_TO_ORIENTATION = {
  N: 'N',
  NE: 'NE',
  E: 'E',
  SE: 'SE',
  S: 'S',
  SO: 'SW',
  O: 'W',
  NO: 'NW',
} satisfies Record<CteOrientation, Orientation>;

/**
 * Compass bearing (degrees clockwise from NORTH) → domain orientation.
 *
 * Delegates the sector boundaries to orientationFromAzimuth so the CTE figura 8
 * sectors are defined in exactly one place. They are NOT uniform 45° bins —
 * Sur spans 36°, Este spans 51° — so never bin by round(bearing / 45).
 */
export function orientationFromBearing(bearingFromNorthDeg: number): Orientation {
  return SURFACE_TO_ORIENTATION[orientationFromAzimuth(bearingFromNorthDeg)];
}

/** True once the official Hsol;jul tables are present for both archipelagos. */
export function hasSolarIrradiationData(): boolean {
  return (
    Object.keys(SOLAR_IRRADIATION_JULY.peninsular).length > 0 &&
    Object.keys(SOLAR_IRRADIATION_JULY.canary).length > 0
  );
}

/**
 * ggl;sh;wi reference values from DA DB-HE/1.
 *
 * DELIBERATELY NOT POPULATED beyond a single UNVERIFIED example.
 *
 * ⚠️ HARD STOP — NOT WIRED, AND MUST NOT BE. This table is not consulted by
 * calculateQsolJul and no opening may fall back to it. ggl;sh;wi must be
 * caller-supplied per opening; an omitted value fails validation with
 * INVALID_OPENING rather than adopting a default. An unverified solar factor
 * silently flips a compliant/non-compliant verdict.
 *
 * TODO(da-db-he-1): transcribe the full glazing × shading-device matrix.
 */
export interface SolarFactorEntry {
  readonly glazing: string;
  readonly shadingDevice: string;
  readonly g: number;
  readonly source: string;
}

export const SOLAR_FACTORS: readonly SolarFactorEntry[] = Object.freeze([
  {
    glazing: 'Double glazing, low-emissivity',
    shadingDevice: 'Exterior roller blind, pastel colour, activated',
    g: 0.05,
    source: 'DA DB-HE/1 — verify exact row and revision before relying on it',
  },
]);

function isFraction(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Calculate qsol;jul.
 *
 * Returns a discriminated union rather than throwing or falling back to a
 * default. A silent default here would be indistinguishable from a real
 * result, which is how bad numbers reach users.
 */
export type IrradiationLookup = (
  archipelago: Archipelago,
  zone: ClimateZone,
  orientation: Orientation,
) => number | null;

/**
 * Official source. Resolves the zone via formatZone() so 'alpha' renders as the
 * printed 'α' (U+03B1) — a raw `${winter}${summer}` template yields "alpha3",
 * which matches no row and would throw on every Canary lookup below the α
 * threshold. Throws MissingIrradiationError rather than returning a fallback.
 */
const officialIrradiationLookup: IrradiationLookup = (
  archipelago,
  zone,
  orientation,
) => getHsolJul(archipelago, formatZone(zone), ORIENTATION_TO_SURFACE[orientation]);

export function calculateQsolJul(
  input: QsolJulInput,
  /**
   * Override the Hsol;jul source. Defaults to the official table.
   * Injectable so tests can exercise the arithmetic with fixed values, and so
   * an alternative dataset can be swapped in without touching this function.
   */
  irradiationLookup: IrradiationLookup = officialIrradiationLookup,
): QsolJulResult {
  const { openings, usefulFloorAreaM2, climateZone, buildingUse, archipelago } = input;

  if (openings.length === 0) {
    return { ok: false, code: 'NO_OPENINGS' };
  }

  if (!Number.isFinite(usefulFloorAreaM2) || usefulFloorAreaM2 <= 0) {
    return {
      ok: false,
      code: 'INVALID_FLOOR_AREA',
      value: usefulFloorAreaM2,
    };
  }

  for (const o of openings) {
    if (!Number.isFinite(o.areaM2) || o.areaM2 <= 0) {
      return {
        ok: false,
        code: 'INVALID_OPENING',
        openingId: o.id,
        field: 'areaM2',
        value: o.areaM2,
        expected: 'a positive number of square metres',
      };
    }
    if (!isFraction(o.frameFraction)) {
      return {
        ok: false,
        code: 'INVALID_OPENING',
        openingId: o.id,
        field: 'frameFraction',
        value: o.frameFraction,
        expected: 'a fraction between 0 and 1',
      };
    }
    if (!isFraction(o.gWithShading)) {
      return {
        ok: false,
        code: 'INVALID_OPENING',
        openingId: o.id,
        field: 'gWithShading',
        value: o.gWithShading,
        expected: 'a fraction between 0 and 1',
      };
    }
    if (!isFraction(o.obstacleShadingFactor)) {
      return {
        ok: false,
        code: 'INVALID_OPENING',
        openingId: o.id,
        field: 'obstacleShadingFactor',
        value: o.obstacleShadingFactor,
        expected: 'a fraction between 0 and 1',
      };
    }
  }

  const gains: { id: string; gain: number; orientation: Orientation }[] = [];

  for (const o of openings) {
    let hsol: number | null;
    try {
      hsol = irradiationLookup(archipelago, climateZone, o.orientation);
    } catch (err) {
      // Surface the source message intact — a silent zero here would read as
      // a compliant verdict.
      return {
        ok: false,
        code: 'MISSING_SOLAR_IRRADIATION',
        orientation: o.orientation,
        zone: formatZone(climateZone),
        hint: err instanceof MissingIrradiationError ? err.message : String(err),
      };
    }

    if (hsol === null) {
      return {
        ok: false,
        code: 'MISSING_SOLAR_IRRADIATION',
        orientation: o.orientation,
        zone: formatZone(climateZone),
        hint:
          `No Hsol;jul available for ${formatZone(climateZone)} ` +
          `(${archipelago}) facing ${o.orientation}.`,
      };
    }

    const glazedFraction = 1 - o.frameFraction;
    const gain =
      o.obstacleShadingFactor * o.gWithShading * glazedFraction * o.areaM2 * hsol;

    gains.push({ id: o.id, gain, orientation: o.orientation });
  }

  const totalGain = gains.reduce((sum, g) => sum + g.gain, 0);
  const qsolJul = totalGain / usefulFloorAreaM2;
  const limit = QSOL_JUL_LIMIT[buildingUse];

  const contributions: OpeningContribution[] = gains
    .map((g) => ({
      id: g.id,
      gainKWhPerMonth: g.gain,
      shareOfTotal: totalGain === 0 ? 0 : g.gain / totalGain,
      orientation: g.orientation,
    }))
    .sort((a, b) => b.gainKWhPerMonth - a.gainKWhPerMonth);

  return {
    ok: true,
    qsolJul,
    limit,
    compliant: qsolJul <= limit,
    ratio: qsolJul / limit,
    contributions,
  };
}
