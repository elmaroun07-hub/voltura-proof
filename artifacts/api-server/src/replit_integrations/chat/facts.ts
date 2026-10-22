import { formatNumber, type Locale } from "@workspace/i18n";
import { CARBON_INTENSITY_BY_COUNTRY, COUNTRY_KEY_BY_ISO } from "../../lib/carbon-intensity";
import { ROI_INFLATION, ROI_YEARS } from "../../lib/emissions/countries";
import { SIZING_DEFAULTS } from "../../lib/sizing";

/**
 * H-ASST-ACC: what the Assistant may say Voltura does, one sentence per
 * feature, each written from the code (A.1,
 * contracts/evidence/h-asst-accuracy/a1-claims.md) and pinned to it by
 * facts.test.ts. The system prompt's feature list is this array, verbatim.
 *
 * A constant the code exports is imported, never restated. A fact that lives in
 * data or in an unexported literal is written out here and pinned by a test
 * that fails when the code moves (A-b). Change a sentence only together with
 * its pin, and with feature-map.test.ts, which maps each line to the code.
 *
 * H2b (2b.5): the Assistant works in both languages, so each fact is written
 * twice - English here, Spanish in VOLTURA_FACTS_ES below - from the same
 * constants. facts-es.test.ts ties every Spanish sentence to the English one
 * whose claims facts.test.ts pins to the code.
 */

/**
 * What /api/calculate asks NASA POWER for (routes.ts, fetchNasaPower). Not
 * exported there, so stated here and pinned against the request the route
 * actually sends.
 */
export const NASA_FACT = { resolution: "monthly", start: 2019, end: 2023 } as const;

const titleCase = (key: string) => key.replace(/\b\w/g, (c) => c.toUpperCase());

/** Countries the unsourced legacy table still prices, by the codes the lookup accepts. */
export const LEGACY_CARBON_COUNTRIES: string[] = [...new Set(Object.values(COUNTRY_KEY_BY_ISO))]
  .filter((key) => key in CARBON_INTENSITY_BY_COUNTRY)
  .sort()
  .map(titleCase);

