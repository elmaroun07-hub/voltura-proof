/**
 * The country sources registry — H-SRC-ES-UK.
 *
 * `data/sources/countries.yaml` holds one entry per country the product may
 * price. Everything a user can read about a registry country's carbon factor,
 * tariff and install cost is read from here, and every number carries its
 * authority and publication or is `pending` and renders pending. A country
 * that is not in the file has no money figure at all (P0.8).
 *
 * `currency` and `taxBasis` are TYPES here, not labels (P0.2): `Money<"GBP">`
 * cannot be passed where `Money<"EUR">` is required, and a tariff whose tax
 * basis is not one this pipeline can price cannot reach `priceSavings`. Both
 * are proven by real TS2345 diagnostics in `countries.test.ts`.
 *
 * Carbon is location-based for every country (amendment A21). Spain is
 * resolved PER ELECTRIC SYSTEM: an island, or an address whose system cannot
 * be determined, never receives the peninsular factor.
 */
import { INTL_LOCALE, type Locale } from "@workspace/i18n";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { findUpward } from "./registry";

// ── Types ────────────────────────────────────────────────────────────────────

export type Currency = "EUR" | "GBP";
const CURRENCIES: readonly Currency[] = ["EUR", "GBP"];

export type TaxBasis = "all_taxes_included" | "vat_where_applicable" | "excl_vat";
const TAX_BASES: readonly TaxBasis[] = ["all_taxes_included", "vat_where_applicable", "excl_vat"];

/** A monetary amount that cannot lose its currency. */
export interface Money<C extends Currency> {
  readonly amount: number;
  readonly currency: C;
}

export interface Publication {
  title: string;
  url: string;
  /** ISO date the source was published or last updated by its authority. */
  published: string;
  /** ISO date this repository pulled it. */
  retrieved: string;
}

export interface CarbonSystemCurrent {
  status: "current";
  /** gCO2e per kWh, unrounded, as published (converted from t/MWh or kg/kWh by an exact ×1000). */
  value: number;
  unit: "gCO2e/kWh";
  basis: "generation";
  authority: string;
  publication: Publication;
  activityYear: number;
  note: string;
}
export interface CarbonSystemPending {
  status: "pending";
  authority: string;
  note: string;
}
export type CarbonSystemEntry = CarbonSystemCurrent | CarbonSystemPending;

export interface TariffCurrent<C extends Currency = Currency, T extends TaxBasis = TaxBasis> {
  status: "current";
  value: number;
  unit: "perKWh";
  currency: C;
  taxBasis: T;
  authority: string;
  publication: Publication;
  /** What the statistic DESCRIBES. Not when it must be re-pulled. */
  period: { label: string; start: string; end: string };
  /** When the entry must be re-pulled. Past this date the tariff renders stale. */
  reviewBy: string;
  note: string;
}
export interface TariffPending<C extends Currency = Currency> {
  status: "pending";
  currency: C;
  authority: string;
  reason: string;
  note: string;
}
export type TariffEntry<C extends Currency = Currency> = TariffCurrent<C> | TariffPending<C>;

interface InstallCostBase<C extends Currency> {
  unit: "perKW";
  currency: C;
  taxBasis: TaxBasis;
  authority: string;
  authorityType: "government" | "industry";
  publication: Publication;
  edition: string;
  note: string;
}
export interface InstallCostRange<C extends Currency = Currency> extends InstallCostBase<C> {
  status: "current";
  kind: "range";
  low: number;
  high: number;
}
export interface InstallCostBanded<C extends Currency = Currency> extends InstallCostBase<C> {
  status: "current";
  kind: "banded";
  bands: { fromKw: number; toKw: number; value: number }[];
}
export interface InstallCostPending {
  status: "pending";
  authority: string;
  authorityType: "government" | "industry";
  note: string;
}
export type InstallCostEntry<C extends Currency = Currency> =
  | InstallCostRange<C>
  | InstallCostBanded<C>
  | InstallCostPending;

export interface CountryEntry {
  key: string;
  match: string[];
  currency: Currency;
  /** Recorded, never read by the rejection rule or any calculation (P0.5). */
  buildingStandard: "notApplied";
  carbonFactor: { systems: Record<string, CarbonSystemEntry> };
  tariff: TariffEntry;
  installCost: InstallCostEntry;
}

// ── Parsing — every field validated, nothing defaulted ───────────────────────

