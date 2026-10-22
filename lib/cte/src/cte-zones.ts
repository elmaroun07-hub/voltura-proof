/**
 * CTE climate zone model (Código Técnico de la Edificación, Documento Básico HE).
 *
 * Spain is zoned by a LETTER (winter severity) and a NUMBER (summer severity):
 *   - Winter: α (alpha, warmest) → E (coldest)
 *   - Summer: 1 (mildest) → 4 (most severe)
 *
 * Example zone codes: "A4" (coastal Almería), "A2", "D3" (Madrid), "E1".
 *
 * Source: DB-HE, Anejo B (Zonas climáticas).
 *   https://www.codigotecnico.org/pdf/Documentos/HE/DccHE.pdf
 *
 * NOTE ON THE SUMMER DIGIT: the CTE sets U-value limits by WINTER zone only.
 * The summer digit is under-used by the regulation itself. That asymmetry is
 * the gap HeatShield exists to address — but it means we cannot lean on the
 * CTE for summer thresholds. Do not invent them.
 */

/** Winter severity. 'alpha' is written α in the regulation. */
export type WinterZone = 'alpha' | 'A' | 'B' | 'C' | 'D' | 'E';

/** Summer severity, 1 (mildest) to 4 (most severe). */
export type SummerZone = 1 | 2 | 3 | 4;

export const WINTER_ZONES: readonly WinterZone[] = [
  'alpha',
  'A',
  'B',
  'C',
  'D',
  'E',
] as const;

export const SUMMER_ZONES: readonly SummerZone[] = [1, 2, 3, 4] as const;

export interface ClimateZone {
  readonly winter: WinterZone;
  readonly summer: SummerZone;
}

/** Display form used in the regulation, e.g. "α4", "D3". */
export function formatZone(zone: ClimateZone): string {
  const letter = zone.winter === 'alpha' ? 'α' : zone.winter;
  return `${letter}${zone.summer}`;
}

/**
 * Parse a zone code such as "A4", "α3", "alpha3", "D1".
 * Returns null on anything unrecognised — callers must handle it rather than
 * defaulting, because a wrong climate zone silently corrupts every downstream
 * number.
 */
export function parseZone(code: string): ClimateZone | null {
  const normalised = code.trim().replace(/\s+/g, '');
  const match = /^(alpha|α|[ABCDE])([1-4])$/i.exec(normalised);
  if (!match) return null;

  const rawLetter = match[1].toLowerCase();
  const winter: WinterZone =
    rawLetter === 'alpha' || rawLetter === 'α'
      ? 'alpha'
      : (match[1].toUpperCase() as WinterZone);

  const summer = Number(match[2]) as SummerZone;
  return { winter, summer };
}

/**
 * Province + altitude → climate zone (DB-HE Anejo B).
 *
 * IMPLEMENTED. H1.6 corrected this comment, which still read "DELIBERATELY NOT
 * IMPLEMENTED" and instructed the reader to populate the table — long after it
 * had been populated. `ZONE_BY_PROVINCE_ALTITUDE` is built below from
 * `climate-zones.json`, transcribed from the official source, and is covered by
 * the 72 tests in this package.
 *
 * A comment telling the next reader that a live table is a stub is not a
 * cosmetic defect: it invites someone to "finish" work that is already done, or
 * to distrust a table the tests already prove.
 *
 * Anejo B maps each provincial capital to a base zone, then applies an altitude
 * correction. It was transcribed from the official PDF, not reconstructed from
 * memory — a wrong zone invalidates every calculation built on top of it. That
 * requirement still holds for any future edit.
 *
 * Source:
 *   https://www.codigotecnico.org/pdf/Documentos/HE/DccHE.pdf  (Anejo B)
 */
export type ProvinceCode = string; // e.g. "MU" (Murcia), "MA" (Málaga)

export interface AltitudeBand {
  /** Inclusive lower bound, metres above sea level. */
  readonly minMetres: number;
  /** Exclusive upper bound, metres. Use Infinity for the top band. */
  readonly maxMetres: number;
  readonly zone: ClimateZone;
}

