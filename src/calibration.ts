// Trimble site calibration (GNSS localization) and the RTK bases it depends
// on, read from a JobXML FieldBook.
//
// A calibration has three parts: a horizontal plane adjustment (in datum.ts),
// a vertical adjustment (geoid plus an inclined plane), and the point pairs it
// was computed from. Each pair joins a control point's grid coordinates to a
// GNSS observation of it. Trimble Access stores residuals only when the
// calibration was computed in the job; for an imported calibration they are
// blank, so they are worked out here from the GNSS point's computed grid.
//
// A calibration is only good while the GNSS positions match the ones it was
// built from, so the RTK base connections are read too: mount point, virtual
// base (VRS) position, physical reference station and the points each served.

import { applyPlaneAdjustment, planeAdjustmentFromJob, type PlaneAdjustment } from './datum';
import { child, children, num, text_ } from './xml';

export interface VerticalAdjustment {
  /** NoAdjustment, GeoidModel, InclinedPlane, GeoidModelAndInclinedPlane... */
  type: string;
  geoid: string;
  originNorth?: number;
  originEast?: number;
  /** Metres. */
  constant: number;
  /** Metres per metre (multiply by 1e6 for ppm). */
  slopeNorth: number;
  slopeEast: number;
}

export interface Residual {
  /** Control minus computed, as Trimble's GridResidual: what to add to the GNSS point to reach control. */
  north: number;
  east: number;
  elevation?: number;
  horizontal: number;
  /** Computed minus control, as Trimble's VerticalResidual. */
  vertical?: number;
}

export interface CalibrationPair {
  gridPoint: string;
  gnssPoint: string;
  /** 3D, Horizontal or Vertical. */
  dimension: string;
  residual?: Residual;
  /** File: stored by Trimble Access. Computed: worked out here (the calibration was imported). */
  residualSource?: 'File' | 'Computed';
}

/** A stakeout of a point, such as a checkshot on control. */
export interface Checkshot {
  name: string;
  design: string;
  /** Design minus measured, as Trimble Access shows them while staking. */
  north: number;
  east: number;
  elevation?: number;
  horizontal: number;
  stored: string;
}

/** One connection to an RTK base, from a ReferenceRecord and the notes before it. */
export interface RtkBase {
  stored: string;
  /** Name of the base point, such as PRS505599112461 for a network's reference station. */
  base: string;
  mountPoint: string;
  format: string;
  solution: string;
  server: string;
  /** Virtual base position Trimble Access noted for a VRS connection. */
  vrs?: { id: string; lat: number; lon: number; height?: number };
  /** Physical reference station the network built the virtual base from. */
  prsId?: string;
  /** Trimble Access noted "New base station detected" for this connection. */
  newBase: boolean;
  /** WGS84 position of the base point, as broadcast. */
  basePosition?: { lat: number; lon: number; height?: number };
  /** Points measured from this connection. */
  points: number;
}

/** A base point that lands near another point in the job, such as the same station keyed in from an older job. */
export interface BaseCheck {
  base: string;
  point: string;
  /** Other point minus base, on the grid. */
  north: number;
  east: number;
  elevation?: number;
  horizontal: number;
}

export interface Calibration {
  horizontalType: string;
  horizontal?: PlaneAdjustment;
  vertical?: VerticalAdjustment;
  /** When the calibration was computed or imported (controller local time). */
  computed: string;
  pairs: CalibrationPair[];
  checkshots: Checkshot[];
  bases: RtkBase[];
  baseChecks: BaseCheck[];
}

export interface CalibrationOptions {
  /** WGS84 lat/lon → projected grid [north, east], before the plane adjustment. */
  toGrid?: (lat: number, lon: number) => [number, number];
}

/** How close a base point and another point must be to be taken as the same mark. */
const SAME_MARK = 5;