const listed = (names: string[]) => `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

export const VOLTURA_FACTS: { id: string; text: string }[] = [
  {
    id: "geocoder",
    text: "Finds the location the user types with the OpenStreetMap Nominatim geocoder.",
  },
  {
    id: "nasa",
    text:
      `Takes monthly solar irradiance and temperature for that point from NASA POWER, averaged over ${NASA_FACT.start}-${NASA_FACT.end}: twelve ${NASA_FACT.resolution} values, not hourly data. ` +
      "Temperature affects only the modelled household consumption, not the solar generation. " +
      // H-ASST-ACC3 (N1, N2): ACC2 split the two NASA failures into separate
      // sentences; live, the model still swapped them ("if NASA data are
      // unavailable, the calculation stops"). Now two numbered cases, each with
      // its own trigger and outcome, and a closing sentence that says which
      // case does what. No "unavailable", no "missing": both read as either case.
      "NASA POWER can fail in two different ways, and they end differently. " +
      "Case 1 - NASA does not answer, answers with an error status, or sends an answer Voltura cannot read: Voltura estimates irradiance and temperature from the latitude, and labels the result as that estimate in the API response and on the page. " +
      "Case 2 - NASA answers, but one or more months have no value or are left out: there is no estimate and no result, and the calculation stops with an error. " +
      "Only Case 1 gives a latitude estimate; only Case 2 stops the calculation.",
  },
  {
    id: "simulation",
    text: "Simulates a full year hour by hour (8,760 hours): solar generation, household consumption spread from the annual kWh the user enters over a typical residential profile, and battery charge and discharge.",
  },
  {
    id: "orientation",
    text: "Adjusts generation for panel orientation (south, east, west, north) and tilt angle.",
  },
  {
    id: "monthly-chart",
    text: 'Shows the annual energy saved in kWh - the consumption covered by solar or the battery - and a monthly chart with four series: Generation, Savings, Grid Import and "Surplus not used" (solar energy neither the home nor the battery could take, which Voltura puts no value on). The monthly chart has no battery series.',
  },
  {
    id: "energy-mix",
    text: "Shows the annual energy mix: Direct Solar, From Battery and Grid Import, as shares of consumption.",
  },
  {
    id: "carbon",
    text:
      "Estimates the CO2 avoided with a location-based grid carbon factor. " +
      "Spain: the official REE factor, for mainland addresses only; an address in the Balearic or Canary Islands, Ceuta or Melilla, or a Spanish address whose region cannot be told, has no factor yet and the calculation is refused. " +
      "United Kingdom: the official DESNZ factor. " +
      // H-ASST-ACC3 (C14): live, the model called this list's factors official.
      `${listed(LEGACY_CARBON_COUNTRIES)}: an older factor with no cited source - not an official figure - which the results page does not mark as unsourced. ` +
      "Only the Spanish (REE) and UK (DESNZ) factors are official. " +
      // H-ASST-ACC4 (C15): live, the model copied the official sentences, dropped
      // the list, and "any other country" then read as every country but two.
      // The listed countries' result is said in its own sentence, and the
      // refusal names whom it covers.
      `The ${LEGACY_CARBON_COUNTRIES.length} countries in that list do get a full result, with that older factor. ` +
      `A country that is not Spain, the UK or one of those ${LEGACY_CARBON_COUNTRIES.length} countries has no factor, and the whole calculation is refused: no energy, money or CO2 result.`,
  },
  {
    id: "tariff",
    text:
      "Prices the saving only for Spain and the UK. " +
      "There, a tariff the user types is always used. " +
      "With no tariff typed, Spain uses Eurostat's 2025-S2 national household average while that figure is current. " +
      // H-ASST-ACC2 (P2): the UK case in one sentence, condition included.
      "The UK has no national tariff in Voltura, so a UK saving is priced only when the user types a tariff. " +
      "For any other country there is no money figure, even if the user types a tariff.",
  },
  {
    id: "payback",
    text:
      `Computes a payback period and a ${ROI_YEARS}-year ROI curve (savings rising ${percent(ROI_INFLATION)} a year) when the saving is priced and an installation cost is known: ` +
      "the cost the user types (Spain and the UK only), or, in the UK only, DESNZ's average cost for PV-only systems up to 10 kW, which is not used when a battery is included. " +
      "Spain has no sourced installation cost yet. Without a cost, payback shows as pending.",
  },
  {
    id: "pdf",
    // H-ASST-ACC2 (P1): the inputs it prints, named, and the one it does not.
    text:
      "Produces a downloadable PDF report of a calculation: the location and the inputs (annual usage, PV size, battery capacity and efficiency, tariff, panel orientation and roof angle), the result figures and the monthly table. " +
      "The installation cost is not printed, and the PDF has no charts.",
  },
  {
    id: "history",
    // H-ASST-ACC2 (E2): where the calculations are, and what the browser keeps.
    text:
      // H-ASST-ACC4 (E2, es live): "not in the browser" said outright.
      "Keeps a history of past calculations. The calculations themselves are stored on Voltura's server, not in the browser; this browser keeps only a random id that links it to them. " +
      "Another browser or device, or cleared site data, gets a new id and so an empty history; there are no user accounts.",
  },
  {
    id: "optimizer",
    text:
      // H-ASST-ACC2 (E3): it returns numbers; the AI's part is the prose beside them.
      "The AI Optimizer returns a recommended PV size in watts and a battery capacity in kWh as numbers, computed by a formula from the user's annual usage and location (NASA irradiance), using a fixed standard daily usage profile, not the user's own. " +
      `The formula sizes the array so its yearly generation equals ${percent(SIZING_DEFAULTS.coverageTarget)} of yearly use, and the battery for the profile's night-time share. ` +
      // H-ASST-ACC4 (E3): live, "the AI" read as the AI Optimizer ("it only
      // provides the explanation"). The writer is named apart from the Optimizer.
      "The AI Optimizer's numbers come from that formula; a language model then writes the explanation text shown beside them, and cannot change the numbers.",
  },
  {
    id: "assistant",
    // H-ASST-ACC3 (operator ruling, 8 Oct 2026): questions outside Voltura's jobs are not answered.
    text: "This Energy Assistant, which answers only questions about what Voltura does.",
  },
];

// ── Spanish (2b.5) ──────────────────────────────────────────────────────────

