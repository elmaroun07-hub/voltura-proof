import { describe, expect, it } from 'vitest';
import { parseZone, formatZone, type ClimateZone } from './cte-zones';
import { checkU, uLimit, airtightnessLimitQ100 } from './cte-u-limits';
import {
  calculateQsolJul,
  hasSolarIrradiationData,
  QSOL_JUL_LIMIT,
  type IrradiationLookup,
  type Opening,
  type QsolJulInput,
} from './qsol-jul';

const ZONE_A4: ClimateZone = { winter: 'A', summer: 4 };

/** Fixed stand-in for Hsol;jul so the arithmetic is testable and exact. */
const fakeIrradiation: IrradiationLookup = (_archipelago, _zone, orientation) => {
  const table: Record<string, number> = {
    S: 100,
    W: 50,
    N: 10,
    HORIZONTAL: 200,
  };
  return table[orientation] ?? null;
};

function opening(overrides: Partial<Opening> = {}): Opening {
  return {
    id: 'w1',
    areaM2: 2,
    frameFraction: 0.3,
    gWithShading: 0.5,
    obstacleShadingFactor: 1,
    orientation: 'S',
    ...overrides,
  };
}

function input(overrides: Partial<QsolJulInput> = {}): QsolJulInput {
  return {
    openings: [opening()],
    usefulFloorAreaM2: 100,
    climateZone: ZONE_A4,
    buildingUse: 'RESIDENTIAL_PRIVATE',
    archipelago: 'peninsular',
    ...overrides,
  };
}

describe('parseZone', () => {
  it('parses standard codes', () => {
    expect(parseZone('A4')).toEqual({ winter: 'A', summer: 4 });
    expect(parseZone('D3')).toEqual({ winter: 'D', summer: 3 });
  });

  it('accepts both alpha spellings', () => {
    expect(parseZone('α2')).toEqual({ winter: 'alpha', summer: 2 });
    expect(parseZone('alpha2')).toEqual({ winter: 'alpha', summer: 2 });
  });

  it('returns null rather than guessing', () => {
    expect(parseZone('F1')).toBeNull();
    expect(parseZone('A5')).toBeNull();
    expect(parseZone('')).toBeNull();
    expect(parseZone('A')).toBeNull();
  });

  it('round-trips through formatZone', () => {
    expect(formatZone({ winter: 'alpha', summer: 4 })).toBe('α4');
    expect(formatZone({ winter: 'E', summer: 1 })).toBe('E1');
  });
});

describe('U-value limits', () => {
  it('matches Tabla 3.1.1.a-HE1 at the extremes', () => {
    expect(uLimit('WALL_OR_FLOOR_EXTERIOR', 'alpha')).toBe(0.8);
    expect(uLimit('WALL_OR_FLOOR_EXTERIOR', 'E')).toBe(0.37);
    expect(uLimit('ROOF_EXTERIOR', 'alpha')).toBe(0.55);
    expect(uLimit('ROOF_EXTERIOR', 'E')).toBe(0.33);
    expect(uLimit('OPENING', 'alpha')).toBe(3.2);
    expect(uLimit('OPENING', 'E')).toBe(1.8);
  });

  it('tightens monotonically from alpha to E', () => {
    const zones = ['alpha', 'A', 'B', 'C', 'D', 'E'] as const;
    for (const element of [
      'WALL_OR_FLOOR_EXTERIOR',
      'ROOF_EXTERIOR',
      'AGAINST_UNHEATED_OR_GROUND',
    ] as const) {
      for (let i = 1; i < zones.length; i++) {
        expect(uLimit(element, zones[i])).toBeLessThanOrEqual(
          uLimit(element, zones[i - 1]),
        );
      }
    }
  });

  it('flags non-compliance with the size of the gap', () => {
    const r = checkU('ROOF_EXTERIOR', 'D', 1.05);
    expect(r.compliant).toBe(false);
    expect(r.limitU).toBe(0.35);
    expect(r.excess).toBeCloseTo(0.7, 10);
    expect(r.ratio).toBeCloseTo(3, 10);
  });

  it('treats a value exactly on the limit as compliant', () => {
    const r = checkU('ROOF_EXTERIOR', 'D', 0.35);
    expect(r.compliant).toBe(true);
    expect(r.excess).toBe(0);
  });

  it('applies the airtightness split at C', () => {
    expect(airtightnessLimitQ100('B')).toBe(27);
    expect(airtightnessLimitQ100('C')).toBe(9);
  });
});