import climateZonesJson from './climate-zones.json';

/**
 * Band labels as printed: "<=50", "51-100", … "1251-1300", ">=1301".
 * Returns the band's inclusive lower bound only; the upper bound is derived
 * from the next band so the intervals cannot gap (see buildBands).
 *
 * ⚠️ Do NOT generate these arithmetically. The bands are contiguous on
 * integers but NOT uniform: "1051-1250" is 200 m wide, every other interior
 * band is 50 m. ">=1301" is unbounded.
 */
function bandLowerBound(label: string): number {
  // "<=50" is the lowest band; -Infinity so sub-sea-level elevations resolve.
  if (/^<=\d+$/.test(label)) return -Infinity;
  const range = /^(\d+)-(\d+)$/.exec(label);
  if (range) return Number(range[1]);
  const open = /^>=(\d+)$/.exec(label);
  if (open) return Number(open[1]);
  throw new Error(`Unparseable altitude band label: ${JSON.stringify(label)}`);
}

/**
 * Half-open intervals [min, nextMin). Elevation APIs return decimals, and
 * inclusive integer bounds would drop e.g. 1250.5 into no band at all.
 */
function buildBands(bandsForProvince: Record<string, string>): readonly AltitudeBand[] {
  const parsed = Object.entries(bandsForProvince)
    .map(([label, zoneCode]) => {
      const zone = parseZone(zoneCode);
      if (zone === null) {
        throw new Error(
          `climate-zones.json contains an unparseable zone code: ${JSON.stringify(zoneCode)}`,
        );
      }
      return { min: bandLowerBound(label), zone };
    })
    .sort((a, b) => a.min - b.min);

  return parsed.map((band, i) => ({
    minMetres: band.min,
    maxMetres: i + 1 < parsed.length ? parsed[i + 1].min : Infinity,
    zone: band.zone,
  }));
}

/**
 * Province + altitude → climate zone, derived from the verified
 * climate-zones.json artifact (52 provinces × 24 bands = 1,248 cells).
 *
 * ⚠️ Province keys use the INE inverted-article convention: 'Palmas, Las',
 * 'Coruña, A', 'Rioja, La', 'Balears, Illes'. Match exactly — a substring or
 * natural-order match routes the Canary provinces through the peninsular
 * irradiation table, which is silently wrong for zone C2.
 */
export const ZONE_BY_PROVINCE_ALTITUDE: Readonly<
  Record<ProvinceCode, readonly AltitudeBand[]>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(climateZonesJson as Record<string, Record<string, string>>).map(
      ([province, bands]) => [province, buildBands(bands)],
    ),
  ),
);

/** Exact province keys, for archipelagoForProvince's known-province check. */
export const PROVINCE_KEYS: readonly ProvinceCode[] = Object.freeze(
  Object.keys(ZONE_BY_PROVINCE_ALTITUDE),
);

export type ZoneLookupResult =
  | { readonly ok: true; readonly zone: ClimateZone }
  | { readonly ok: false; readonly reason: 'UNKNOWN_PROVINCE' | 'NO_MATCHING_ALTITUDE_BAND' | 'TABLE_NOT_POPULATED' };

export function lookupZone(
  province: ProvinceCode,
  altitudeMetres: number,
): ZoneLookupResult {
  const bands = ZONE_BY_PROVINCE_ALTITUDE[province];
  if (Object.keys(ZONE_BY_PROVINCE_ALTITUDE).length === 0) {
    return { ok: false, reason: 'TABLE_NOT_POPULATED' };
  }
  if (!bands) return { ok: false, reason: 'UNKNOWN_PROVINCE' };

  const band = bands.find(
    (b) => altitudeMetres >= b.minMetres && altitudeMetres < b.maxMetres,
  );
  if (!band) return { ok: false, reason: 'NO_MATCHING_ALTITUDE_BAND' };

  return { ok: true, zone: band.zone };
}
