/**
 * H3.2 — façade orientation, derived from footprint geometry.
 *
 * Inferred, not sourced. The Catastro publishes footprints, not façades; which
 * walls face the sky and which face a neighbour is computed here from the
 * shape of the block. The output carries `basis: "inferred-from-footprint"` so
 * no consumer can present it as a surveyed fact.
 *
 * Orientation bins are the CTE's own (DA DB-HE/1 figura 8), taken from
 * @workspace/cte's orientationFromAzimuth — one implementation (P5). The CTE
 * sectors are not uniform 45° bins; re-deriving them here would be a second,
 * divergent copy.
 */
import { orientationFromAzimuth } from "@workspace/cte";

/**
 * CTE compass code (N, NE, E, SE, S, SO, O, NO). Taken from the return type of
 * orientationFromAzimuth: @workspace/cte's barrel exports a different
 * `Orientation` (qsol-jul's English names), and this one must be the CTE's.
 */
export type Orientation = ReturnType<typeof orientationFromAzimuth>;

export const CTE_ORIENTATIONS: readonly Orientation[] = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SO",
  "O",
  "NO",
] as const;

/** One edge of a building outline, as returned by FACADE_SEGMENTS_SQL. */
export interface FacadeSegment {
  /** 1 = outer ring; >1 = a courtyard ring. */
  readonly ring: number;
  /** Edge direction, clockwise from north, degrees, for a clockwise-forced ring. */
  readonly azimuthDeg: number;
  readonly lengthM: number;
  /** Part of the edge inside the neighbour zone (party wall). */
  readonly sharedM: number;
}

export type MetresByOrientation = Record<Orientation, number>;

export interface FacadeProfile {
  readonly basis: "inferred-from-footprint";
  readonly perimeterM: number;
  readonly partyWallM: number;
  /** Exposed outer-ring façade, metres per CTE orientation. */
  readonly street: MetresByOrientation;
  /** Exposed courtyard façade, metres per CTE orientation. */
  readonly courtyard: MetresByOrientation;
}

export class FacadeGeometryError extends Error {
  override name = "FacadeGeometryError";
}

/**
 * Outward normal of an edge of a clockwise-forced ring.
 *
 * Walking a clockwise outer ring (or a counter-clockwise courtyard ring) the
 * building lies on the right, so outward is to the left: azimuth − 90°.
 * Check on the unit square walked clockwise, (0,0)→(0,1)→(1,1)→(1,0): the
 * first edge points north (0°) and is the west wall; 0° − 90° = 270° = west.
 */
export function outwardNormalDeg(edgeAzimuthDeg: number): number {
  return (((edgeAzimuthDeg - 90) % 360) + 360) % 360;
}

function zero(): MetresByOrientation {
  return { N: 0, NE: 0, E: 0, SE: 0, S: 0, SO: 0, O: 0, NO: 0 };
}

/**
 * Sum one building's edges into exposed metres per CTE orientation.
 * Throws on an empty outline or on a value no geometry can produce, rather
 * than returning a profile of zeros that would read as "no façade".
 */
export function facadeProfile(segments: readonly FacadeSegment[]): FacadeProfile {
  if (segments.length === 0) {
    throw new FacadeGeometryError("building has no outline edges");
  }
  const street = zero();
  const courtyard = zero();
  let perimeter = 0;
  let party = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.azimuthDeg) || !Number.isFinite(s.lengthM) || !Number.isFinite(s.sharedM)) {
      throw new FacadeGeometryError(`non-finite edge value ${JSON.stringify(s)}`);
    }
    if (s.lengthM <= 0 || s.sharedM < 0) {
      throw new FacadeGeometryError(`impossible edge lengths ${JSON.stringify(s)}`);
    }
    // ST_Intersection can return a hair more than the edge on collinear input.
    const shared = Math.min(s.sharedM, s.lengthM);
    const exposed = s.lengthM - shared;
    perimeter += s.lengthM;
    party += shared;
    const bin = orientationFromAzimuth(outwardNormalDeg(s.azimuthDeg));
    if (s.ring === 1) street[bin] += exposed;
    else if (s.ring > 1) courtyard[bin] += exposed;
    else throw new FacadeGeometryError(`ring index ${s.ring} is not 1-based`);
  }
  return {
    basis: "inferred-from-footprint",
    perimeterM: perimeter,
    partyWallM: party,
    street,
    courtyard,
  };
}

/** Total exposed metres in a profile (street + courtyard). */
export function exposedTotalM(p: FacadeProfile): number {
  let t = 0;
  for (const o of CTE_ORIENTATIONS) t += p.street[o] + p.courtyard[o];
  return t;
}
