/**
 * Grid carbon intensity by country, kg CO2 per kWh.
 *
 * H1.9 — moved here from `lib/db/src/schema/schema.ts`. Emissions constants do
 * not belong in a schema package: that package describes tables, and a value
 * that changes with a country's generation mix is data, not structure. Moving
 * it is NOT the same as fixing it — the figures carry no source and no date,
 * which is a P1 violation. H1b (`lib/emissions`, all countries) is still
 * open; H-SRC-ES took Spain out of this table entirely and gave it a sourced
 * resolver at `./emissions/es.ts` instead, because Spain is the one market
 * this product is currently being sold into. Every other country here is
 * still the same unsourced holding position H1.9 left it in.
 */
export const CARBON_INTENSITY_BY_COUNTRY: Record<string, number> = {
  australia: 0.656,
  austria: 0.158,
  belgium: 0.167,
  brazil: 0.074,
  canada: 0.150,
  china: 0.555,
  denmark: 0.165,
  finland: 0.085,
  france: 0.083,
  germany: 0.401,
  greece: 0.393,
  india: 0.708,
  ireland: 0.295,
  italy: 0.351,
  japan: 0.471,
  mexico: 0.436,
  morocco: 0.543,
  maroc: 0.543,
  netherlands: 0.283,
  norway: 0.026,
  poland: 0.773,
  portugal: 0.212,
  romania: 0.263,
  "south korea": 0.436,
  // Spain deliberately absent — H-SRC-ES. Spain resolves through the sourced
  // registry at ./emissions/es.ts, never through this bare table. Adding a
  // "spain" key back here would silently reintroduce the exact defect this
  // block removes (a Spanish figure with no authority, document or year).
  sweden: 0.045,
  switzerland: 0.047,
  turkey: 0.481,
  // United Kingdom deliberately absent — H-SRC-ES-UK. It resolves through the
  // sourced registry (DESNZ generation factor), never through this bare table.
  "united states": 0.386,
  usa: 0.386,
  us: 0.386,
};

/**
 * ISO 3166-1 alpha-2 code -> the country key both carbon tables use: this one
 * and the registry's `match` names (`data/sources/countries.yaml`). The code
 * is Nominatim's structured `address.country_code`, which every resolved
 * geocode carries. A code with no entry here has no figure.
 *
 * A name, not a value: adding a country here adds no number. Spain and the
 * United Kingdom map to their registry keys and are still absent from the
 * bare table above.
 */
export const COUNTRY_KEY_BY_ISO: Record<string, string> = {
  at: "austria",
  au: "australia",
  be: "belgium",
  br: "brazil",
  ca: "canada",
  ch: "switzerland",
  cn: "china",
  de: "germany",
  dk: "denmark",
  es: "spain",
  fi: "finland",
  fr: "france",
  gb: "united kingdom",
  gr: "greece",
  ie: "ireland",
  in: "india",
  it: "italy",
  jp: "japan",
  kr: "south korea",
  ma: "morocco",
  mx: "mexico",
  nl: "netherlands",
  no: "norway",
  pl: "poland",
  pt: "portugal",
  ro: "romania",
  se: "sweden",
  tr: "turkey",
  us: "united states",
};

/** The table key for a geocoder country code, or null. Case- and whitespace-insensitive. */
export function countryKeyForIso(countryCode: string): string | null {
  return COUNTRY_KEY_BY_ISO[countryCode.trim().toLowerCase()] ?? null;
}

/**
 * Look up a country's grid intensity by its ISO code.
 *
 * H1.5 replaced `loc.includes(country)` - "Indianapolis" resolved to India,
 * 0.708 against the United States' 0.386 - with whole-token matching that put
 * the geocoded country NAME first and walked the user's free text after it.
 *
 * D16 (H-ASST-D16-N3): the walk was the defect one step on. A country in
 * neither table fell through to it, and any table country named anywhere in
 * the text won: "Little Italy, Cairo, Egypt" got Italy's factor, and on
 * 5 Oct 2026 "Little India, Singapore" - geocoded to Singapore - got India's.
 * The free text is no longer read at all. The country is the geocoder's
 * structured code, and the display name is not parsed either (B-a).
 *
 * Returns null when the code has no figure. The caller decides what an
 * unknown country means - this function does not invent a number.
 */
export function lookupCarbonIntensity(countryCode: string): number | null {
  const key = countryKeyForIso(countryCode);
  return key !== null && key in CARBON_INTENSITY_BY_COUNTRY ? CARBON_INTENSITY_BY_COUNTRY[key] : null;
}