export function calibrationFromJob(root: Element, options: CalibrationOptions = {}): Calibration | undefined {
  const fieldBook = child(root, 'FieldBook');
  if (!fieldBook) return undefined;
  const records = Array.from(fieldBook.children);
  const lastOf = (tag: string) => records.filter((r) => r.tagName === tag).at(-1);

  const hRecord = lastOf('HorizontalAdjustmentRecord');
  const vRecord = lastOf('VerticalAdjustmentRecord');
  const horizontal = planeAdjustmentFromJob(root);
  const vertical = vRecord && verticalAdjustment(vRecord);
  const points = pointIndex(fieldBook);

  const grid = (name: string) => {
    const r = points.get(name);
    return r && gridOf(r);
  };
  // Where the calibration puts a GNSS point: Trimble Access's own computed grid,
  // else its WGS84 position through the projection and plane adjustment.
  const calibrated = (name: string): { north: number; east: number; elevation?: number } | undefined => {
    const r = points.get(name);
    if (!r) return undefined;
    const g = gridOf(r);
    if (g) return g;
    const w = wgs84Of(r);
    if (!w || !options.toGrid) return undefined;
    const [n, e] = options.toGrid(w.lat, w.lon);
    const [north, east] = horizontal ? applyPlaneAdjustment(horizontal, n, e) : [n, e];
    return { north, east };
  };

  const pairs = currentPairs(records, hRecord ?? vRecord).map((r): CalibrationPair => {
    const pair: CalibrationPair = {
      gridPoint: text_(r, 'GridPointName'),
      gnssPoint: text_(r, 'WGS84PointName'),
      dimension: text_(r, 'Dimension'),
    };
    const stored = storedResidual(r);
    if (stored) return { ...pair, residual: stored, residualSource: 'File' };
    const control = grid(pair.gridPoint);
    const gnss = calibrated(pair.gnssPoint);
    if (!control || !gnss) return pair;
    const north = control.north - gnss.north;
    const east = control.east - gnss.east;
    const elevation = control.elevation !== undefined && gnss.elevation !== undefined ? control.elevation - gnss.elevation : undefined;
    const residual: Residual = { north, east, horizontal: Math.hypot(north, east) };
    if (elevation !== undefined) Object.assign(residual, { elevation, vertical: -elevation });
    return { ...pair, residual, residualSource: 'Computed' };
  });

  const checkshots = records.filter((r) => r.tagName === 'PointRecord' && !isDeleted(r)).flatMap((r) => {
    const stakeout = child(r, 'Stakeout');
    const deltas = stakeout && child(stakeout, 'GridDeltas');
    const north = deltas && num(deltas, 'DeltaNorth');
    const east = deltas && num(deltas, 'DeltaEast');
    if (north === undefined || east === undefined) return [];
    const design = child(stakeout!, 'PointDesign');
    return [
      {
        name: text_(r, 'Name'),
        design: design ? text_(design, 'Name') : '',
        north,
        east,
        elevation: num(deltas!, 'DeltaElevation'),
        horizontal: Math.hypot(north, east),
        stored: r.getAttribute('TimeStamp') ?? '',
      },
    ];
  });

  const bases = rtkBases(records, points);
  const baseChecks = checkBases(bases, points, calibrated);

  const horizontalType = hRecord ? text_(hRecord, 'Type') : '';
  const adjusted = horizontal || (vertical && vertical.type !== 'NoAdjustment' && vertical.type !== 'GeoidModel');
  if (!adjusted && !pairs.length && !checkshots.length && !bases.length) return undefined;
  return {
    horizontalType,
    horizontal,
    vertical,
    computed: (hRecord ?? vRecord)?.getAttribute('TimeStamp') ?? '',
    pairs,
    checkshots,
    bases,
    baseChecks,
  };
}

