/**
 * Catastro INSPIRE Buildings (BU) — GML reader for the municipal bulk download.
 *
 * Source: Dirección General del Catastro, INSPIRE "Buildings" dataset, one ZIP per
 * municipality from the ATOM feed
 *   https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml
 * Each ZIP holds `<code>.building.gml`, `<code>.buildingpart.gml`,
 * `<code>.otherconstruction.gml` and a metadata XML. Files are ISO-8859-1.
 *
 * What this module promises (H3.1):
 *   - Every value it returns was read from the file. Nothing is defaulted.
 *   - An element published as xsi:nil comes back as null, never as 0.
 *   - Anything it cannot read exactly — a coordinate count that does not match
 *     its `count`, a ring that does not close, a coordinate system it was not
 *     built for, a number that is not a number — throws CatastroParseError
 *     naming the feature. A screening index built on a silently-misread
 *     footprint ranks the wrong building.
 *
 * Floors are published on BuildingPart only (the Building element carries
 * numberOfFloorsAboveGround as nil — 37,850 of 37,850 in Córdoba's 21 Aug 2026
 * file). They are aggregated per building by the caller, not here.
 */

export class CatastroParseError extends Error {
  constructor(
    readonly featureId: string | null,
    message: string,
  ) {
    super(featureId ? `${featureId}: ${message}` : message);
    this.name = "CatastroParseError";
  }
}

/** [x, y] in the feature's projected CRS (metres). */
export type Position = readonly [number, number];
/** Closed ring: first position equals last. */
export type Ring = readonly Position[];
/** [exterior, ...interiors] — interiors are courtyards (patios). */
export type Polygon = readonly Ring[];

/**
 * ETRS89 / UTM zones used by the Catastro (Canaries 28, peninsula 29–31).
 * Anything else is refused: the façade geometry downstream assumes metres on a
 * conformal projection.
 */
export const SUPPORTED_EPSG = [25828, 25829, 25830, 25831] as const;
export type SupportedEpsg = (typeof SUPPORTED_EPSG)[number];

export interface CatastroBuilding {
  /** Referencia catastral of the parcel (14 characters). */
  readonly ref: string;
  readonly epsg: SupportedEpsg;
  /** One entry per gml:PolygonPatch. */
  readonly polygons: readonly Polygon[];
  /** Raw conditionOfConstruction text (functional, declined, ruin, …) or null if nil. */
  readonly condition: string | null;
  /** Year of dateOfConstruction/beginning, or null if absent or nil. */
  readonly yearBeginning: number | null;
  /** Year of dateOfConstruction/end, or null if absent or nil. */
  readonly yearEnd: number | null;
  /** currentUse code as published (1_residential, 2_agriculture, …) or null. */
  readonly currentUse: string | null;
  readonly buildingUnits: number | null;
  readonly dwellings: number | null;
  /** officialArea value, only when its reference is grossFloorArea. */
  readonly grossFloorAreaM2: number | null;
}

export interface CatastroBuildingPart {
  /** `<ref>_part<n>` as published. */
  readonly partId: string;
  /** The building's referencia catastral (the part id before `_part`). */
  readonly ref: string;
  readonly epsg: SupportedEpsg;
  readonly polygons: readonly Polygon[];
  readonly floorsAboveGround: number | null;
  readonly floorsBelowGround: number | null;
}

const FEATURE_OPEN = "<gml:featureMember>";
const FEATURE_CLOSE = "</gml:featureMember>";

/**
 * Split a GML text stream into featureMember blocks without holding the whole
 * file. Córdoba's buildingpart file is 389 MB.
 *
 * The stream must be decoded as latin1 by the caller (createReadStream with
 * encoding "latin1"); the XML declaration is checked on the first chunk.
 */
export async function* featureBlocks(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  let headerChecked = false;
  for await (const chunk of chunks) {
    buffer += chunk;
    if (!headerChecked) {
      const declEnd = buffer.indexOf("?>");
      if (declEnd === -1) continue;
      assertLatin1Declaration(buffer.slice(0, declEnd + 2));
      headerChecked = true;
    }
    let close = buffer.indexOf(FEATURE_CLOSE);
    while (close !== -1) {
      const open = buffer.lastIndexOf(FEATURE_OPEN, close);
      if (open === -1) {
        throw new CatastroParseError(null, "featureMember close tag with no open tag");
      }
      yield buffer.slice(open, close + FEATURE_CLOSE.length);
      buffer = buffer.slice(close + FEATURE_CLOSE.length);
      close = buffer.indexOf(FEATURE_CLOSE);
    }
  }
  if (!headerChecked) {
    throw new CatastroParseError(null, "no XML declaration found");
  }
  if (buffer.includes(FEATURE_OPEN)) {
    throw new CatastroParseError(null, "file ends inside a featureMember (truncated download?)");
  }
}

