/**
 * H3.3 — CTE climate zone per building (province + altitude, via cte-zones).
 * H3.4 — July solar irradiation on each building's exposed façades, by zone
 *        and inferred orientation (via solar-irradiation, DA DB-HE/1 tabla 20).
 *
 * Both tables are @workspace/cte's — one source each (P5). Nothing here
 * substitutes a zone or an irradiation value when a lookup fails: it throws
 * (P2), because a wrong zone silently moves every building's position in the
 * ranking.
 */
import {
  PROVINCE_KEYS,
  archipelagoForProvince,
  formatZone,
  getHsolJul,
  lookupZone,
  type Archipelago,
  type SummerZone,
  type WinterZone,
} from "@workspace/cte";
import { CTE_ORIENTATIONS, type FacadeProfile } from "./orientation";

export class ClimateLookupError extends Error {
  override name = "ClimateLookupError";
}

export interface BuildingZone {
  readonly province: string;
  readonly altitudeM: number;
  readonly archipelago: Archipelago;
  /** As printed in the CTE, e.g. "B4", "α3". */
  readonly zone: string;
  readonly winter: WinterZone;
  readonly summer: SummerZone;
}

/**
 * Province key must match climate-zones.json exactly (INE spelling, inverted
 * articles: 'Palmas, Las'). Córdoba is "Córdoba", with the accent.
 */
export function zoneFor(province: string, altitudeM: number): BuildingZone {
  if (!Number.isFinite(altitudeM)) {
    throw new ClimateLookupError(`altitude is not a number: ${altitudeM}`);
  }
  const archipelago = archipelagoForProvince(province, PROVINCE_KEYS);
  const r = lookupZone(province, altitudeM);
  if (!r.ok) {
    throw new ClimateLookupError(`no CTE zone for ${province} at ${altitudeM} m: ${r.reason}`);
  }
  return {
    province,
    altitudeM,
    archipelago,
    zone: formatZone(r.zone),
    winter: r.zone.winter,
    summer: r.zone.summer,
  };
}

export interface JulyExposure {
  readonly zone: string;
  /**
   * Σ over exposed street façades of (length × Hsol;jul of its orientation):
   * kWh per metre of wall height, July. The building's height is not in it —
   * that is the envelope term's business, not this one's.
   */
  readonly streetKwhPerMetreHeight: number;
  /** Length-weighted mean Hsol;jul over exposed street façades; null if none is exposed. */
  readonly streetMeanHsolJul: number | null;
  /** Same sum over courtyard façades. Reported apart: courtyards are self-shaded. */
  readonly courtyardKwhPerMetreHeight: number;
  /** Hsol;jul on a horizontal surface — the roof — in this zone, kWh/m². */
  readonly roofHsolJul: number;
}

export function julyExposure(z: BuildingZone, f: FacadeProfile): JulyExposure {
  let street = 0;
  let streetLen = 0;
  let court = 0;
  for (const o of CTE_ORIENTATIONS) {
    const h = getHsolJul(z.archipelago, z.zone, o);
    street += f.street[o] * h;
    streetLen += f.street[o];
    court += f.courtyard[o] * h;
  }
  return {
    zone: z.zone,
    streetKwhPerMetreHeight: street,
    streetMeanHsolJul: streetLen > 0 ? street / streetLen : null,
    courtyardKwhPerMetreHeight: court,
    roofHsolJul: getHsolJul(z.archipelago, z.zone, "horiz"),
  };
}
