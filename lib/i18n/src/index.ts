/**
 * @workspace/i18n — the one translation runtime. H2b.
 *
 * Spanish is the source of truth and the default locale; English is the
 * translation (2b.1). A catalog is defined from its Spanish table, and the
 * English table is TYPED against it: a key missing from English, or a key
 * English has that Spanish does not, fails `tsc`. A call site naming a key
 * Spanish does not have fails `tsc`. That is half of Gate H2b; the other half
 * is the web app's check-i18n script, which fails the build on text written
 * straight into a component instead of through a catalog.
 *
 * Shared by the web app and the API server so there is one runtime, one
 * interpolation rule and one number/date locale per language (P5).
 *
 * Zero runtime dependencies, like lib/cte. No fallback language: a missing
 * entry or a missing parameter throws. A screen that silently prints the key,
 * or the English, is the `|| 4.0` defect in words (P2).
 */

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 2b.1: Spanish is the default. The buyer is a Spanish regional administration. */
export const DEFAULT_LOCALE: Locale = "es";

/**
 * The Intl locale each language formats numbers and dates with. `en-GB` because
 * every amount and date the product printed before H2b was formatted `en-GB`;
 * changing English's formatting is not this block's business.
 */
export const INTL_LOCALE: Readonly<Record<Locale, string>> = { es: "es-ES", en: "en-GB" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A supported locale, or null. Never a guess: the caller decides what null means. */
export function parseLocale(value: unknown): Locale | null {
  return isLocale(value) ? value : null;
}

/**
 * The locale a request asked for in its Accept-Language header. Only the
 * highest-preference tag is read: the web app sends exactly one tag, the
 * language the person chose. Absent, empty or unsupported -> DEFAULT_LOCALE.
 * That is a stated policy (2b.1), not a numeric default.
 */
export function localeFromAcceptLanguage(header: string | undefined | null): Locale {
  if (!header) return DEFAULT_LOCALE;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...attrs] = part.trim().split(";");
      const q = attrs.map((a) => a.trim()).find((a) => a.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((t) => t.tag !== "" && t.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const top = tags[0];
  if (!top) return DEFAULT_LOCALE;
  return parseLocale(top.tag.split("-")[0]) ?? DEFAULT_LOCALE;
}

// ── Catalogs ────────────────────────────────────────────────────────────────

export type Messages = Readonly<Record<string, string>>;

/** The parameter names a template like "{n} kWh a {rate}" requires: "n" | "rate". */
export type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Params<Rest>
  : never;

export interface Catalog<ES extends Messages> {
  readonly es: ES;
  readonly en: { readonly [K in keyof ES]: string };
}

/**
 * Spanish first, English typed against it. Pass both tables as object literals
 * so excess-property checking applies: an English-only key is a type error.
 */
export function defineCatalog<const ES extends Messages>(
  es: ES,
  en: { readonly [K in keyof ES]: string },
): Catalog<ES> {
  return { es, en };
}

type ParamArgs<S extends string> = [Params<S>] extends [never]
  ? []
  : [params: { readonly [P in Params<S>]: string | number }];

export type Translate<ES extends Messages> = <K extends keyof ES & string>(
  key: K,
  ...params: ParamArgs<ES[K]>
) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Look a key up and fill its placeholders. Throws on a missing entry and on a
 * missing parameter; never prints a raw key, a raw `{name}`, or the other
 * language.
 */
export function translate(
  catalog: Catalog<Messages>,
  locale: Locale,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  const table: Readonly<Record<string, string>> = catalog[locale];
  const template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  if (typeof template !== "string") {
    throw new Error(`i18n: no ${locale} entry for "${key}"`);
  }
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!params || !Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`i18n: "${key}" (${locale}) needs {${name}} and was not given it`);
    }
    return String(params[name]);
  });
}

/** A translate function bound to one catalog and one locale, typed by the Spanish table. */
export function createTranslator<ES extends Messages>(catalog: Catalog<ES>, locale: Locale): Translate<ES> {
  return ((key: string, ...rest: unknown[]) =>
    translate(catalog as Catalog<Messages>, locale, key, rest[0] as Record<string, string | number> | undefined)) as Translate<ES>;
}

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

/**
 * Keys whose English template asks for different parameters than the Spanish
 * one. The type system checks keys; it cannot see inside two strings, so the
 * catalog tests run this and fail on any entry.
 */
export function placeholderMismatches(catalog: Catalog<Messages>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(catalog.es)) {
    const es = placeholdersOf(catalog.es[key]).join(",");
    const en = placeholdersOf(catalog.en[key] ?? "").join(",");
    if (es !== en) out.push(`${key}: es {${es}} vs en {${en}}`);
  }
  return out;
}

/** Keys whose Spanish entry is empty or whitespace. An empty string is not a translation. */
export function emptyEntries(catalog: Catalog<Messages>): string[] {
  const out: string[] = [];
  for (const locale of LOCALES) {
    const table: Readonly<Record<string, string>> = catalog[locale];
    for (const key of Object.keys(table)) {
      if (table[key].trim() === "") out.push(`${locale}.${key}`);
    }
  }
  return out;
}

// ── Numbers and dates ───────────────────────────────────────────────────────

/**
 * Numbers in the reader's language: es-ES writes 12.345,6 where en-GB writes
 * 12,345.6. es-ES does not group a four-digit integer (3860, not 3.860) — that
 * is the CLDR rule for Spanish, not a bug.
 */
export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], options).format(value);
}

export function formatDate(locale: Locale, value: Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], options).format(value);
}

/**
 * Month names as fixed tables rather than Intl: ICU builds differ between the
 * server's Node and a reader's browser (en-GB's September is "Sep" in one and
 * "Sept" in another), and a chart axis and a PDF table that disagree about a
 * month's name are a small P5 failure. English keeps the abbreviations the
 * product has always printed; Spanish writes them lower-case, as Spanish does.
 */
const MONTHS: Readonly<Record<Locale, { short: readonly string[]; long: readonly string[] }>> = {
  es: {
    short: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
    long: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  },
  en: {
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    long: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  },
};

/** A calendar month's name, from its 1-based number. Never from an English string the server sent. */
export function monthName(locale: Locale, month: number, style: "short" | "long" = "short"): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`i18n: month ${month} is not 1-12`);
  }
  return MONTHS[locale][style][month - 1];
}

// ── P7 in Spanish ───────────────────────────────────────────────────────────

/**
 * P7 is legal exposure in any language: Layer 1 outputs are never called
 * grades, ratings or compliance results. In Spanish the words a reader would
 * take that way are these. "Calificación energética" is the energy performance
 * certificate's own term, which is exactly why a screening index must never
 * borrow it.
 * Checked against every Spanish catalog entry by the catalog tests.
 */
export const P7_FORBIDDEN_ES: readonly RegExp[] = [
  /calificaci[oó]n/i,
  /clasificaci[oó]n energ[eé]tica/i,
  /resultado(s)? de cumplimiento/i,
  /certificado de habitabilidad/i,
];

/** Spanish catalog entries that use P7's forbidden words. */
export function p7Violations(catalog: Catalog<Messages>): string[] {
  const table: Readonly<Record<string, string>> = catalog.es;
  return Object.keys(table).filter((key) => P7_FORBIDDEN_ES.some((re) => re.test(table[key])));
}

export { VOCABULARY, ENPE_2026_2030, type VocabularyEntry, type VocabularySource } from "./vocabulary";
