import { describe, expect, it } from 'vitest';
import {
  SOLAR_IRRADIATION_JULY,
  CANARY_PROVINCES,
  MissingIrradiationError,
  UnknownProvinceError,
  archipelagoForProvince,
  getHsolJul,
  orientationFromAzimuth,
  type Archipelago,
  type Surface,
} from './solar-irradiation';
import {
  PROVINCE_KEYS,
  ZONE_BY_PROVINCE_ALTITUDE,
  formatZone,
  parseZone,
  lookupZone,
} from './cte-zones';
import {
  calculateQsolJul,
  orientationFromBearing,
  type Opening,
  type QsolJulInput,
} from './qsol-jul';
import climateZones from './climate-zones.json';
import rawJson from './solar-irradiation.json';

const cz = climateZones as Record<string, Record<string, string>>;
const raw = rawJson as unknown as Record<Archipelago, Record<string, Record<string, number>>>;
const ARCHIPELAGOS: readonly Archipelago[] = ['peninsular', 'canary'];

// ── Ported from solar-irradiation.verify.mjs ─────────────────────────────────

describe('Hsol;jul table integrity', () => {
  it('matches the JSON artifact cell for cell', () => {
    let compared = 0;
    for (const arch of ARCHIPELAGOS) {
      for (const [zone, row] of Object.entries(raw[arch])) {
        for (const [surface, value] of Object.entries(row)) {
          expect(SOLAR_IRRADIATION_JULY[arch][zone][surface as Surface]).toBe(value);
          compared++;
        }
      }
    }
    expect(compared).toBe(279);
  });

  it('has 12 peninsular zones and 19 canary zones, 9 surfaces each', () => {
    expect(Object.keys(SOLAR_IRRADIATION_JULY.peninsular)).toHaveLength(12);
    expect(Object.keys(SOLAR_IRRADIATION_JULY.canary)).toHaveLength(19);
    for (const arch of ARCHIPELAGOS) {
      for (const row of Object.values(SOLAR_IRRADIATION_JULY[arch])) {
        expect(Object.keys(row)).toHaveLength(9);
      }
    }
  });

  it('has no α zones on the peninsula', () => {
    const alphas = Object.keys(SOLAR_IRRADIATION_JULY.peninsular).filter((z) =>
      z.startsWith('α'),
    );
    expect(alphas).toEqual([]);
  });

  it('puts horizontal above every vertical surface in July', () => {
    for (const arch of ARCHIPELAGOS) {
      for (const [zone, row] of Object.entries(SOLAR_IRRADIATION_JULY[arch])) {
        const verticals = Object.entries(row)
          .filter(([k]) => k !== 'horiz')
          .map(([, v]) => v);
        expect(row.horiz, `${arch} ${zone}`).toBeGreaterThan(Math.max(...verticals));
      }
    }
  });

  it('makes NORTH darkest on the peninsula but SOUTH darkest in the Canaries', () => {
    for (const [zone, row] of Object.entries(SOLAR_IRRADIATION_JULY.peninsular)) {
      expect(row.N, `peninsular ${zone}`).toBe(Math.min(...Object.values(row)));
    }
    for (const [zone, row] of Object.entries(SOLAR_IRRADIATION_JULY.canary)) {
      expect(row.S, `canary ${zone}`).toBe(Math.min(...Object.values(row)));
      expect(row.S, `canary ${zone} S vs N`).toBeLessThan(row.N);
    }
  });

  it('puts canary south below peninsular south in every shared zone', () => {
    const shared = ['A3', 'A4', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4', 'D1', 'D2', 'D3', 'E1'];
    for (const zone of shared) {
      expect(
        SOLAR_IRRADIATION_JULY.canary[zone].S,
        `${zone}`,
      ).toBeLessThan(SOLAR_IRRADIATION_JULY.peninsular[zone].S);
    }
  });
});

// ── The archipelago collision ────────────────────────────────────────────────

describe('archipelago collision', () => {
  it('returns different values for the same zone code (A3 south)', () => {
    expect(getHsolJul('peninsular', 'A3', 'S')).toBe(89.53);
    expect(getHsolJul('canary', 'A3', 'S')).toBe(55.46);
    expect(getHsolJul('peninsular', 'A3', 'S')).not.toBe(getHsolJul('canary', 'A3', 'S'));
  });

  it('is 59.4% overstated for C2 south if the archipelago is ignored', () => {
    const peninsular = getHsolJul('peninsular', 'C2', 'S');
    const canary = getHsolJul('canary', 'C2', 'S');
    expect(peninsular).toBe(88.17);
    expect(canary).toBe(55.33);
    expect((peninsular - canary) / canary).toBeCloseTo(0.594, 3);
  });

  it("routes 'Palmas, Las' at a C2 altitude to 55.33, not 88.17", () => {
    const zone = lookupZone('Palmas, Las', 1025);
    expect(zone.ok).toBe(true);
    if (!zone.ok) return;
    expect(formatZone(zone.zone)).toBe('C2');

    const arch = archipelagoForProvince('Palmas, Las', PROVINCE_KEYS);
    expect(arch).toBe('canary');
    expect(getHsolJul(arch, formatZone(zone.zone), 'S')).toBe(55.33);
  });

  it('routes a peninsular province at C2 to 88.17', () => {
    const zone = lookupZone('Barcelona', 10);
    expect(zone.ok).toBe(true);
    if (!zone.ok) return;
    expect(formatZone(zone.zone)).toBe('C2');

    const arch = archipelagoForProvince('Barcelona', PROVINCE_KEYS);
    expect(arch).toBe('peninsular');
    expect(getHsolJul(arch, formatZone(zone.zone), 'S')).toBe(88.17);
  });

  it("throws on the wrong spelling 'Las Palmas' rather than defaulting", () => {
    expect(() => archipelagoForProvince('Las Palmas', PROVINCE_KEYS)).toThrow(
      UnknownProvinceError,
    );
    expect(PROVINCE_KEYS).not.toContain('Las Palmas');
    expect(PROVINCE_KEYS).toContain('Palmas, Las');
  });

  it('routes Baleares and Ceuta to the peninsular table', () => {
    expect(archipelagoForProvince('Balears, Illes', PROVINCE_KEYS)).toBe('peninsular');
    expect(archipelagoForProvince('Ceuta', PROVINCE_KEYS)).toBe('peninsular');
    expect(archipelagoForProvince('Melilla', PROVINCE_KEYS)).toBe('peninsular');
  });

  it('maps exactly the two Canary provinces to canary', () => {
    expect([...CANARY_PROVINCES]).toEqual(['Palmas, Las', 'Santa Cruz de Tenerife']);
    for (const p of CANARY_PROVINCES) {
      expect(archipelagoForProvince(p, PROVINCE_KEYS)).toBe('canary');
    }
  });
});

// ── Province/altitude coverage ───────────────────────────────────────────────

describe('climate-zones coverage', () => {
  it('has 52 provinces × 24 bands = 1,248 cells', () => {
    expect(PROVINCE_KEYS).toHaveLength(52);
    for (const province of PROVINCE_KEYS) {
      expect(ZONE_BY_PROVINCE_ALTITUDE[province], province).toHaveLength(24);
    }
  });

  it('resolves all 1,248 cells to a real irradiation row without throwing', () => {
    let resolved = 0;
    for (const [province, bands] of Object.entries(cz)) {
      const arch = archipelagoForProvince(province, PROVINCE_KEYS);
      for (const zoneCode of Object.values(bands)) {
        expect(getHsolJul(arch, zoneCode, 'S')).toBeGreaterThan(0);
        resolved++;
      }
    }
    expect(resolved).toBe(1248);
  });

  it('round-trips every distinct zone code through parseZone → formatZone', () => {
    const distinct = new Set<string>();
    for (const bands of Object.values(cz)) {
      for (const zoneCode of Object.values(bands)) distinct.add(zoneCode);
    }
    expect(distinct.size).toBe(15);

    for (const code of distinct) {
      const parsed = parseZone(code);
      expect(parsed, code).not.toBeNull();
      if (parsed) expect(formatZone(parsed)).toBe(code);
    }
    // The α that would have become "alpha3" under a naive template literal.
    expect(distinct.has('α3')).toBe(true);
    expect('α3'.codePointAt(0)).toBe(0x3b1);
  });

  it('resolves a fractional altitude that inclusive integer bands would drop', () => {
    const at1250 = lookupZone('Albacete', 1250);
    const at1250point5 = lookupZone('Albacete', 1250.5);
    expect(at1250.ok).toBe(true);
    expect(at1250point5.ok).toBe(true);
    if (at1250.ok && at1250point5.ok) {
      expect(formatZone(at1250.zone)).toBe('E1');
      expect(formatZone(at1250point5.zone)).toBe('E1');
    }
  });

  it('uses Infinity for the unbounded top band', () => {
    const bands = ZONE_BY_PROVINCE_ALTITUDE['Albacete'];
    expect(bands[bands.length - 1].maxMetres).toBe(Infinity);
    expect(lookupZone('Albacete', 9000).ok).toBe(true);
  });
});

// ── Missing data ─────────────────────────────────────────────────────────────

describe('missing data throws rather than substituting', () => {
  it('throws MissingIrradiationError for α4 and returns no number', () => {
    expect(() => getHsolJul('canary', 'α4', 'S')).toThrow(MissingIrradiationError);
    try {
      getHsolJul('canary', 'α4', 'S');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingIrradiationError);
      expect((err as Error).message).toContain('α4');
    }
  });

  it('never emits α4 from climate-zones.json (α3 is the only α)', () => {
    const alphas = new Set<string>();
    for (const bands of Object.values(cz)) {
      for (const z of Object.values(bands)) if (z.startsWith('α')) alphas.add(z);
    }
    expect([...alphas]).toEqual(['α3']);
  });

  it('throws on an unknown surface', () => {
    expect(() => getHsolJul('peninsular', 'A3', 'XX' as Surface)).toThrow(
      MissingIrradiationError,
    );
  });
});

