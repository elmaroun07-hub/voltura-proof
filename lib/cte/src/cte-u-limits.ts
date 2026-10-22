/**
 * CTE DB-HE thermal transmittance (U-value) limits and airtightness limits.
 *
 * Source: DB-HE, Tabla 3.1.1.a-HE1 (Ulim, W/m²K) and Tabla 3.1.3.a-HE1 (Q100).
 *   https://www.codigotecnico.org/pdf/Documentos/HE/DccHE.pdf
 *
 * IMPORTANT: these limits are indexed to the WINTER zone only. The regulation
 * does not vary them by summer severity. Treat them as a heating-side
 * benchmark; they are not a summer-performance criterion.
 */

import type { WinterZone } from './cte-zones';

/** Building envelope element categories used by Tabla 3.1.1.a-HE1. */
export type EnvelopeElement =
  /** Muros y suelos en contacto con el aire exterior (UM, US). */
  | 'WALL_OR_FLOOR_EXTERIOR'
  /** Cubiertas en contacto con el aire exterior (UC). */
  | 'ROOF_EXTERIOR'
  /** Elementos en contacto con espacios no habitables o el terreno (UT). */
  | 'AGAINST_UNHEATED_OR_GROUND'
  /** Huecos (ventanas y puertas acristaladas) (UH). */
  | 'OPENING'
  /** Puertas con superficie semitransparente igual o inferior al 50%. */
  | 'DOOR_SEMI_TRANSPARENT_LTE_50PCT';

/**
 * Maximum U-value in W/m²K, by element and winter zone.
 * Transcribed verbatim from Tabla 3.1.1.a-HE1.
 */
export const U_LIMITS: Readonly<
  Record<EnvelopeElement, Readonly<Record<WinterZone, number>>>
> = Object.freeze({
  WALL_OR_FLOOR_EXTERIOR: Object.freeze({
    alpha: 0.8,
    A: 0.7,
    B: 0.56,
    C: 0.49,
    D: 0.41,
    E: 0.37,
  }),
  ROOF_EXTERIOR: Object.freeze({
    alpha: 0.55,
    A: 0.5,
    B: 0.44,
    C: 0.4,
    D: 0.35,
    E: 0.33,
  }),
  AGAINST_UNHEATED_OR_GROUND: Object.freeze({
    alpha: 0.9,
    A: 0.8,
    B: 0.75,
    C: 0.7,
    D: 0.65,
    E: 0.59,
  }),
  OPENING: Object.freeze({
    alpha: 3.2,
    A: 2.7,
    B: 2.3,
    C: 2.1,
    D: 1.8,
    E: 1.8,
  }),
  DOOR_SEMI_TRANSPARENT_LTE_50PCT: Object.freeze({
    alpha: 5.7,
    A: 5.7,
    B: 5.7,
    C: 5.7,
    D: 5.7,
    E: 5.7,
  }),
});

export function uLimit(element: EnvelopeElement, winter: WinterZone): number {
  return U_LIMITS[element][winter];
}

export interface UComplianceResult {
  readonly element: EnvelopeElement;
  readonly actualU: number;
  readonly limitU: number;
  readonly compliant: boolean;
  /** Positive = how far above the limit, in W/m²K. Zero if compliant. */
  readonly excess: number;
  /** actualU / limitU. >1 means non-compliant. Useful for ranking severity. */
  readonly ratio: number;
}

export function checkU(
  element: EnvelopeElement,
  winter: WinterZone,
  actualU: number,
): UComplianceResult {
  const limitU = uLimit(element, winter);
  const compliant = actualU <= limitU;
  return {
    element,
    actualU,
    limitU,
    compliant,
    excess: compliant ? 0 : actualU - limitU,
    ratio: actualU / limitU,
  };
}

/**
 * Airtightness limit Q100 (m³/h·m² at 100 Pa), Tabla 3.1.3.a-HE1.
 * Zones α, A and B: ≤ 27. Zones C, D and E: ≤ 9.
 */
export function airtightnessLimitQ100(winter: WinterZone): number {
  return winter === 'alpha' || winter === 'A' || winter === 'B' ? 27 : 9;
}

/**
 * Typical U-values for existing Spanish construction by build year.
 *
 * DELIBERATELY NOT POPULATED.
 *
 * What is legally established: NBE-CT-79 (1979) was Spain's first thermal
 * regulation, so pre-1980 stock generally has no designed insulation. That is
 * a defensible qualitative statement.
 *
 * What is NOT established: specific U-values for "typical 1960s cavity wall in
 * Murcia". Those defaults exist inside CE3x's construction library and must be
 * taken from there (or from IDAE stock characterisation), with the source
 * recorded per value. Inventing them would put fabricated numbers at the base
 * of every recommendation — the exact failure mode this product exists to
 * correct.
 *
 * TODO(defaults): extract from the CE3x construction library, citing version.
 */
export interface ConstructionDefault {
  readonly element: EnvelopeElement;
  readonly builtFromYear: number;
  readonly builtToYear: number;
  readonly typicalU: number;
  /** Required. Every value must name where it came from. */
  readonly source: string;
}

export const CONSTRUCTION_DEFAULTS: readonly ConstructionDefault[] =
  Object.freeze([]);

/** True once someone has done the transcription work. Gate features on this. */
export function hasConstructionDefaults(): boolean {
  return CONSTRUCTION_DEFAULTS.length > 0;
}