function assertLatin1Declaration(decl: string): void {
  const m = /encoding="([^"]+)"/.exec(decl);
  if (!m || m[1].toUpperCase() !== "ISO-8859-1") {
    throw new CatastroParseError(
      null,
      `expected encoding="ISO-8859-1" in the XML declaration, found ${m ? m[1] : "none"}`,
    );
  }
}

/** Parse one `<gml:featureMember>` block holding a bu-ext2d:Building. */
export function parseBuildingFeature(block: string): CatastroBuilding {
  if (!block.includes("<bu-ext2d:Building ")) {
    throw new CatastroParseError(null, "featureMember is not a bu-ext2d:Building");
  }
  const ref = readLocalId(block);
  if (!/^[0-9A-Z]{14}$/.test(ref)) {
    throw new CatastroParseError(ref, "localId is not a 14-character referencia catastral");
  }
  const { epsg, polygons } = readSurface(block, ref);
  const area = readGrossFloorArea(block, ref);
  return {
    ref,
    epsg,
    polygons,
    condition: readText(block, "bu-core2d:conditionOfConstruction", ref),
    yearBeginning: readYear(block, "bu-core2d:beginning", ref),
    yearEnd: readYear(block, "bu-core2d:end", ref),
    currentUse: readText(block, "bu-ext2d:currentUse", ref),
    buildingUnits: readInteger(block, "bu-ext2d:numberOfBuildingUnits", ref),
    dwellings: readInteger(block, "bu-ext2d:numberOfDwellings", ref),
    grossFloorAreaM2: area,
  };
}

/** Parse one `<gml:featureMember>` block holding a bu-ext2d:BuildingPart. */
export function parseBuildingPartFeature(block: string): CatastroBuildingPart {
  if (!block.includes("<bu-ext2d:BuildingPart ")) {
    throw new CatastroParseError(null, "featureMember is not a bu-ext2d:BuildingPart");
  }
  const partId = readLocalId(block);
  const m = /^([0-9A-Z]{14})_part\d+$/.exec(partId);
  if (!m) {
    throw new CatastroParseError(partId, "BuildingPart localId is not <ref>_part<n>");
  }
  const { epsg, polygons } = readSurface(block, partId);
  return {
    partId,
    ref: m[1],
    epsg,
    polygons,
    floorsAboveGround: readInteger(block, "bu-ext2d:numberOfFloorsAboveGround", partId),
    floorsBelowGround: readInteger(block, "bu-ext2d:numberOfFloorsBelowGround", partId),
  };
}

function readLocalId(block: string): string {
  const ids = [...block.matchAll(/<base:localId>([^<]*)<\/base:localId>/g)];
  if (ids.length !== 1) {
    throw new CatastroParseError(null, `expected exactly one base:localId, found ${ids.length}`);
  }
  return ids[0][1].trim();
}

/** Escape a tag name for use in a RegExp. */
function tagRe(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Text content of a simple element, null when published as xsi:nil, null when
 * the element is absent. Throws if the element appears more than once.
 */
function readText(block: string, tag: string, id: string): string | null {
  const re = new RegExp(`<${tagRe(tag)}(\\s[^>]*)?>([^<]*)</${tagRe(tag)}>`, "g");
  const hits = [...block.matchAll(re)];
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new CatastroParseError(id, `${tag} appears ${hits.length} times`);
  }
  const attrs = hits[0][1] ?? "";
  if (/xsi:nil="true"/.test(attrs)) return null;
  const text = hits[0][2].trim();
  return text === "" ? null : text;
}

function readInteger(block: string, tag: string, id: string): number | null {
  const text = readText(block, tag, id);
  if (text === null) return null;
  if (!/^-?\d+$/.test(text)) {
    throw new CatastroParseError(id, `${tag} is not an integer: ${JSON.stringify(text)}`);
  }
  return Number(text);
}

/**
 * Year of a construction date as the Catastro writes it.
 *
 * Two shapes occur besides YYYY-01-01 (Córdoba, 21 Aug 2026 file):
 *   - "--01-01T00:00:00" — the year is omitted (144 buildings). That is a
 *     published "year unknown", so it reads as null, never as a guessed year.
 *   - years written without zero padding: "711-01-01", "950-01-01" (Roman and
 *     Andalusí monuments). They are real years and read as 711, 950.
 * Anything else throws.
 */