/** NASA_FACT.resolution in Spanish. Typed by it: a new resolution fails tsc here. */
const RESOLUTION_ES: Record<typeof NASA_FACT.resolution, string> = { monthly: "mensuales" };

const regionEs = new Intl.DisplayNames(["es"], { type: "region" });
const ISO_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_KEY_BY_ISO).map(([iso, key]) => [key, iso]),
);

/**
 * The same countries as LEGACY_CARBON_COUNTRIES, named in Spanish from their
 * ISO code (not translated by hand) and sorted as Spanish sorts. No name, no
 * list: a missing name throws rather than printing an English one (P2).
 */
export const LEGACY_CARBON_COUNTRIES_ES: string[] = [...new Set(Object.values(COUNTRY_KEY_BY_ISO))]
  .filter((key) => key in CARBON_INTENSITY_BY_COUNTRY)
  .map((key) => {
    const name = regionEs.of(ISO_BY_KEY[key].toUpperCase());
    if (!name) throw new Error(`facts: no Spanish name for ${key}`);
    return name;
  })
  .sort((a, b) => a.localeCompare(b, "es"));

/** "A, B y C" - and "e" before a word that sounds like i-, as Spanish writes it. */
const listedEs = (names: string[]) => {
  const last = names[names.length - 1];
  const and = /^h?i(?![aeiouáéíóú])/i.test(last) ? "e" : "y";
  return `${names.slice(0, -1).join(", ")} ${and} ${last}`;
};
/** es-ES writes 1,5 % - decimal comma, a space before the sign. */
const percentEs = (fraction: number) => `${formatNumber("es", Math.round(fraction * 1000) / 10)} %`;

/**
 * The thirteen facts in Spanish, same ids, same order, same claims. Labels the
 * screen shows are quoted as the Spanish screen shows them (the web catalog's
 * Spanish entries), so the Assistant and the page name things alike (P5).
 * Register: usted, as everywhere in the Spanish product.
 */