// ── Orientation sectors ──────────────────────────────────────────────────────

describe('orientationFromAzimuth — CTE figura 8 sectors', () => {
  const boundaries: readonly [number, string][] = [
    [0, 'N'], [22.4, 'N'], [22.5, 'NE'], [59.9, 'NE'], [60, 'E'],
    [110.9, 'E'], [111, 'SE'], [161.9, 'SE'], [162, 'S'], [180, 'S'],
    [197.9, 'S'], [198, 'SO'], [248.9, 'SO'], [249, 'O'], [299.9, 'O'],
    [300, 'NO'], [337.4, 'NO'], [337.5, 'N'], [359, 'N'],
  ];

  it.each(boundaries)('bearing %s → %s', (bearing, expected) => {
    expect(orientationFromAzimuth(bearing)).toBe(expected);
  });

  it('normalises negative and >360 bearings', () => {
    expect(orientationFromAzimuth(-90)).toBe('O');
    expect(orientationFromAzimuth(450)).toBe('E');
    expect(orientationFromAzimuth(720)).toBe('N');
    expect(orientationFromAzimuth(-360)).toBe('N');
  });

  it('is referenced to NORTH, not south', () => {
    expect(orientationFromAzimuth(0)).toBe('N');
    expect(orientationFromAzimuth(180)).toBe('S');
    expect(orientationFromAzimuth(0)).not.toBe(orientationFromAzimuth(180));
  });

  it('does not use uniform 45° bins (Sur spans 36°, Este 51°)', () => {
    // round(157/45) = 3 → would give SE under naive binning; CTE says SE too,
    // but 162 is S under CTE and round(162/45)=4 → S. The discriminator is 200:
    // naive round(200/45)=4 → 'S'; CTE says SO because Sur ends at 198.
    expect(orientationFromAzimuth(200)).toBe('SO');
    expect(orientationFromAzimuth(157)).not.toBe('S');
    // Este spans 60–111 = 51°, wider than 45.
    expect(orientationFromAzimuth(60)).toBe('E');
    expect(orientationFromAzimuth(110.9)).toBe('E');
  });

  it('maps O to WEST in the domain type (Oeste, not East)', () => {
    expect(orientationFromBearing(270)).toBe('W');
    expect(orientationFromBearing(90)).toBe('E');
    expect(orientationFromBearing(225)).toBe('SW');
    expect(orientationFromBearing(315)).toBe('NW');
    expect(orientationFromBearing(180)).toBe('S');
    expect(orientationFromBearing(0)).toBe('N');
  });
});