function fail(where: string, msg: string): never {
  throw new Error(`countries registry: ${where}: ${msg}`);
}
function rec(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(where, "must be a mapping");
  return v as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string, where: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) fail(where, `"${k}" must be a non-empty string`);
  return v;
}
function num(r: Record<string, unknown>, k: string, where: string): number {
  const v = r[k];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, `"${k}" must be a finite number`);
  return v;
}
function isoDate(r: Record<string, unknown>, k: string, where: string): string {
  const v = str(r, k, where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) fail(where, `"${k}" must be an ISO date (YYYY-MM-DD), got "${v}"`);
  return v;
}
function oneOf<T extends string>(r: Record<string, unknown>, k: string, allowed: readonly T[], where: string): T {
  const v = r[k];
  if (typeof v !== "string" || !allowed.includes(v as T)) fail(where, `"${k}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
  return v as T;
}
function publication(v: unknown, where: string): Publication {
  const r = rec(v, `${where}.publication`);
  return {
    title: str(r, "title", `${where}.publication`),
    url: str(r, "url", `${where}.publication`),
    published: isoDate(r, "published", `${where}.publication`),
    retrieved: isoDate(r, "retrieved", `${where}.publication`),
  };
}

function parseCarbonSystem(v: unknown, where: string): CarbonSystemEntry {
  const r = rec(v, where);
  const status = oneOf(r, "status", ["current", "pending"] as const, where);
  if (status === "pending") {
    return { status, authority: str(r, "authority", where), note: str(r, "note", where) };
  }
  return {
    status,
    value: num(r, "value", where),
    unit: oneOf(r, "unit", ["gCO2e/kWh"] as const, where),
    basis: oneOf(r, "basis", ["generation"] as const, where),
    authority: str(r, "authority", where),
    publication: publication(r.publication, where),
    activityYear: num(r, "activityYear", where),
    note: str(r, "note", where),
  };
}

function parseTariff(v: unknown, currency: Currency, where: string): TariffEntry {
  const r = rec(v, where);
  const status = oneOf(r, "status", ["current", "pending"] as const, where);
  const tariffCurrency = oneOf(r, "currency", CURRENCIES, where);
  if (tariffCurrency !== currency) fail(where, `currency ${tariffCurrency} does not match the country's ${currency}`);
  if (status === "pending") {
    return { status, currency, authority: str(r, "authority", where), reason: str(r, "reason", where), note: str(r, "note", where) };
  }
  const period = rec(r.period, `${where}.period`);
  const start = isoDate(period, "start", `${where}.period`);
  const end = isoDate(period, "end", `${where}.period`);
  if (start > end) fail(`${where}.period`, "start is after end");
  return {
    status,
    value: num(r, "value", where),
    unit: oneOf(r, "unit", ["perKWh"] as const, where),
    currency,
    taxBasis: oneOf(r, "taxBasis", TAX_BASES, where),
    authority: str(r, "authority", where),
    publication: publication(r.publication, where),
    period: { label: str(period, "label", `${where}.period`), start, end },
    reviewBy: isoDate(r, "reviewBy", where),
    note: str(r, "note", where),
  };
}

function parseInstallCost(v: unknown, currency: Currency, where: string): InstallCostEntry {
  const r = rec(v, where);
  const status = oneOf(r, "status", ["current", "pending"] as const, where);
  const authorityType = oneOf(r, "authorityType", ["government", "industry"] as const, where);
  if (status === "pending") {
    return { status, authority: str(r, "authority", where), authorityType, note: str(r, "note", where) };
  }
  const instCurrency = oneOf(r, "currency", CURRENCIES, where);
  if (instCurrency !== currency) fail(where, `currency ${instCurrency} does not match the country's ${currency}`);
  const base = {
    status,
    unit: oneOf(r, "unit", ["perKW"] as const, where),
    currency,
    taxBasis: oneOf(r, "taxBasis", TAX_BASES, where),
    authority: str(r, "authority", where),
    authorityType,
    publication: publication(r.publication, where),
    edition: str(r, "edition", where),
    note: str(r, "note", where),
  };
  const kind = oneOf(r, "kind", ["range", "banded"] as const, where);
  if (kind === "range") {
    const low = num(r, "low", where);
    const high = num(r, "high", where);
    if (low > high) fail(where, `low ${low} is above high ${high}`);
    return { ...base, kind, low, high };
  }
  const rawBands = r.bands;
  if (!Array.isArray(rawBands) || rawBands.length === 0) fail(where, '"bands" must be a non-empty array');
  const bands = rawBands.map((b, i) => {
    const br = rec(b, `${where}.bands[${i}]`);
    return { fromKw: num(br, "fromKw", `${where}.bands[${i}]`), toKw: num(br, "toKw", `${where}.bands[${i}]`), value: num(br, "value", `${where}.bands[${i}]`) };
  });
  bands.forEach((b, i) => {
    if (b.fromKw >= b.toKw) fail(`${where}.bands[${i}]`, "fromKw must be below toKw");
    if (i > 0 && b.fromKw !== bands[i - 1].toKw) fail(`${where}.bands[${i}]`, "bands must be contiguous and ascending");
  });
  return { ...base, kind, bands };
}

export function parseCountries(yamlText: string): CountryEntry[] {
  const doc = rec(parseYaml(yamlText), "the document");
  if (!Array.isArray(doc.countries)) fail("the document", 'expected a top-level "countries" array');
  const seen = new Set<string>();
  return doc.countries.map((raw, i) => {
    const r = rec(raw, `countries[${i}]`);
    const key = str(r, "key", `countries[${i}]`);
    const where = `country "${key}"`;
    if (seen.has(key)) fail(where, "duplicate key");
    seen.add(key);
    const currency = oneOf(r, "currency", CURRENCIES, where);
    if (!Array.isArray(r.match) || r.match.length === 0 || r.match.some((m) => typeof m !== "string")) {
      fail(where, '"match" must be a non-empty array of strings');
    }
    const cf = rec(r.carbonFactor, `${where}.carbonFactor`);
    const systemsRaw = rec(cf.systems, `${where}.carbonFactor.systems`);
    const systems: Record<string, CarbonSystemEntry> = {};
    for (const [name, v] of Object.entries(systemsRaw)) {
      systems[name] = parseCarbonSystem(v, `${where}.carbonFactor.systems.${name}`);
    }
    if (Object.keys(systems).length === 0) fail(where, "carbonFactor needs at least one system");
    return {
      key,
      match: (r.match as string[]).map((m) => m.toLowerCase()),
      currency,
      buildingStandard: oneOf(r, "buildingStandard", ["notApplied"] as const, where),
      carbonFactor: { systems },
      tariff: parseTariff(r.tariff, currency, `${where}.tariff`),
      installCost: parseInstallCost(r.installCost, currency, `${where}.installCost`),
    };
  });
}

let cached: CountryEntry[] | null = null;

/** Load the registry (cached; the file only changes at deploy). Pass a path to bypass the cache. */
export function loadCountries(filePath?: string): CountryEntry[] {
  if (filePath) return parseCountries(readFileSync(filePath, "utf8"));
  if (cached) return cached;
  const resolved = findUpward(dirname(fileURLToPath(import.meta.url)), "data/sources/countries.yaml");
  cached = parseCountries(readFileSync(resolved, "utf8"));
  return cached;
}

/** Match a geocoded country name to a registry entry. Whole-string, lowercased — never a substring. */
export function findCountry(geocodedCountry: string, entries: CountryEntry[] = loadCountries()): CountryEntry | null {
  const name = geocodedCountry.trim().toLowerCase();
  if (!name) return null;
  return entries.find((c) => c.match.includes(name)) ?? null;
}

// ── Carbon: per electric system ──────────────────────────────────────────────

export interface SourcedLocationFactor {
  status: "sourced";
  system: string;
  valueGPerKwh: number;
  basis: "generation";
  authority: string;
  publication: Publication;
  activityYear: number;
}

export type CarbonFactorResult =
  | { status: "sourced"; factor: SourcedLocationFactor }
  | { status: "pending"; system: string | null; reason: "system_factor_pending" | "system_undetermined"; detail: string };

/**
 * Which REE electric system an address is on, from the geocoder's ISO 3166-2
 * region code. Only a code that is positively a mainland Spanish region is
 * peninsular. A missing or unrecognised code is NOT assumed peninsular — it
 * is `undetermined`, and the carbon factor renders pending.
 */
export function spainElectricSystem(regionCode: string): "peninsular" | "baleares" | "canarias" | "ceuta" | "melilla" | "undetermined" {
  const code = regionCode.trim().toUpperCase();
  if (!/^ES-[A-Z]{1,2}$/.test(code)) return "undetermined";
  switch (code) {
    case "ES-IB": return "baleares";
    case "ES-CN": return "canarias";
    case "ES-CE": return "ceuta";
    case "ES-ML": return "melilla";
    default: return "peninsular";
  }
}

export function carbonFactorFor(country: CountryEntry, system: string | "undetermined"): CarbonFactorResult {
  if (system === "undetermined") {
    return {
      status: "pending",
      system: null,
      reason: "system_undetermined",
      detail: `${country.key}: the electric system of this address could not be determined, so no system's factor is assumed`,
    };
  }
  const entry = country.carbonFactor.systems[system];
  if (!entry || entry.status === "pending") {
    return {
      status: "pending",
      system,
      reason: "system_factor_pending",
      detail: `${country.key}: no sourced carbon factor is recorded for the ${system} electric system`,
    };
  }
  return {
    status: "sourced",
    factor: {
      status: "sourced",
      system,
      valueGPerKwh: entry.value,
      basis: entry.basis,
      authority: entry.authority,
      publication: entry.publication,
      activityYear: entry.activityYear,
    },
  };
}

/** The system key for a registry country: Spain is per REE system; the UK has one. */
export function electricSystemFor(country: CountryEntry, regionCode: string): string {
  return country.key === "spain" ? spainElectricSystem(regionCode) : "gb";
}

// ── Money: typed so currency and tax basis cannot be confused ────────────────

/** A tariff the pricing pipeline can apply: all taxes included, or declared by the user. */
export interface PricedTariff<C extends Currency> {
  value: number;
  currency: C;
  taxBasis: "all_taxes_included" | "user_declared";
}

export function priceSavings<C extends Currency>(savingsKwh: number, tariff: PricedTariff<C>): Money<C> {
  return { amount: parseFloat((savingsKwh * tariff.value).toFixed(2)), currency: tariff.currency };
}

/** Narrow a parsed registry tariff to one `priceSavings` will accept, or throw. */
export function toPricedTariff(t: TariffCurrent): PricedTariff<Currency> {
  if (t.taxBasis !== "all_taxes_included") {
    throw new Error(`tariff taxBasis is "${t.taxBasis}"; only "all_taxes_included" can be applied to a saving`);
  }
  return { value: t.value, currency: t.currency, taxBasis: "all_taxes_included" };
}

export const ROI_INFLATION = 0.015;
export const ROI_YEARS = 25;

export interface RoiCurvePoint { year: number; cumulativeSavings: number; netPosition: number }
export interface RoiResult {
  /**
   * null = the loop never finds the crossing: "not paid back" is a state, never
   * a number (D7). Null always means not within ROI_YEARS. The converse does not
   * hold: the loop tests one year past the curve, so a crossing in that year
   * comes back as a number above ROI_YEARS.
   */
  paybackYears: number | null;
  curve: RoiCurvePoint[];
  lifetimeSavings: number;
}

/**
 * Both operands must be the SAME currency, or this is a compile error (TS2769
 * — no overload matches). A plain `roi<C extends Currency>(a: Money<C>, b:
 * Money<C>)` does NOT catch `roi(eurMoney, gbpMoney)` at compile time: with
 * `currency` only in a covariant (readonly property) position, TypeScript
 * unifies C to the union `"EUR" | "GBP"` and both arguments satisfy it —
 * proven with a minimal repro before choosing this shape. Two concrete
 * overloads (one per member of `Currency`) is the closed-union AC2 needs.
 */
export function roi(annualSavings: Money<"EUR">, installCost: Money<"EUR">): RoiResult;
export function roi(annualSavings: Money<"GBP">, installCost: Money<"GBP">): RoiResult;
export function roi(annualSavings: Money<Currency>, installCost: Money<Currency>): RoiResult {
  const curve: RoiCurvePoint[] = [];
  let cumulative = 0;
  // Null until the loop finds the crossing, and null if it never does: "not
  // paid back" is a state (D7). It used to start at ROI_YEARS, and a genuine
  // payback can also round to 25.0, so "never" and a real 25.0 were one value.
  // A zero cost is paid back at year 0 - the crossing test needs
  // cumulative < cost, which a zero cost never meets.
  let paybackYears: number | null = installCost.amount <= 0 ? 0 : null;
  for (let y = 0; y <= ROI_YEARS; y++) {
    curve.push({
      year: y,
      cumulativeSavings: parseFloat(cumulative.toFixed(0)),
      netPosition: parseFloat((cumulative - installCost.amount).toFixed(0)),
    });
    const yearSavings = annualSavings.amount * Math.pow(1 + ROI_INFLATION, y);
    if (cumulative < installCost.amount && cumulative + yearSavings >= installCost.amount) {
      paybackYears = parseFloat((y + (installCost.amount - cumulative) / yearSavings).toFixed(1));
    }
    cumulative += yearSavings;
  }
  return { paybackYears, curve, lifetimeSavings: curve[curve.length - 1].cumulativeSavings };
}

/**
 * Render an amount in its OWN currency, punctuated for the reader's language
 * (H2b: 1.050 € in Spanish, €1,050 in English). There is no default currency,
 * no default language and no literal symbol.
 */
export function formatMoney(locale: Locale, amount: number, currency: Currency, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency,
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(amount);
}

/** A range renders as a range. There is no midpoint anywhere in this module. */
export function formatMoneyRange(locale: Locale, low: number, high: number, currency: Currency): string {
  return `${formatMoney(locale, low, currency)}–${formatMoney(locale, high, currency)}`;
}