export function verticalAdjustment(r: Element): VerticalAdjustment {
  return {
    type: text_(r, 'Type'),
    geoid: text_(r, 'GeoidName'),
    originNorth: num(r, 'OriginNorth'),
    originEast: num(r, 'OriginEast'),
    constant: num(r, 'ConstantAdjustment') ?? 0,
    slopeNorth: num(r, 'SlopeNorthPerUnit') ?? 0,
    slopeEast: num(r, 'SlopeEastPerUnit') ?? 0,
  };
}

/**
 * The pairs of the calibration in force. Trimble Access writes a full set of
 * CalibrationPointRecords each time it computes (or imports) a calibration,
 * with the same timestamp as the adjustment records that follow them.
 */
function currentPairs(records: Element[], adjustment: Element | undefined): Element[] {
  const all = records.filter((r) => r.tagName === 'CalibrationPointRecord');
  if (!all.length) return [];
  const stamp = adjustment?.getAttribute('TimeStamp');
  let set = stamp ? all.filter((r) => r.getAttribute('TimeStamp') === stamp) : [];
  if (!set.length) {
    const last = all.at(-1)!.getAttribute('TimeStamp');
    set = all.filter((r) => r.getAttribute('TimeStamp') === last);
  }
  // A pair recomputed in the same set supersedes the earlier one.
  const byGrid = new Map<string, Element>();
  for (const r of set) byGrid.set(text_(r, 'GridPointName'), r);
  return [...byGrid.values()];
}

function storedResidual(r: Element): Residual | undefined {
  const h = num(r, 'HorizontalResidual');
  const v = num(r, 'VerticalResidual');
  const g = child(r, 'GridResidual');
  const north = g && num(g, 'DeltaNorth');
  const east = g && num(g, 'DeltaEast');
  if (h === undefined && v === undefined && north === undefined) return undefined;
  return {
    north: north ?? 0,
    east: east ?? 0,
    elevation: g && num(g, 'DeltaElevation'),
    horizontal: h ?? Math.hypot(north ?? 0, east ?? 0),
    vertical: v,
  };
}

function rtkBases(records: Element[], points: Map<string, Element>): RtkBase[] {
  const bases: RtkBase[] = [];
  const byRecordId = new Map<string, RtkBase>();
  let source = { mountPoint: '', format: '', solution: '', server: '' };
  let vrs: RtkBase['vrs'];
  let prsId: string | undefined;
  let newBase = false;
  for (const r of records) {
    switch (r.tagName) {
      case 'NTRIPDataSourceRecord': {
        const host = text_(r, 'IPAddress');
        const port = text_(r, 'IPPort');
        source = {
          mountPoint: text_(r, 'MountPoint'),
          // A reconnect can leave these empty; keep what the session started with.
          format: text_(r, 'DataFormat') || (text_(r, 'MountPoint') === source.mountPoint ? source.format : ''),
          solution: text_(r, 'Solution') || (text_(r, 'MountPoint') === source.mountPoint ? source.solution : ''),
          server: host ? `${host}${port ? `:${port}` : ''}` : '',
        };
        break;
      }
      case 'NoteRecord': {
        for (const note of noteTexts(r)) {
          if (/new base station detected/i.test(note)) newBase = true;
          const parsed = parseVrsNote(note);
          if (parsed) ({ vrs, prsId } = parsed);
        }
        break;
      }
      case 'ReferenceRecord': {
        const base = text_(r, 'PointName');
        const point = points.get(base);
        const w = point && wgs84Of(point);
        const entry: RtkBase = {
          stored: r.getAttribute('TimeStamp') ?? '',
          base,
          ...source,
          vrs,
          prsId,
          newBase,
          basePosition: w,
          points: 0,
        };
        bases.push(entry);
        const id = r.getAttribute('ID');
        if (id) byRecordId.set(id, entry);
        vrs = undefined;
        prsId = undefined;
        newBase = false;
        break;
      }
      case 'PointRecord': {
        const entry = byRecordId.get(text_(r, 'ReferenceRecordID'));
        if (entry && !isDeleted(r)) entry.points++;
        break;
      }
    }
  }
  return bases;
}

