/**
 * H3.3 — terrain altitude per building, from the IGN's 25 m terrain model.
 *
 * Source: Instituto Geográfico Nacional, Modelos Digitales del Terreno de
 * España, INSPIRE WCS https://servicios.idee.es/wcs-inspire/mdt, coverage
 * Elevacion25830_25 (25 m cells, ETRS89 / UTM 30N), served as ESRI ASCII grid.
 * Licence CC BY 4.0 (scne.es), per the service's own capabilities.
 *
 * The WCS answers with a multipart/related body: the grid, then its .prj.
 * extractAsciiGridPart() takes the grid part out; parseAsciiGrid() reads it;
 * sampleCell() returns the value of the cell containing a point — no
 * interpolation, so every altitude is a number the IGN published.
 */

export class DemError extends Error {
  override name = "DemError";
}

export interface AsciiGrid {
  readonly ncols: number;
  readonly nrows: number;
  /** Lower-left corner of the lower-left CELL (not its centre). */
  readonly xll: number;
  readonly yll: number;
  readonly cellSize: number;
  readonly nodata: number | null;
  /** Row-major, first row = northernmost. */
  readonly values: Float64Array;
}

/**
 * Take the application/asc part out of a WCS multipart/related response.
 * Throws if there is no such part — a .prj or an exception report read as a
 * grid would put every building at the wrong altitude.
 */
export function extractAsciiGridPart(raw: string): string {
  const firstBoundary = /^\r?\n?(--[^\r\n]+)\r?\n/.exec(raw);
  if (!firstBoundary) {
    // Not multipart: accept a bare grid, nothing else.
    if (/^\s*ncols\s/i.test(raw)) return raw;
    throw new DemError("response is neither a multipart body nor an ASCII grid");
  }
  const boundary = firstBoundary[1];
  const parts = raw.split(boundary).slice(1);
  for (const part of parts) {
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    if (/Content-Type:\s*application\/asc/i.test(headers)) {
      return part.slice(headerEnd).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    }
  }
  throw new DemError("multipart response has no application/asc part");
}

const HEADER_KEYS = ["ncols", "nrows", "xllcorner", "yllcorner", "cellsize", "nodata_value"] as const;

export function parseAsciiGrid(text: string): AsciiGrid {
  const lines = text.split(/\r?\n/);
  const header = new Map<string, number>();
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_]+)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/.exec(lines[i]);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (!(HEADER_KEYS as readonly string[]).includes(key)) {
      throw new DemError(`unknown ASCII grid header ${m[1]}`);
    }
    header.set(key, Number(m[2]));
  }
  for (const k of ["ncols", "nrows", "xllcorner", "yllcorner", "cellsize"]) {
    if (!header.has(k)) throw new DemError(`ASCII grid header lacks ${k}`);
  }
  const ncols = header.get("ncols")!;
  const nrows = header.get("nrows")!;
  const cellSize = header.get("cellsize")!;
  if (!Number.isInteger(ncols) || !Number.isInteger(nrows) || ncols <= 0 || nrows <= 0 || !(cellSize > 0)) {
    throw new DemError(`impossible grid dimensions ${ncols}×${nrows} @ ${cellSize}`);
  }
  const values = new Float64Array(ncols * nrows);
  let n = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    for (const tok of line.split(/\s+/)) {
      if (n >= values.length) throw new DemError("more values than ncols × nrows");
      const v = Number(tok);
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(tok) || !Number.isFinite(v)) {
        throw new DemError(`not a number in grid body: ${JSON.stringify(tok)}`);
      }
      values[n++] = v;
    }
  }
  if (n !== values.length) {
    throw new DemError(`grid holds ${n} values, header says ${values.length} (${ncols}×${nrows})`);
  }
  return {
    ncols,
    nrows,
    xll: header.get("xllcorner")!,
    yll: header.get("yllcorner")!,
    cellSize,
    nodata: header.has("nodata_value") ? header.get("nodata_value")! : null,
    values,
  };
}

/**
 * Value of the cell that contains (x, y). A point exactly on a cell's west or
 * south edge belongs to that cell. Throws outside the grid or on a nodata cell.
 */
export function sampleCell(grid: AsciiGrid, x: number, y: number): number {
  const col = Math.floor((x - grid.xll) / grid.cellSize);
  const rowFromSouth = Math.floor((y - grid.yll) / grid.cellSize);
  if (col < 0 || col >= grid.ncols || rowFromSouth < 0 || rowFromSouth >= grid.nrows) {
    throw new DemError(`point (${x}, ${y}) is outside the grid`);
  }
  const row = grid.nrows - 1 - rowFromSouth;
  const v = grid.values[row * grid.ncols + col];
  if (grid.nodata !== null && v === grid.nodata) {
    throw new DemError(`point (${x}, ${y}) falls on a nodata cell`);
  }
  return v;
}
