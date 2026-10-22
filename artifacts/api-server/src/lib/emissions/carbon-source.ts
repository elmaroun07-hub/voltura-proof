/**
 * The single entry point routes.ts uses to find out what carbon figure a
 * location resolves to — H-SRC-ES, reworked at H-SRC-ES-UK for amendment A21.
 *
 * Carbon is LOCATION-BASED: the direct emissions of the physical generation a
 * panel displaces (REE per electric system for Spain, DESNZ generation factor
 * for the UK). The CNMC residual mix that H-SRC-ES resolved for Spain is
 * market-based; it is a note in the registry now and is no longer wired here.
 *
 * `CarbonSourceNote` is a closed set of five honest states. There is no sixth
 * where the code emits a number without saying which of these it is.
 */
import { countryKeyForIso, lookupCarbonIntensity } from "../carbon-intensity";
import {
  carbonFactorFor,
  electricSystemFor,
  findCountry,
  type CountryEntry,
  type SourcedLocationFactor,
} from "./countries";

export type CarbonSourceNote =
  // A registry country, resolved for the address's own electric system.
  | { status: "sourced"; country: string; factor: SourcedLocationFactor }
  // A registry country whose factor for THIS address's system is not sourced
  // (Baleares, Canarias, Ceuta, Melilla today) or cannot be determined. The
  // peninsular factor is never substituted.
  | {
      status: "pending";
      country: string;
      system: string | null;
      reason: "system_factor_pending" | "system_undetermined";
      detail: string;
    }
  // A country the legacy table still carries a bare, unsourced figure for.
  | { status: "unsourced_legacy"; country: string; valueKgPerKwh: number }
  // Neither the registry nor the legacy table has anything for this location.
  | { status: "unknown_country"; attempted: string }
  // Geocoding itself failed, so there is no country to resolve a figure for.
  | { status: "not_reached" };

/**
 * D16 (H-ASST-D16-N3): the country is the geocoder's structured ISO code -
 * never the user's free text, and never parsed out of a display name (B-a).
 * `geocodedCountry` and `locationInput` are labels only: they name what was
 * attempted in the states below, and decide nothing. A code neither table
 * carries is "unknown_country", the existing no-figure path.
 */
export function resolveCarbonSource(
  countryCode: string,
  geocodedCountry: string,
  locationInput: string,
  regionCode = "",
  countries?: CountryEntry[],
): CarbonSourceNote {
  const key = countryKeyForIso(countryCode);
  const country = key === null ? null : findCountry(key, countries);
  if (country) {
    const result = carbonFactorFor(country, electricSystemFor(country, regionCode));
    if (result.status === "sourced") {
      return { status: "sourced", country: country.key, factor: result.factor };
    }
    return {
      status: "pending",
      country: country.key,
      system: result.system,
      reason: result.reason,
      detail: result.detail,
    };
  }

  const legacy = lookupCarbonIntensity(countryCode);
  if (legacy !== null) {
    return {
      status: "unsourced_legacy",
      country: geocodedCountry || locationInput,
      valueKgPerKwh: legacy,
    };
  }

  return { status: "unknown_country", attempted: geocodedCountry || locationInput };
}

/**
 * The kg CO2 / kWh figure to multiply a savings figure by. Throws for every
 * state that is not a number — callers MUST check `status` and reject the
 * request themselves before reaching arithmetic (D15: the old code's mistake
 * was doing the substitution silently, inside the lookup).
 */
export function carbonIntensityKgPerKwh(source: CarbonSourceNote): number {
  switch (source.status) {
    case "sourced":
      return source.factor.valueGPerKwh / 1000;
    case "unsourced_legacy":
      return source.valueKgPerKwh;
    case "pending":
    case "unknown_country":
    case "not_reached":
      throw new Error(
        `carbonIntensityKgPerKwh: called with status "${source.status}" — the caller must ` +
          "reject the request before reaching arithmetic, not call this function",
      );
  }
}