export const VOLTURA_FACTS_ES: { id: string; text: string }[] = [
  {
    id: "geocoder",
    text: "Localiza el lugar que escribe el usuario con el geocodificador Nominatim de OpenStreetMap.",
  },
  {
    id: "nasa",
    text:
      `Toma de NASA POWER la irradiancia solar y la temperatura mensuales de ese punto, promediadas en ${NASA_FACT.start}-${NASA_FACT.end}: doce valores ${RESOLUTION_ES[NASA_FACT.resolution]}, no datos horarios. ` +
      "La temperatura solo afecta al consumo doméstico modelizado, no a la generación solar. " +
      "NASA POWER puede fallar de dos maneras distintas, y terminan de forma distinta. " +
      "Caso 1 - NASA no contesta, contesta con un estado de error o envía una respuesta que Voltura no puede leer: Voltura estima la irradiancia y la temperatura a partir de la latitud, e identifica el resultado como esa estimación en la respuesta de la API y en la página. " +
      "Caso 2 - NASA contesta, pero uno o más meses no tienen valor o se omiten: no hay estimación ni resultado, y el cálculo se detiene con un error. " +
      "Solo el caso 1 da una estimación por latitud; solo el caso 2 detiene el cálculo.",
  },
  {
    id: "simulation",
    text: "Simula un año completo hora a hora (8760 horas): la generación solar, el consumo doméstico repartido a partir de los kWh anuales que introduce el usuario según un perfil residencial típico, y la carga y descarga de la batería.",
  },
  {
    id: "orientation",
    text: "Ajusta la generación según la orientación de los paneles (sur, este, oeste, norte) y el ángulo de inclinación.",
  },
  {
    id: "monthly-chart",
    text: "Muestra la energía anual ahorrada en kWh - el consumo cubierto por la energía solar o por la batería - y un gráfico mensual con cuatro series: Generación, Ahorro, Importación de red y «Excedente no aprovechado» (energía solar que ni la vivienda ni la batería pudieron absorber, y a la que Voltura no asigna ningún valor). El gráfico mensual no tiene ninguna serie de batería.",
  },
  {
    id: "energy-mix",
    text: "Muestra el mix energético anual: Solar directa, Desde la batería e Importación de red, como porcentajes del consumo.",
  },
  {
    id: "carbon",
    text:
      "Estima el CO2 evitado con un factor de carbono de la red según la ubicación. " +
      "España: el factor oficial de REE, solo para direcciones peninsulares; una dirección en las Islas Baleares o Canarias, en Ceuta o en Melilla, o una dirección española cuya región no se puede determinar, todavía no tiene factor y el cálculo se rechaza. " +
      "Reino Unido: el factor oficial del DESNZ. " +
      `${listedEs(LEGACY_CARBON_COUNTRIES_ES)}: un factor más antiguo sin fuente citada - no es una cifra oficial -, que la página de resultados no señala como sin fuente. ` +
      "Solo son oficiales los factores de España (REE) y del Reino Unido (DESNZ). " +
      `Los ${LEGACY_CARBON_COUNTRIES_ES.length} países de esa lista sí obtienen un resultado completo, con ese factor más antiguo. ` +
      `Un país que no sea España, el Reino Unido ni uno de esos ${LEGACY_CARBON_COUNTRIES_ES.length} países no tiene factor, y se rechaza todo el cálculo: ningún resultado de energía, dinero ni CO2.`,
  },
  {
    id: "tariff",
    text:
      "Valora el ahorro en dinero solo para España y el Reino Unido. " +
      "Allí, siempre se usa la tarifa que escribe el usuario. " +
      "Si no se escribe ninguna tarifa, España usa la media nacional de los hogares de Eurostat de 2025-S2 mientras esa cifra esté vigente. " +
      "El Reino Unido no tiene tarifa nacional en Voltura, así que el ahorro en el Reino Unido solo se valora cuando el usuario escribe una tarifa. " +
      "Para cualquier otro país no hay cifra en dinero, aunque el usuario escriba una tarifa.",
  },
  {
    id: "payback",
    text:
      `Calcula un periodo de retorno y una curva de rentabilidad a ${ROI_YEARS} años (con el ahorro subiendo un ${percentEs(ROI_INFLATION)} al año) cuando el ahorro está valorado en dinero y se conoce un coste de instalación: ` +
      "el coste que escribe el usuario (solo en España y el Reino Unido) o, solo en el Reino Unido, el coste medio del DESNZ para sistemas solo fotovoltaicos de hasta 10 kW, que no se usa cuando se incluye una batería. " +
      "España todavía no tiene un coste de instalación con fuente. Sin coste, el retorno aparece como pendiente.",
  },
  {
    id: "pdf",
    text:
      "Genera un informe PDF descargable de un cálculo: la ubicación y los datos introducidos (consumo anual, tamaño del sistema FV, capacidad y rendimiento de la batería, tarifa, orientación del panel y ángulo del tejado), las cifras de resultado y la tabla mensual. " +
      "El coste de instalación no se imprime, y el PDF no tiene gráficos.",
  },
  {
    id: "history",
    text:
      "Guarda un historial de cálculos anteriores. Los cálculos se almacenan en el servidor de Voltura, no en el navegador; este navegador solo guarda un identificador aleatorio que lo vincula con ellos. " +
      "Otro navegador u otro dispositivo, o borrar los datos del sitio, da un identificador nuevo y, por tanto, un historial vacío; no hay cuentas de usuario.",
  },
  {
    id: "optimizer",
    text:
      "El Optimizador IA devuelve como números una potencia FV recomendada en vatios y una capacidad de batería en kWh, calculadas con una fórmula a partir del consumo anual del usuario y de su ubicación (irradiancia de la NASA), con un perfil de consumo diario estándar y fijo, no el del propio usuario. " +
      `La fórmula dimensiona los paneles para que su generación anual sea igual al ${percentEs(SIZING_DEFAULTS.coverageTarget)} del consumo anual, y la batería para la parte nocturna del perfil. ` +
      "Los números del Optimizador IA salen de esa fórmula; después, un modelo de lenguaje escribe el texto de explicación que se muestra junto a ellos, y no puede cambiar los números.",
  },
  {
    id: "assistant",
    text: "Este Asistente energético, que solo responde preguntas sobre lo que hace Voltura.",
  },
];

/** The facts the Assistant is given, in the language the reader chose. */
export const FACTS_BY_LOCALE: Readonly<Record<Locale, readonly { id: string; text: string }[]>> = {
  es: VOLTURA_FACTS_ES,
  en: VOLTURA_FACTS,
};
