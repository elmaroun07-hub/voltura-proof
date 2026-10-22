/**
 * H2b, task 2b.3 (amended A24, 7 Oct 2026): the domain vocabulary, taken from
 * official Spanish usage — not translated from English.
 *
 * Every term is the wording of Spain's national energy-poverty strategy and
 * names the page it appears on. A screen, PDF or methodology document that
 * needs one of these ideas uses the term as written here. When the product's
 * use of a term is wider than the source's, the entry says so (`note`), so a
 * reader at a public body can see the gap instead of finding it.
 */

export interface VocabularySource {
  readonly document: string;
  readonly authority: string;
  /** Approved by the Council of Ministers. */
  readonly approved: string;
  readonly url: string;
  /** The date the copy below was read. */
  readonly retrieved: string;
  /** SHA-256 of the PDF that was read, so a later edition is noticed rather than assumed. */
  readonly sha256: string;
}

export interface VocabularyEntry {
  /** The Spanish term, exactly as the source writes it. */
  readonly term: string;
  /** What it means in English — a gloss for the team, never rendered in place of the term. */
  readonly gloss: string;
  readonly source: VocabularySource;
  /** The page of the source where the term appears (the PDF's printed page). */
  readonly page: number;
  /** A short passage from that page containing the term (under 15 words). */
  readonly excerpt: string;
  /** Where the product's use differs from the source's, said plainly. */
  readonly note?: string;
}

export const ENPE_2026_2030: VocabularySource = {
  document: "Estrategia Nacional contra la Pobreza Energética 2026-2030",
  authority: "Ministerio para la Transición Ecológica y el Reto Demográfico (MITECO), Gobierno de España",
  approved: "2026-02-17",
  url: "https://www.miteco.gob.es/content/dam/miteco/es/energia/files-1/bono-social/enpe-2026-2030/ENPE%202026-2030.pdf.coredownload.pdf",
  retrieved: "2026-10-07",
  sha256: "0ad93712eefc7d5ff0ffd9562cc977ac9325a7cac1598c42f72a40b55dfaeb6f",
};

export const VOCABULARY: readonly VocabularyEntry[] = [
  {
    term: "pobreza energética",
    gloss: "energy poverty",
    source: ENPE_2026_2030,
    page: 12,
    excerpt: "Se entenderá por ‘pobreza energética’ toda situación en la que un hogar",
  },
  {
    term: "pobreza energética en verano",
    gloss: "summer energy poverty — households that cannot keep cool",
    source: ENPE_2026_2030,
    page: 26,
    excerpt: "la pobreza energética en verano se configura como una problemática compleja",
    note:
      "Replaces 'viviendas difíciles de refrigerar' (A24): the strategy never uses 'refrigerar'.",
  },
  {
    term: "rehabilitación",
    gloss: "renovation / refurbishment of buildings",
    source: ENPE_2026_2030,
    page: 18,
    excerpt: "la rehabilitación del parque edificatorio y el acceso universal a tecnologías limpias",
  },
  {
    term: "parque edificatorio",
    gloss: "the building stock",
    source: ENPE_2026_2030,
    page: 18,
    excerpt: "la rehabilitación del parque edificatorio y el acceso universal a tecnologías limpias",
    note: "Replaces 'parque de viviendas' (A24), which the strategy does not use.",
  },
  {
    term: "cribado",
    gloss: "screening",
    source: ENPE_2026_2030,
    page: 61,
    excerpt: "Promover la inclusión del cribado de pobreza en la Atención Primaria",
    note:
      "In the strategy, cribado screens PEOPLE for poverty in primary health care. HeatShield screens the BUILDING STOCK — a wider sense than the source's (operator ruling, 7 Oct 2026).",
  },
];