function readYear(block: string, tag: string, id: string): number | null {
  const text = readText(block, tag, id);
  if (text === null) return null;
  if (/^--\d{2}-\d{2}(T[\d:]+)?$/.test(text)) return null;
  const m = /^(\d{1,4})-\d{2}-\d{2}(T[\d:]+)?$/.exec(text);
  if (!m) {
    throw new CatastroParseError(id, `${tag} is not an ISO date: ${JSON.stringify(text)}`);
  }
  return Number(m[1]);
}

function readGrossFloorArea(block: string, id: string): number | null {
  const ref = readText(block, "bu-ext2d:officialAreaReference", id);
  if (ref === null) return null;
  if (ref !== "grossFloorArea") {
    // Another reference type is a different quantity; refusing it is cheaper
    // than finding out later that a "floor area" was a plot area.
    return null;
  }
  const m = [
    ...block.matchAll(/<bu-ext2d:value uom="m2">([^<]*)<\/bu-ext2d:value>/g),
  ];
  if (m.length !== 1) {
    throw new CatastroParseError(id, `expected one officialArea value in m2, found ${m.length}`);
  }
  const text = m[0][1].trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new CatastroParseError(id, `officialArea value is not a number: ${JSON.stringify(text)}`);
  }
  return Number(text);
}

function readSurface(
  block: string,
  id: string,
): { epsg: SupportedEpsg; polygons: Polygon[] } {
  const surfaces = [...block.matchAll(/<gml:Surface\s[^>]*srsName="([^"]+)"/g)];
  if (surfaces.length !== 1) {
    throw new CatastroParseError(id, `expected one gml:Surface, found ${surfaces.length}`);
  }
  const srs = /^urn:ogc:def:crs:EPSG::(\d+)$/.exec(surfaces[0][1]);
  const epsg = srs ? Number(srs[1]) : NaN;
  if (!(SUPPORTED_EPSG as readonly number[]).includes(epsg)) {
    throw new CatastroParseError(id, `unsupported srsName ${surfaces[0][1]}`);
  }
  const patches = [...block.matchAll(/<gml:PolygonPatch>([\s\S]*?)<\/gml:PolygonPatch>/g)];
  if (patches.length === 0) {
    throw new CatastroParseError(id, "gml:Surface has no PolygonPatch");
  }
  const polygons = patches.map((p) => readPatch(p[1], id));
  return { epsg: epsg as SupportedEpsg, polygons };
}

function readPatch(patch: string, id: string): Polygon {
  const exteriors = [...patch.matchAll(/<gml:exterior>([\s\S]*?)<\/gml:exterior>/g)];
  if (exteriors.length !== 1) {
    throw new CatastroParseError(id, `PolygonPatch has ${exteriors.length} exterior rings`);
  }
  const interiors = [...patch.matchAll(/<gml:interior>([\s\S]*?)<\/gml:interior>/g)];
  return [
    readRing(exteriors[0][1], id),
    ...interiors.map((m) => readRing(m[1], id)),
  ];
}

function readRing(ringXml: string, id: string): Ring {
  const m = /<gml:posList\s([^>]*)>([^<]*)<\/gml:posList>/.exec(ringXml);
  if (!m) throw new CatastroParseError(id, "ring has no gml:posList");
  const dim = /srsDimension="(\d+)"/.exec(m[1]);
  if (!dim || dim[1] !== "2") {
    throw new CatastroParseError(id, `posList srsDimension is ${dim ? dim[1] : "missing"}, expected 2`);
  }
  const countAttr = /count="(\d+)"/.exec(m[1]);
  if (!countAttr) throw new CatastroParseError(id, "posList has no count attribute");
  const count = Number(countAttr[1]);
  const tokens = m[2].trim().split(/\s+/);
  if (tokens.length !== count * 2) {
    throw new CatastroParseError(
      id,
      `posList count="${count}" but holds ${tokens.length} numbers (expected ${count * 2})`,
    );
  }
  const ring: Position[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const x = parseCoordinate(tokens[i], id);
    const y = parseCoordinate(tokens[i + 1], id);
    ring.push([x, y]);
  }
  if (ring.length < 4) {
    throw new CatastroParseError(id, `ring has ${ring.length} positions; a closed ring needs at least 4`);
  }
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) {
    throw new CatastroParseError(id, "ring does not close (first position ≠ last)");
  }
  return ring;
}

function parseCoordinate(token: string, id: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(token)) {
    throw new CatastroParseError(id, `coordinate is not a number: ${JSON.stringify(token)}`);
  }
  return Number(token);
}
