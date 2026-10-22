/**
 * H3.5 — a minimal ESRI shapefile reader for INE's census-section boundaries
 * (Seccionado_2021/SECC_CE_20210101.shp + .dbf, ETRS89 / UTM 30N).
 *
 * Reads Polygon shapes (type 5) and character DBF fields — the only things
 * that file contains. Anything else throws: a reader that half-understands a
 * shape type returns a wrong boundary, and a wrong boundary assigns buildings
 * to the wrong neighbourhood's census figures.
 *
 * Rings are returned as published; which ring is a hole is left to PostGIS
 * (ST_BuildArea), not inferred here from winding order.
 */

export class ShapefileError extends Error {
  override name = "ShapefileError";
}

export interface DbfField {
  readonly name: string;
  readonly type: string;
  readonly length: number;
}

export interface ShapeRecord {
  readonly attributes: Readonly<Record<string, string>>;
  /** Every ring of the shape, each closed, as [x, y] pairs. */
  readonly rings: readonly (readonly (readonly [number, number])[])[];
}

export function readDbfHeader(dbf: Buffer): { fields: DbfField[]; records: number; headerLength: number; recordLength: number } {
  if (dbf.length < 32) throw new ShapefileError("DBF shorter than its header");
  const records = dbf.readUInt32LE(4);
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  const fields: DbfField[] = [];
  for (let off = 32; dbf[off] !== 0x0d; off += 32) {
    if (off + 32 > headerLength) throw new ShapefileError("DBF field descriptors overrun the header");
    const name = dbf.toString("latin1", off, off + 11).replace(/\0.*$/s, "");
    fields.push({ name, type: String.fromCharCode(dbf[off + 11]), length: dbf[off + 16] });
  }
  const sum = 1 + fields.reduce((s, f) => s + f.length, 0);
  if (sum !== recordLength) {
    throw new ShapefileError(`DBF record length ${recordLength} ≠ 1 + Σ field lengths ${sum}`);
  }
  return { fields, records, headerLength, recordLength };
}

/**
 * Read the shapes whose attributes pass `keep`. `shp` and `dbf` are whole
 * files; `encoding` is the DBF's (the .cpg says UTF-8 for INE's file).
 */
export function readPolygonShapefile(
  shp: Buffer,
  dbf: Buffer,
  keep: (attributes: Record<string, string>) => boolean,
  encoding: BufferEncoding = "utf8",
): ShapeRecord[] {
  if (shp.readInt32BE(0) !== 9994) throw new ShapefileError("not a shapefile (file code ≠ 9994)");
  const fileLength = shp.readInt32BE(24) * 2;
  if (fileLength !== shp.length) {
    throw new ShapefileError(`.shp header says ${fileLength} bytes, file has ${shp.length}`);
  }
  const shapeType = shp.readInt32LE(32);
  if (shapeType !== 5) throw new ShapefileError(`shape type ${shapeType}; only Polygon (5) is supported`);

  const { fields, records, headerLength, recordLength } = readDbfHeader(dbf);
  for (const f of fields) {
    if (f.type !== "C") throw new ShapefileError(`DBF field ${f.name} has type ${f.type}; only C is supported`);
  }

  const out: ShapeRecord[] = [];
  let off = 100;
  for (let i = 0; i < records; i++) {
    const recStart = headerLength + i * recordLength;
    if (dbf[recStart] === 0x2a) throw new ShapefileError(`DBF record ${i} is marked deleted`);
    const attributes: Record<string, string> = {};
    let pos = recStart + 1;
    for (const f of fields) {
      attributes[f.name] = dbf.toString(encoding, pos, pos + f.length).trim();
      pos += f.length;
    }

    if (off + 8 > shp.length) throw new ShapefileError(`.shp ends before record ${i + 1}`);
    const recNo = shp.readInt32BE(off);
    const contentBytes = shp.readInt32BE(off + 4) * 2;
    if (recNo !== i + 1) throw new ShapefileError(`.shp record ${recNo} where ${i + 1} was expected`);
    const c = off + 8;
    off = c + contentBytes;
    if (!keep(attributes)) continue;

    const type = shp.readInt32LE(c);
    if (type !== 5) throw new ShapefileError(`record ${recNo} has shape type ${type}`);
    const numParts = shp.readInt32LE(c + 36);
    const numPoints = shp.readInt32LE(c + 40);
    const partsAt = c + 44;
    const pointsAt = partsAt + 4 * numParts;
    if (pointsAt + 16 * numPoints !== off) {
      throw new ShapefileError(`record ${recNo}: parts/points do not fill the record`);
    }
    const starts = Array.from({ length: numParts }, (_, k) => shp.readInt32LE(partsAt + 4 * k));
    const rings = starts.map((start, k) => {
      const end = k + 1 < numParts ? starts[k + 1] : numPoints;
      const ring: [number, number][] = [];
      for (let p = start; p < end; p++) {
        ring.push([shp.readDoubleLE(pointsAt + 16 * p), shp.readDoubleLE(pointsAt + 16 * p + 8)]);
      }
      const [fx, fy] = ring[0];
      const [lx, ly] = ring[ring.length - 1];
      if (ring.length < 4 || fx !== lx || fy !== ly) {
        throw new ShapefileError(`record ${recNo} part ${k} is not a closed ring`);
      }
      return ring;
    });
    out.push({ attributes, rings });
  }
  return out;
}
