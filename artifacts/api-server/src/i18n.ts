import {
  createTranslator,
  defineCatalog,
  formatDate,
  formatNumber,
  localeFromAcceptLanguage,
  monthName,
  type Locale,
  type Translate,
} from "@workspace/i18n";

/**
 * Every sentence the API writes for a person to read — error messages, the
 * recommendation, the money block's pending reasons, the PDF — in Spanish
 * first and English as the translation (H2b). The web app asks for one
 * language per request in Accept-Language; absent or unsupported, the answer
 * is Spanish (2b.1).
 *
 * Out of this catalog on purpose:
 *   - registry DATA (an authority's name, a period label, a registry note):
 *     it is a record of a source, quoted as the source wrote it, not prose;
 *   - log lines and developer errors: nobody but an operator reads them;
 *   - model output (the Optimizer's explanation, the Assistant's answers):
 *     language models write those. The Assistant's prompt is written in both
 *     languages in replit_integrations/chat (2b.5); its routes' errors are here.
 *
 * WinAnsi: the PDF draws with a standard font, so every PDF string here must
 * encode in Windows-1252. Spanish letters (á é í ó ú ñ ü ¿ ¡ « ») do; U+2212,
 * U+2082 and "≈" do not, and are not used. The PDF test reads both languages
 * back out of the file.
 */
