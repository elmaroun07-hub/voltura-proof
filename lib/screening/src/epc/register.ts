/**
 * H3.6 (as ruled 14 Oct 2026, option A) — energy certificates from the Junta
 * de Andalucía's open register, instead of the IECA grid the block file named
 * (see contracts/rulings/h3.md, REFUSAL — H3.6, and AMENDMENTS A26).
 *
 * Source: Registro de certificados energéticos de Andalucía, open data,
 * CC BY 4.0, one 7z of XML per province
 *   https://www.juntadeandalucia.es/datosabiertos/portal/dataset/registro-de-certificados-energeticos-de-andalucia
 *
 * One <DatosEnergeticosDelEdificio> per certificate. What H3 reads from it:
 * the referencia catastral (the join key to the Catastro), the date, the
 * dwelling type, and the COOLING figures — the summer side of the certificate:
 *   Demanda/EdificioObjeto/Refrigeracion       cooling demand, kWh/m²·year
 *   Calificacion/Demanda/Refrigeracion         its letter, A–G, and the scale
 *                                              (EscalaRefrigeracion) it was read against.
 * The demand is the certification software's modelled figure, not a meter
 * reading; the methodology document says so.
 *
 * The address (Direccion) is never read into H3: the cadastral reference is
 * the key, and a list of addresses with energy letters is not something a
 * screening index needs to hold.
 */

export class EpcParseError extends Error {
  override name = "EpcParseError";
}

export type EpcLetter = "A" | "B" | "C" | "D" | "E" | "F" | "G";
const LETTERS: readonly string[] = ["A", "B", "C", "D", "E", "F", "G"];

export interface EpcCertificate {
  /** Building (parcel) reference: the first 14 characters, the Catastro join key. */
  readonly buildingRef: string;
  /**
   * The 20-character unit reference when the certificate names exactly one
   * unit; null when it names the parcel only, or several units of it.
   */
  readonly unitRef: string | null;
  /** How the referencia catastral field was written. */
  readonly refForm: "unit" | "parcel" | "unit-list";
  /** dd/mm/yyyy as published, ISO-formatted; null if it is not a real date. */
  readonly date: string | null;
  /** False when the date is unreadable, before 2007 (RD 47/2007), or after the file was written. */
  readonly dateValid: boolean;
  readonly buildingType: string | null;
  readonly scope: string | null;
  readonly procedure: string | null;
  /** AnoConstruccion as written: a year, or a band such as "1960-1979". Not used by the index (the Catastro's year is). */
  readonly yearBuiltRaw: string | null;
  readonly zone: string | null;
  readonly habitableAreaM2: number | null;
  /** kWh/m²·year; null when the cell is empty. */
  readonly coolingDemand: number | null;
  readonly coolingLetter: EpcLetter | null;
  /** Upper bounds of A–F on the scale the letter was read against, as published. */
  readonly coolingScale: Readonly<Record<"A" | "B" | "C" | "D" | "E" | "F", number>> | null;
}

/** Why a certificate could not be tied to a building. */
export type EpcRejection = "malformed-ref" | "unit-list-spans-parcels";

export type EpcParsed =
  | { readonly ok: true; readonly cert: EpcCertificate }
  | { readonly ok: false; readonly reason: EpcRejection; readonly rawRef: string };

const CLOSE = "</DatosEnergeticosDelEdificio>";

/** Stream the register file into one string per certificate. */
export async function* certificateBlocks(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  let started = false;
  for await (const chunk of chunks) {
    buffer += chunk;
    if (!started) {
      if (!buffer.includes("<DatosEnergeticos>")) {
        if (buffer.length > 4096) throw new EpcParseError("no <DatosEnergeticos> root in the first 4 KB");
        continue;
      }
      started = true;
    }
    let close = buffer.indexOf(CLOSE);
    while (close !== -1) {
      const open = buffer.lastIndexOf("<DatosEnergeticosDelEdificio>", close);
      if (open === -1) throw new EpcParseError("certificate close tag with no open tag");
      yield buffer.slice(open, close + CLOSE.length);
      buffer = buffer.slice(close + CLOSE.length);
      close = buffer.indexOf(CLOSE);
    }
  }
  if (!started) throw new EpcParseError("not a certificate register (no <DatosEnergeticos> root)");
  if (buffer.includes("<DatosEnergeticosDelEdificio>")) {
    throw new EpcParseError("file ends inside a certificate (truncated download?)");
  }
}