// ── End-to-end qsol;jul ──────────────────────────────────────────────────────

function win(overrides: Partial<Opening> = {}): Opening {
  return {
    id: 'w',
    areaM2: 2,
    frameFraction: 0.3,
    gWithShading: 0.5,
    obstacleShadingFactor: 1,
    orientation: 'S',
    ...overrides,
  };
}

function inp(overrides: Partial<QsolJulInput> = {}): QsolJulInput {
  return {
    openings: [win()],
    usefulFloorAreaM2: 100,
    climateZone: { winter: 'A', summer: 4 },
    buildingUse: 'RESIDENTIAL_PRIVATE',
    archipelago: 'peninsular',
    ...overrides,
  };
}

describe('calculateQsolJul against the official tables', () => {
  it('is compliant for a small shaded south window (A4 peninsular)', () => {
    // Hsol;jul A4 peninsular S = 94.78
    // 1 · 0.5 · (1−0.3) · 2 · 94.78 = 66.346 kWh/month ÷ 100 m² = 0.66346
    const r = calculateQsolJul(inp());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.qsolJul).toBeCloseTo(0.66346, 10);
    expect(r.limit).toBe(2.0);
    expect(r.compliant).toBe(true);
    expect(r.ratio).toBeCloseTo(0.33173, 10);
  });

  it('is non-compliant for a large rooflight (A4 peninsular horizontal)', () => {
    // Hsol;jul A4 peninsular horiz = 235.35
    // 1 · 0.5 · 0.7 · 10 · 235.35 = 823.725 ÷ 100 = 8.23725
    const r = calculateQsolJul(
      inp({ openings: [win({ areaM2: 10, orientation: 'HORIZONTAL' })] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.qsolJul).toBeCloseTo(8.23725, 10);
    expect(r.limit).toBe(2.0);
    expect(r.compliant).toBe(false);
    expect(r.ratio).toBeCloseTo(4.118625, 10);
  });

  it('applies the 4.00 limit for non-residential use', () => {
    const r = calculateQsolJul(
      inp({
        buildingUse: 'OTHER',
        openings: [win({ areaM2: 10, orientation: 'HORIZONTAL' })],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.limit).toBe(4.0);
    expect(r.ratio).toBeCloseTo(2.0593125, 10);
  });

  it('gives a different verdict for the same zone in the Canaries', () => {
    const peninsular = calculateQsolJul(inp({ climateZone: { winter: 'C', summer: 2 } }));
    const canary = calculateQsolJul(
      inp({ climateZone: { winter: 'C', summer: 2 }, archipelago: 'canary' }),
    );
    expect(peninsular.ok && canary.ok).toBe(true);
    if (!peninsular.ok || !canary.ok) return;
    // 88.17 vs 55.33 on the same inputs.
    expect(peninsular.qsolJul).toBeCloseTo(0.61719, 10);
    expect(canary.qsolJul).toBeCloseTo(0.38731, 10);
    expect(peninsular.qsolJul).toBeGreaterThan(canary.qsolJul);
  });

  it('resolves the α3 Canary zone that "alpha3" would have missed', () => {
    const r = calculateQsolJul(
      inp({ climateZone: { winter: 'alpha', summer: 3 }, archipelago: 'canary' }),
    );
    expect(r.ok).toBe(true);
    // Hsol;jul canary α3 S = 56.3 → 1 · 0.5 · 0.7 · 2 · 56.3 = 39.41 ÷ 100
    if (r.ok) expect(r.qsolJul).toBeCloseTo(0.3941, 10);
  });

  it('surfaces the source error message when a zone has no row', () => {
    const r = calculateQsolJul(
      inp({ climateZone: { winter: 'alpha', summer: 4 }, archipelago: 'canary' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('MISSING_SOLAR_IRRADIATION');
    if (r.code === 'MISSING_SOLAR_IRRADIATION') {
      expect(r.zone).toBe('α4');
      expect(r.hint).toContain('α4');
    }
  });
});

describe('shading priority is computed, not assumed', () => {
  it('does NOT rank south first in the Canaries', () => {
    const r = calculateQsolJul(
      inp({
        archipelago: 'canary',
        climateZone: { winter: 'C', summer: 2 },
        openings: [
          win({ id: 'north', orientation: 'N' }),
          win({ id: 'south', orientation: 'S' }),
          win({ id: 'east', orientation: 'E' }),
          win({ id: 'west', orientation: 'W' }),
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // canary C2: E 119.95 > O 114.83 > N 63.06 > S 55.33
    expect(r.contributions.map((c) => c.id)).toEqual(['east', 'west', 'north', 'south']);
    expect(r.contributions[0].id).not.toBe('south');
    expect(r.contributions[r.contributions.length - 1].id).toBe('south');
    const shares = r.contributions.reduce((s, c) => s + c.shareOfTotal, 0);
    expect(shares).toBeCloseTo(1, 10);
  });

  it('DOES rank south above north on the peninsula, from the same code path', () => {
    const r = calculateQsolJul(
      inp({
        openings: [
          win({ id: 'north', orientation: 'N' }),
          win({ id: 'south', orientation: 'S' }),
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // peninsular A4: S 94.78 > N 61.12
    expect(r.contributions.map((c) => c.id)).toEqual(['south', 'north']);
  });
});