export const serverCatalog = defineCatalog(
  {
    // ── Errors ────────────────────────────────────────────────────────────
    "error.sessionHeader": "Falta la cabecera X-Session-Id",
    "error.calcNotFound": "Cálculo no encontrado",
    "error.pdfFailed": "No se ha podido generar el PDF",
    "error.internal": "Error interno del servidor",
    "error.invalidField": "Valor no válido en «{field}»",
    "error.geocodeFailed":
      "No hemos podido localizar ese lugar. Revise la ortografía o pruebe a incluir el país; por ejemplo, «Madrid, España».",
    "error.unknownCarbonCountry":
      "No tenemos una cifra de intensidad de carbono con fuente para «{attempted}». Pruebe a incluir el país o una ciudad grande cercana.",
    "error.carbonPending": "Todavía no tenemos una cifra de intensidad de carbono con fuente para esta dirección: {detail}.",
    "carbon.systemUndetermined":
      "no se ha podido determinar el sistema eléctrico de esta dirección, así que no se supone el factor de ningún sistema",
    "carbon.systemFactorPending": "no hay un factor de carbono con fuente para el sistema eléctrico {system}",
    "error.nasaFill":
      "NASA POWER ha devuelto su valor de relleno {fill} para {parameter} en {keys}. No se puede calcular ninguna cifra de irradiancia para esta ubicación.",
    "error.nasaPartial":
      "NASA POWER cubrió {present} de {expected} meses para {parameter} en {years} año(s){missing}. Una media sobre menos años de los solicitados falsearía el periodo.",
    "error.nasaPartialMissing": " (faltan {list})",
    "error.rateLimited": "Demasiadas solicitudes de optimización. Inténtelo de nuevo más tarde.",
    "error.optimizeFailed": "No se ha podido generar la optimización",
    "error.optimizeModel": "El modelo de optimización ha devuelto una respuesta inutilizable. Inténtelo de nuevo.",
    "error.screeningNotLoaded": "No hay un cribado cargado para el municipio {ine}.",
    "error.screeningBadParam": "Valor no válido en «{param}».",
    "error.screeningBuildingNotFound": "El edificio {ref} no está en el cribado de este municipio.",
    "csv.rank": "Orden",
    "csv.ref": "Referencia catastral",
    "csv.dwellings": "Viviendas",
    "csv.year": "Año de construcción",
    "csv.floors": "Plantas",
    "csv.zone": "Zona climática CTE",
    "csv.cusec": "Sección censal",
    "csv.low": "Índice de cribado (extremo bajo)",
    "csv.mid": "Índice de cribado (valor central)",
    "csv.high": "Índice de cribado (extremo alto)",
    "csv.coverage": "Viviendas con certificado (proporción)",
    "csv.capped": "Certificado limitado al percentil 99",
    "csv.census": "Datos censales",
    "csv.yes": "sí",
    "csv.no": "no",
    "sizing.nonPositiveUsage": "El consumo anual debe ser un número positivo de kWh; se ha recibido {value}.",
    "sizing.nonPositiveIrradiance": "La irradiancia diaria media debe ser un número positivo; se ha recibido {value}.",
    "sizing.badShape":
      "El perfil {which} no es utilizable ({reason}); deben ser 24 números no negativos que no sumen todos cero.",
    "sizing.badAssumption": "{name} debe ser una proporción mayor que 0 y como máximo 1; se ha recibido {value}.",
    "sizing.noDarkHours":
      "El perfil solar produce las 24 horas, así que no hay carga nocturna que pueda cubrir una batería.",

    // ── Recommendation ────────────────────────────────────────────────────
    "rec.fullWithExport":
      "¡Excelente! Su sistema de {w} W cubre todo su consumo y genera un excedente con un valor de {value} en posible exportación a la red.",
    "rec.full": "¡Excelente! Su sistema de {w} W cubre todo su consumo y genera excedente ({saving}).",
    "rec.good":
      "¡Buen resultado! Su sistema cubre el {pct} % de su energía, {saving}. Una batería algo mayor podría acercarle al 100 %.",
    "rec.low":
      "Su sistema compensa el {pct} % de su consumo, {saving}. Considere aumentar la potencia FV a {w} W para una mejor cobertura.",
    "saving.notPriced": "el ahorro no está valorado (no hay tarifa con fuente para esta ubicación)",
    "saving.perYear": "un ahorro de {value} al año",

    // ── Money block ───────────────────────────────────────────────────────
    "money.notInRegistry":
      "este país aún no tiene una tarifa ni un coste de instalación con fuente, así que no se produce ninguna cifra económica",
    "money.yourTariff": "su tarifa",
    "money.tariffStale":
      "la tarifa de {authority} {period} debía actualizarse antes del {reviewBy} y no se ha actualizado, así que no se usa",
    "money.batteryNotInCost":
      "el coste de {authority} cubre solo la FV y excluye el almacenamiento en batería; no se aplica a un sistema con batería",
    "money.outsideBands": "un sistema de {kw} kW está fuera de los tramos que publica {authority} ({bands})",
    "money.band": "{from}–{to} kW",
    "money.bandSeparator": "; ",
    "money.roiNoTariff": "no hay tarifa con la que valorar el ahorro",
    "money.registryTariffPending":
      "el registro aún no tiene una tarifa con fuente de {authority} para este país, así que el ahorro no se valora",
    "money.registryCostPending":
      "el registro aún no tiene un coste de instalación con fuente de {authority} para este país, así que el retorno queda pendiente",
    "money.roiRange": "el coste de instalación es un intervalo, y el retorno no se calcula a partir de un intervalo",

    // ── PDF ───────────────────────────────────────────────────────────────
    "pdf.title": "Informe de ahorro con energía verde",
    "pdf.generated": "Generado: {date}",
    "pdf.summary": "Resumen",
    "pdf.location": "Ubicación",
    "pdf.annualUsage": "Consumo energético anual",
    "pdf.pvSize": "Tamaño del sistema FV",
    "pdf.batteryCapacity": "Capacidad de la batería",
    "pdf.batteryEfficiency": "Rendimiento de la batería",
    "pdf.tariff": "Tarifa eléctrica",
    "pdf.orientation": "Orientación del panel",
    "pdf.roofAngle": "Ángulo del tejado",
    "pdf.results": "Resultados",
    "pdf.annualSaved": "Energía ahorrada al año",
    "pdf.annualCostSavings": "Ahorro económico anual",
    "pdf.payback": "Periodo de retorno estimado",
    "pdf.lifetime": "Ahorro estimado a {years} años",
    "pdf.net": "Saldo neto estimado a {years} años (tras el coste de instalación)",
    "pdf.co2": "Emisiones de CO2 evitadas",
    "pdf.trees": "Equivalente en árboles",
    "pdf.treesValue": "{n} árboles/año",
    "pdf.pending": "pendiente",
    "pdf.currencyNotRecorded": "{n} (moneda no registrada)",
    "pdf.perKwh": "{price}/kWh",
    "pdf.paybackYears": "{n} años",
    "pdf.paybackNotWithin": "no en {n} años",
    "pdf.monthly": "Desglose mensual",
    "pdf.col.month": "Mes",
    "pdf.col.generated": "Generada",
    "pdf.col.consumed": "Consumida",
    "pdf.col.saved": "Ahorrada",
    "pdf.col.gridImport": "Importación de red",
    "pdf.col.surplus": "Excedente no aprovechado",
    "pdf.surplusNotRecorded": "Excedente no aprovechado: no registrado en este cálculo",
    "pdf.footer": "Generado por la calculadora de ahorro con energía verde",
    "pdf.orientation.north": "Norte",
    "pdf.orientation.south": "Sur",
    "pdf.orientation.east": "Este",
    "pdf.orientation.west": "Oeste",

    // ── Energy Assistant routes (2b.5) ────────────────────────────────────
    "chat.notFound": "Conversación no encontrada",
    "chat.listFailed": "No se han podido cargar las conversaciones",
    "chat.getFailed": "No se ha podido cargar la conversación",
    "chat.createFailed": "No se ha podido crear la conversación",
    "chat.deleteFailed": "No se ha podido eliminar la conversación",
    "chat.sendFailed": "No se ha podido enviar el mensaje",
    "chat.rateLimited": "Demasiados mensajes. Inténtelo de nuevo más tarde.",
    "chat.defaultTitle": "Nueva conversación",
    // H-ASST-ACC3 (operator ruling, 8 Oct 2026): the one answer to any question
    // outside Voltura's jobs. The system prompt quotes it from here.
    "chat.outOfScope": "No puedo responder a eso. Solo respondo preguntas sobre lo que hace Voltura.",

    // ── Units ─────────────────────────────────────────────────────────────
    "unit.kwh": "{n} kWh",
    "unit.w": "{n} W",
    "unit.kg": "{n} kg",
    "unit.percent": "{n} %",
    "unit.degrees": "{n}°",
  },
  {
    "error.sessionHeader": "X-Session-Id header is required",
    "error.calcNotFound": "Calculation not found",
    "error.pdfFailed": "Failed to generate PDF",
    "error.internal": "Internal server error",
    "error.invalidField": "Invalid value for \"{field}\"",
    "error.geocodeFailed":
      "We could not locate that place. Check the spelling, or try including the country - for example \"Madrid, Spain\".",
    "error.unknownCarbonCountry":
      "We do not have a sourced carbon-intensity figure for \"{attempted}\". Try including the country, or a nearby major city.",
    "error.carbonPending": "We do not yet have a sourced carbon-intensity figure for this address: {detail}.",
    "carbon.systemUndetermined":
      "the electric system of this address could not be determined, so no system's factor is assumed",
    "carbon.systemFactorPending": "no sourced carbon factor is recorded for the {system} electric system",
    "error.nasaFill":
      "NASA POWER returned its {fill} fill value for {parameter} at {keys}. No irradiance figure can be computed for this location.",
    "error.nasaPartial":
      "NASA POWER covered {present} of {expected} months for {parameter} over {years} year(s){missing}. A mean over fewer years than requested would misstate the period.",
    "error.nasaPartialMissing": " (missing {list})",
    "error.rateLimited": "Too many optimization requests. Please try again later.",
    "error.optimizeFailed": "Failed to generate optimization",
    "error.optimizeModel": "The optimization model returned an unusable response. Please try again.",
    "error.screeningNotLoaded": "No screening is loaded for municipality {ine}.",
    "error.screeningBadParam": "Invalid value for “{param}”.",
    "error.screeningBuildingNotFound": "Building {ref} is not in this municipality's screening.",
    "csv.rank": "Rank",
    "csv.ref": "Cadastral reference",
    "csv.dwellings": "Dwellings",
    "csv.year": "Year built",
    "csv.floors": "Floors",
    "csv.zone": "CTE climate zone",
    "csv.cusec": "Census section",
    "csv.low": "Screening index (low end)",
    "csv.mid": "Screening index (central value)",
    "csv.high": "Screening index (high end)",
    "csv.coverage": "Dwellings with a certificate (share)",
    "csv.capped": "Certificate capped at the 99th percentile",
    "csv.census": "Census data",
    "csv.yes": "yes",
    "csv.no": "no",
    "sizing.nonPositiveUsage": "Annual usage must be a positive number of kWh; received {value}.",
    "sizing.nonPositiveIrradiance": "Mean daily irradiance must be a positive number; received {value}.",
    "sizing.badShape":
      "The {which} profile is unusable ({reason}); it must be 24 non-negative numbers that do not all sum to zero.",
    "sizing.badAssumption": "{name} must be a ratio greater than 0 and at most 1; received {value}.",
    "sizing.noDarkHours": "The solar profile produces in all 24 hours, so there is no night load a battery could carry.",

    "rec.fullWithExport":
      "Excellent! Your {w}W system fully covers your usage and generates surplus energy worth {value} in potential grid export.",
    "rec.full": "Excellent! Your {w}W system fully covers your usage and generates surplus energy ({saving}).",
    "rec.good":
      "Great result! Your system covers {pct}% of your energy, {saving}. A slightly larger battery could push you closer to 100%.",
    "rec.low":
      "Your system offsets {pct}% of your energy usage, {saving}. Consider increasing PV capacity to {w}W for better coverage.",
    "saving.notPriced": "the saving is not priced (no sourced tariff for this location)",
    "saving.perYear": "saving {value}/year",

    "money.notInRegistry": "this country has no sourced tariff or install cost yet, so no money figure is produced",
    "money.yourTariff": "your tariff",
    "money.tariffStale":
      "the {authority} {period} tariff was due for re-pull by {reviewBy} and has not been refreshed, so it is not used",
    "money.batteryNotInCost":
      "the {authority} cost covers PV only and excludes battery storage; it is not applied to a system with a battery",
    "money.outsideBands": "a {kw} kW system is outside the bands {authority} publishes ({bands})",
    "money.band": "{from}–{to} kW",
    "money.bandSeparator": ", ",
    "money.roiNoTariff": "there is no tariff to price the saving with",
    // English prints the registry's own note for these two (see money.ts); the
    // entries exist so the English table matches the Spanish one key for key.
    "money.registryTariffPending":
      "the registry has no sourced {authority} tariff for this country yet, so the saving is not priced",
    "money.registryCostPending":
      "the registry has no sourced {authority} install cost for this country yet, so the payback is pending",
    "money.roiRange": "the install cost is a range, and a payback is not computed from a range",

    "pdf.title": "Green Energy Savings Report",
    "pdf.generated": "Generated: {date}",
    "pdf.summary": "Summary",
    "pdf.location": "Location",
    "pdf.annualUsage": "Annual Energy Usage",
    "pdf.pvSize": "PV System Size",
    "pdf.batteryCapacity": "Battery Capacity",
    "pdf.batteryEfficiency": "Battery Efficiency",
    "pdf.tariff": "Electricity Tariff",
    "pdf.orientation": "Panel Orientation",
    "pdf.roofAngle": "Roof Angle",
    "pdf.results": "Results",
    "pdf.annualSaved": "Annual Energy Saved",
    "pdf.annualCostSavings": "Annual Cost Savings",
    "pdf.payback": "Estimated Payback Period",
    "pdf.lifetime": "Est. {years}-Year Savings",
    "pdf.net": "Est. {years}-Year Net (after install cost)",
    "pdf.co2": "CO2 Emissions Reduced",
    "pdf.trees": "Trees Equivalent",
    "pdf.treesValue": "{n} trees/year",
    "pdf.pending": "pending",
    "pdf.currencyNotRecorded": "{n} (currency not recorded)",
    "pdf.perKwh": "{price}/kWh",
    "pdf.paybackYears": "{n} years",
    "pdf.paybackNotWithin": "not within {n} years",
    "pdf.monthly": "Monthly Breakdown",
    "pdf.col.month": "Month",
    "pdf.col.generated": "Generated",
    "pdf.col.consumed": "Consumed",
    "pdf.col.saved": "Saved",
    "pdf.col.gridImport": "Grid Import",
    "pdf.col.surplus": "Surplus not used",
    "pdf.surplusNotRecorded": "Surplus not used: Not recorded for this calculation",
    "pdf.footer": "Generated by Green Energy Savings Calculator",
    "pdf.orientation.north": "North",
    "pdf.orientation.south": "South",
    "pdf.orientation.east": "East",
    "pdf.orientation.west": "West",

    "chat.notFound": "Conversation not found",
    "chat.listFailed": "Failed to fetch conversations",
    "chat.getFailed": "Failed to fetch conversation",
    "chat.createFailed": "Failed to create conversation",
    "chat.deleteFailed": "Failed to delete conversation",
    "chat.sendFailed": "Failed to send message",
    "chat.rateLimited": "Too many messages. Please try again later.",
    "chat.defaultTitle": "New Chat",
    "chat.outOfScope": "I can't answer that. I only answer questions about what Voltura does.",

    "unit.kwh": "{n} kWh",
    "unit.w": "{n} W",
    "unit.kg": "{n} kg",
    "unit.percent": "{n}%",
    "unit.degrees": "{n}°",
  },
);

export type ServerTranslate = Translate<typeof serverCatalog.es>;

const translators: Record<Locale, ServerTranslate> = {
  es: createTranslator(serverCatalog, "es"),
  en: createTranslator(serverCatalog, "en"),
};

export function serverT(locale: Locale): ServerTranslate {
  return translators[locale];
}

/** The language a request asked for. Spanish unless it asked for English (2b.1). */
export function requestLocale(req: { get(name: string): string | undefined }): Locale {
  return localeFromAcceptLanguage(req.get("accept-language"));
}

export { formatNumber, formatDate, monthName, type Locale };