/** Inner text of the first `tag` inside `xml` (after `within`, if given), or undefined if absent. */
function text(xml: string, path: readonly string[]): string | undefined {
  let scope = xml;
  for (let i = 0; i < path.length - 1; i++) {
    const open = scope.indexOf(`<${path[i]}>`);
    if (open === -1) return undefined;
    const close = scope.indexOf(`</${path[i]}>`, open);
    if (close === -1) throw new EpcParseError(`<${path[i]}> is not closed`);
    scope = scope.slice(open + path[i].length + 2, close);
  }
  const last = path[path.length - 1];
  const m = new RegExp(`<${last}>([^<]*)</${last}>`).exec(scope);
  return m ? m[1] : undefined;
}

function num(raw: string | undefined, what: string): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new EpcParseError(`${what} is not a number: ${JSON.stringify(t)}`);
  return Number(t);
}

const REF = /^[0-9A-Z]{14}([0-9A-Z]{6})?$/;

/**
 * Parse one certificate. `fileDate` (ISO yyyy-mm-dd) is when the register
 * file was written: a certificate dated after it is not a real date.
 */
export function parseCertificate(block: string, fileDate: string): EpcParsed {
  const rawRef = (text(block, ["IdentificacionEdificio", "ReferenciaCatastral"]) ?? "").trim().toUpperCase();
  let buildingRef: string;
  let unitRef: string | null;
  let refForm: EpcCertificate["refForm"];
  if (REF.test(rawRef)) {
    buildingRef = rawRef.slice(0, 14);
    unitRef = rawRef.length === 20 ? rawRef : null;
    refForm = rawRef.length === 20 ? "unit" : "parcel";
  } else {
    const list = rawRef.split(/\s*[,;]\s*/).filter((r) => r !== "");
    if (list.length < 2 || !list.every((r) => REF.test(r))) return { ok: false, reason: "malformed-ref", rawRef };
    const parcels = new Set(list.map((r) => r.slice(0, 14)));
    if (parcels.size !== 1) return { ok: false, reason: "unit-list-spans-parcels", rawRef };
    buildingRef = [...parcels][0];
    unitRef = null;
    refForm = "unit-list";
  }

  const rawDate = (text(block, ["DatosDelCertificador", "Fecha"]) ?? "").trim();
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate);
  let date: string | null = null;
  let dateValid = false;
  if (dm) {
    const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) {
      date = iso;
      dateValid = iso >= "2007-01-01" && iso <= fileDate;
    }
  }

  const letterRaw = (text(block, ["Calificacion", "Demanda", "Refrigeracion"]) ?? "").trim();
  if (letterRaw !== "" && !LETTERS.includes(letterRaw)) {
    throw new EpcParseError(`${rawRef}: cooling letter ${JSON.stringify(letterRaw)} is not A–G`);
  }
  const scaleXml = (() => {
    const i = block.indexOf("<EscalaRefrigeracion>");
    const j = block.indexOf("</EscalaRefrigeracion>");
    return i === -1 || j === -1 ? null : block.slice(i, j);
  })();
  let coolingScale: EpcCertificate["coolingScale"] = null;
  if (scaleXml) {
    const s = {} as Record<"A" | "B" | "C" | "D" | "E" | "F", number>;
    let complete = true;
    for (const k of ["A", "B", "C", "D", "E", "F"] as const) {
      const v = num(text(scaleXml, [k]), `${rawRef} EscalaRefrigeracion ${k}`);
      if (v === null) complete = false;
      else s[k] = v;
    }
    coolingScale = complete ? s : null;
  }

  return {
    ok: true,
    cert: {
      buildingRef,
      unitRef,
      refForm,
      date,
      dateValid,
      buildingType: text(block, ["IdentificacionEdificio", "TipoDeEdificio"])?.trim() || null,
      scope: text(block, ["IdentificacionEdificio", "AlcanceInformacionXML"])?.trim() || null,
      procedure: text(block, ["IdentificacionEdificio", "Procedimiento"])?.trim() || null,
      yearBuiltRaw: text(block, ["IdentificacionEdificio", "AnoConstruccion"])?.trim() || null,
      zone: text(block, ["IdentificacionEdificio", "ZonaClimatica"])?.trim() || null,
      habitableAreaM2: num(text(block, ["DatosGeneralesyGeometria", "SuperficieHabitable"]), `${rawRef} SuperficieHabitable`),
      coolingDemand: num(text(block, ["Demanda", "EdificioObjeto", "Refrigeracion"]), `${rawRef} cooling demand`),
      coolingLetter: letterRaw === "" ? null : (letterRaw as EpcLetter),
      coolingScale,
    },
  };
}
