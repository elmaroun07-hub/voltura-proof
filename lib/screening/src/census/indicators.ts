/**
 * H3.5 — INE Censo de Población y Viviendas 2021, indicators by census
 * section (C2021_Indicadores.csv, published 30 Jun 2023; sections as of
 * 1 Jan 2021).
 *
 * Every published column is kept, keyed by INE's code (t1_1 … t22_5), so the
 * index can cite exactly which census figure it used. A blank cell is the
 * INE's statistical secrecy (per its own note), and reads as null — never 0.
 *
 * Note on units, from the file itself: the "Porcentaje" columns are fractions
 * (0.2160 = 21.6 %), not percentages.
 */

export class CensusError extends Error {
  override name = "CensusError";
}

/** Columns of C2021_Indicadores.csv after the five code columns, in file order. */
export const C2021_INDICATORS = [
  "t1_1", "t2_1", "t2_2", "t3_1", "t4_1", "t4_2", "t4_3", "t5_1", "t6_1", "t7_1",
  "t8_1", "t9_1", "t10_1", "t11_1", "t12_1", "t13_1", "t14_1", "t15_1", "t16_1",
  "t17_1", "t17_2", "t17_3", "t17_4", "t17_5", "t18_1", "t19_1", "t19_2", "t20_1",
  "t20_2", "t20_3", "t21_1", "t22_1", "t22_2", "t22_3", "t22_4", "t22_5",
] as const;
export type C2021Indicator = (typeof C2021_INDICATORS)[number];

export interface SectionIndicators {
  /** CUSEC: province(2) + municipality(3) + district(2) + section(3). */
  readonly cusec: string;
  readonly ineMunicipality: string;
  readonly values: Readonly<Record<C2021Indicator, number | null>>;
}

const HEADER = ["ccaa", "cpro", "cmun", "dist", "secc", ...C2021_INDICATORS].join(",");

/** Parse the rows of one municipality (5-digit INE code). */
export function parseC2021Indicators(csv: string, ineMunicipality: string): SectionIndicators[] {
  if (!/^\d{5}$/.test(ineMunicipality)) throw new CensusError(`bad INE municipality ${ineMunicipality}`);
  const lines = csv.split(/\r?\n/);
  if (lines[0].trim() !== HEADER) {
    throw new CensusError("C2021_Indicadores.csv header differs from the 41 columns this reader was built for");
  }
  const cpro = ineMunicipality.slice(0, 2);
  const cmun = ineMunicipality.slice(2);
  const out: SectionIndicators[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = line.split(",");
    if (cells.length !== 41) throw new CensusError(`line ${i + 1} has ${cells.length} cells, expected 41`);
    if (cells[1] !== cpro || cells[2] !== cmun) continue;
    const cusec = `${cells[1]}${cells[2]}${cells[3]}${cells[4]}`;
    if (!/^\d{10}$/.test(cusec)) throw new CensusError(`line ${i + 1}: CUSEC ${cusec} is not 10 digits`);
    if (seen.has(cusec)) throw new CensusError(`section ${cusec} appears twice`);
    seen.add(cusec);
    const values = {} as Record<C2021Indicator, number | null>;
    C2021_INDICATORS.forEach((code, k) => {
      const raw = cells[5 + k].trim();
      if (raw === "") {
        values[code] = null;
        return;
      }
      if (!/^-?\d+(\.\d+)?$/.test(raw)) {
        throw new CensusError(`section ${cusec} ${code}: not a number ${JSON.stringify(raw)}`);
      }
      values[code] = Number(raw);
    });
    out.push({ cusec, ineMunicipality, values });
  }
  return out;
}

/**
 * The three census figures the index's people factor uses (H3.7): share aged
 * over 64 (t4_3), one-person households (t22_1) over all households (t21_1),
 * unemployment (t10_1). Null when any of them is withheld or there are no
 * households — the input is then absent, never zero.
 */
export function peopleInputs(values: Readonly<Record<string, number | null>> | null): {
  over64: number;
  onePersonHouseholds: number;
  households: number;
  unemployment: number;
} | null {
  if (!values) return null;
  const { t4_3, t22_1, t21_1, t10_1 } = values;
  if (t4_3 == null || t22_1 == null || t21_1 == null || t10_1 == null || !(t21_1 > 0)) return null;
  return { over64: t4_3, onePersonHouseholds: t22_1, households: t21_1, unemployment: t10_1 };
}
