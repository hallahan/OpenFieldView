// Reader for Trimble geoid grid files (.ggf), such as g18us.ggf for GEOID18.
//
// A Trimble Access job stores GNSS positions as ellipsoid heights and names
// the geoid model that turns them into elevations, but the model itself lives
// in the controller's System Files folder. This reads that file so a JOB
// file's elevations can be worked out the way Trimble Access does.
//
// Layout (little-endian), worked out from g18us.ggf and checked against the
// elevations Trimble Access exports:
//
//   0    2   zero
//   2   14   "TNL GRID FILE", null terminated
//   16  32   model name ("GEOID18 (Conus)"), null padded
//   48   8   f64 south latitude, degrees
//   56   8   f64 north latitude
//   64   8   f64 west longitude, 0 to 360 east
//   72   8   f64 east longitude
//   80   8   f64 latitude spacing
//   88   8   f64 longitude spacing
//   96   4   i32 rows (south to north)
//   100  4   i32 columns (west to east)
//   104 42   flags, not understood; copied as they are when cropping
//   146  …   f32 geoid height in metres, row by row from the south-west corner

const MAGIC = 'TNL GRID FILE';
const HEADER = 146;

export class GeoidParseError extends Error {}

export interface GeoidGrid {
  /** Model name from the file's header, such as "GEOID18 (Conus)". */
  name: string;
  south: number;
  west: number;
  dLat: number;
  dLon: number;
  rows: number;
  cols: number;
  /** Geoid heights, read in place from the file's bytes. */
  view: DataView;
}

export function isGgf(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER && new TextDecoder('latin1').decode(bytes.subarray(2, 2 + MAGIC.length)) === MAGIC;
}

export function readGgf(bytes: Uint8Array): GeoidGrid {
  if (!isGgf(bytes)) throw new GeoidParseError('Not a Trimble geoid grid file (.ggf): the header is missing.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = view.getInt32(96, true);
  const cols = view.getInt32(100, true);
  if (rows < 3 || cols < 3 || HEADER + rows * cols * 4 !== bytes.length) {
    throw new GeoidParseError('This geoid grid file is a kind OpenFieldView cannot read yet, or it is cut short.');
  }
  const name = new TextDecoder('latin1').decode(bytes.subarray(16, 48)).replace(/\0.*$/s, '').trim();
  return {
    name,
    south: view.getFloat64(48, true),
    west: view.getFloat64(64, true),
    dLat: view.getFloat64(80, true),
    dLon: view.getFloat64(88, true),
    rows,
    cols,
    view: new DataView(bytes.buffer, bytes.byteOffset + HEADER, rows * cols * 4),
  };
}

/**
 * Geoid height (metres above the ellipsoid) at a latitude and longitude in
 * degrees, or undefined outside the grid. Interpolated with a quadratic
 * through the nearest three rows and columns, which is what reproduces
 * Trimble Access's elevations (to about 0.04 mm on the samples; bilinear is
 * off by up to 1 mm).
 */
export function undulation(g: GeoidGrid, lat: number, lon: number): number | undefined {
  const y = (lat - g.south) / g.dLat;
  const x = ((((lon - g.west) % 360) + 360) % 360) / g.dLon;
  if (!(y >= 0 && x >= 0 && y <= g.rows - 1 && x <= g.cols - 1)) return undefined;
  const i = Math.min(Math.max(Math.round(y), 1), g.rows - 2);
  const j = Math.min(Math.max(Math.round(x), 1), g.cols - 2);
  const quadratic = (a: number, b: number, c: number, t: number) => b + (t * (c - a)) / 2 + (t * t * (a - 2 * b + c)) / 2;
  const at = (r: number, c: number) => g.view.getFloat32(4 * (r * g.cols + c), true);
  const row = (r: number) => quadratic(at(r, j - 1), at(r, j), at(r, j + 1), x - j);
  return quadratic(row(i - 1), row(i), row(i + 1), y - i);
}

export interface GeoidBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Cut a geoid grid file down to an area (degrees, longitudes east or west),
 * keeping `margin` extra cells on every side. The result is a valid .ggf, so
 * a project can carry a few kilobytes instead of the 34 MB national grid.
 */
export function cropGgf(bytes: Uint8Array, bounds: GeoidBounds, margin = 3): Uint8Array {
  const g = readGgf(bytes);
  const col = (lon: number) => ((((lon - g.west) % 360) + 360) % 360) / g.dLon;
  const r0 = Math.max(0, Math.floor((bounds.south - g.south) / g.dLat) - margin);
  const r1 = Math.min(g.rows - 1, Math.ceil((bounds.north - g.south) / g.dLat) + margin);
  const c0 = Math.max(0, Math.floor(col(bounds.west)) - margin);
  const c1 = Math.min(g.cols - 1, Math.ceil(col(bounds.east)) + margin);
  const rows = r1 - r0 + 1;
  const cols = c1 - c0 + 1;
  if (rows < 3 || cols < 3) throw new GeoidParseError('That area is outside the geoid grid.');
  const out = new Uint8Array(HEADER + rows * cols * 4);
  out.set(bytes.subarray(0, HEADER));
  const view = new DataView(out.buffer);
  view.setFloat64(48, g.south + r0 * g.dLat, true);
  view.setFloat64(56, g.south + r1 * g.dLat, true);
  view.setFloat64(64, g.west + c0 * g.dLon, true);
  view.setFloat64(72, g.west + c1 * g.dLon, true);
  view.setInt32(96, rows, true);
  view.setInt32(100, cols, true);
  for (let r = 0; r < rows; r++) {
    const from = bytes.byteOffset + HEADER + 4 * ((r0 + r) * g.cols + c0);
    out.set(new Uint8Array(bytes.buffer, from, cols * 4), HEADER + 4 * r * cols);
  }
  return out;
}