describe('calculateQsolJul — refuses to guess', () => {
  it('has the official irradiation tables loaded', () => {
    // Was `toBe(false)` while SOLAR_IRRADIATION_JULY was an empty stub. The
    // subject changed (tablas 20/21 are now wired), so the assertion changed
    // with it — see the reachability test below for what it was gesturing at.
    expect(hasSolarIrradiationData()).toBe(true);

    const r = calculateQsolJul(input());
    expect(r.ok).toBe(true);
    // A4 peninsular, south: Hsol;jul = 94.78 kWh/m².
    // 1 · 0.5 · (1 − 0.3) · 2 m² · 94.78 = 66.346 kWh/month over 100 m².
    if (r.ok) expect(r.qsolJul).toBeCloseTo(0.66346, 10);
  });

  it('rejects an empty opening list', () => {
    const r = calculateQsolJul(input({ openings: [] }), fakeIrradiation);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_OPENINGS');
  });

  it('rejects a non-positive floor area', () => {
    const r = calculateQsolJul(
      input({ usefulFloorAreaM2: 0 }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_FLOOR_AREA');
  });

  it('rejects out-of-range fractions and names the field', () => {
    const r = calculateQsolJul(
      input({ openings: [opening({ gWithShading: 1.4 })] }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === 'INVALID_OPENING') {
      expect(r.field).toBe('gWithShading');
      expect(r.openingId).toBe('w1');
    } else {
      throw new Error('expected INVALID_OPENING');
    }
  });

  it('rejects an unknown orientation for the zone', () => {
    const r = calculateQsolJul(
      input({ openings: [opening({ orientation: 'NE' })] }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MISSING_SOLAR_IRRADIATION');
  });
});

describe('calculateQsolJul — arithmetic', () => {
  it('applies the formula term by term', () => {
    // 1 · 0.5 · (1 − 0.3) · 2 · 100 = 70 kWh/month; 70 / 100 m² = 0.7
    const r = calculateQsolJul(input(), fakeIrradiation);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.qsolJul).toBeCloseTo(0.7, 10);
      expect(r.limit).toBe(QSOL_JUL_LIMIT.RESIDENTIAL_PRIVATE);
      expect(r.compliant).toBe(true);
      expect(r.ratio).toBeCloseTo(0.35, 10);
    }
  });

  it('sums across openings and sorts contributions descending', () => {
    const r = calculateQsolJul(
      input({
        openings: [
          opening({ id: 'north', orientation: 'N' }),
          opening({ id: 'south', orientation: 'S' }),
          opening({ id: 'west', orientation: 'W' }),
        ],
      }),
      fakeIrradiation,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      // (10 + 100 + 50) · 0.5 · 0.7 · 2 = 112 kWh/month over 100 m²
      expect(r.qsolJul).toBeCloseTo(1.12, 10);
      expect(r.contributions.map((c) => c.id)).toEqual([
        'south',
        'west',
        'north',
      ]);
      const shares = r.contributions.reduce((s, c) => s + c.shareOfTotal, 0);
      expect(shares).toBeCloseTo(1, 10);
    }
  });

  it('marks non-compliance above the residential limit', () => {
    const r = calculateQsolJul(
      input({ openings: [opening({ areaM2: 10, orientation: 'HORIZONTAL' })] }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 1 · 0.5 · 0.7 · 10 · 200 = 700 over 100 m² = 7.0
      expect(r.qsolJul).toBeCloseTo(7, 10);
      expect(r.compliant).toBe(false);
    }
  });

  it('treats a result exactly on the limit as compliant', () => {
    // Need qsolJul === 2.0 exactly: g=1, FF=0, area=2, H=100 → 200/100 = 2
    const r = calculateQsolJul(
      input({
        openings: [
          opening({ gWithShading: 1, frameFraction: 0, areaM2: 2 }),
        ],
      }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.qsolJul).toBeCloseTo(2, 10);
      expect(r.compliant).toBe(true);
    }
  });

  it('applies the higher limit for non-residential use', () => {
    const r = calculateQsolJul(
      input({ buildingUse: 'OTHER' }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limit).toBe(4.0);
  });

  it('drives the result to zero with full external shading', () => {
    const r = calculateQsolJul(
      input({ openings: [opening({ gWithShading: 0 })] }),
      fakeIrradiation,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.qsolJul).toBe(0);
      expect(r.compliant).toBe(true);
    }
  });
});