/** "VRSID:4, 37°05'16.60741", -121°36'07.95778", 183.600sft, PRSID:9" */
export function parseVrsNote(note: string): { vrs: NonNullable<RtkBase['vrs']>; prsId?: string } | undefined {
  const m = note.match(/VRSID\s*:\s*([^,\s]+)\s*,\s*([^,]+),\s*([^,]+),\s*([-\d.]+)\s*(sft|ift|ft|m)?\s*(?:,\s*PRSID\s*:\s*(\S+))?/i);
  if (!m) return undefined;
  const lat = parseDms(m[2]);
  const lon = parseDms(m[3]);
  if (lat === undefined || lon === undefined) return undefined;
  const unit = (m[5] ?? 'm').toLowerCase();
  const toMetres = unit === 'sft' ? 1200 / 3937 : unit === 'ift' || unit === 'ft' ? 0.3048 : 1;
  return { vrs: { id: m[1], lat, lon, height: Number(m[4]) * toMetres }, prsId: m[6] };
}

/** 37°05'16.60741" or -121°36'07.95778"W → decimal degrees. */
export function parseDms(s: string): number | undefined {
  const m = s.trim().match(/^([-+]?)(\d+)°\s*(\d+)['′]\s*([\d.]+)["″]?\s*([NSEW])?$/i);
  if (!m) {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }
  const v = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  const negative = m[1] === '-' || /[SW]/i.test(m[5] ?? '');
  return negative ? -v : v;
}

function checkBases(
  bases: RtkBase[],
  points: Map<string, Element>,
  calibrated: (name: string) => { north: number; east: number; elevation?: number } | undefined,
): BaseCheck[] {
  const checks: BaseCheck[] = [];
  const names = [...new Set(bases.map((b) => b.base))];
  const others = [...points.entries()].filter(([name]) => !names.includes(name));
  for (const base of names) {
    const at = calibrated(base);
    if (!at) continue;
    for (const [name, r] of others) {
      const g = gridOf(r);
      if (!g) continue;
      const north = g.north - at.north;
      const east = g.east - at.east;
      const horizontal = Math.hypot(north, east);
      if (horizontal > SAME_MARK) continue;
      const elevation = g.elevation !== undefined && at.elevation !== undefined ? g.elevation - at.elevation : undefined;
      checks.push({ base, point: name, north, east, elevation, horizontal });
    }
  }
  return checks.sort((a, b) => a.horizontal - b.horizontal);
}

/** The last live PointRecord of each name. */
function pointIndex(fieldBook: Element): Map<string, Element> {
  const byName = new Map<string, Element>();
  for (const r of children(fieldBook, 'PointRecord')) if (!isDeleted(r)) byName.set(text_(r, 'Name'), r);
  return byName;
}

function gridOf(r: Element): { north: number; east: number; elevation?: number } | undefined {
  const g = child(r, 'Grid') ?? child(r, 'ComputedGrid');
  const north = g && num(g, 'North');
  const east = g && num(g, 'East');
  if (north === undefined || east === undefined) return undefined;
  return { north, east, elevation: num(g!, 'Elevation') };
}

function wgs84Of(r: Element): { lat: number; lon: number; height?: number } | undefined {
  const w = child(r, 'WGS84');
  const lat = w && num(w, 'Latitude');
  const lon = w && num(w, 'Longitude');
  if (lat === undefined || lon === undefined) return undefined;
  return { lat, lon, height: num(w!, 'Height') };
}

function noteTexts(r: Element): string[] {
  const notes = child(r, 'Notes');
  return notes ? Array.from(notes.children).map((n) => n.textContent?.trim() ?? '') : [text_(r, 'Note')];
}

function isDeleted(el: Element): boolean {
  return text_(el, 'Deleted').toLowerCase() === 'true';
}
