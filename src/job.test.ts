// @vitest-environment jsdom
//
// The JOB reader on a small made-up job, built record by record here so the
// test documents the layout (see docs/job-format.md). Real jobs are checked
// against their JobXML in job.compare.test.ts.

import { describe, expect, it } from 'vitest';
import { readGgf } from './geoid';
import { crc16, groundUnderAntenna, isJob, jobGeoidFile, jobToJxl, JobParseError, parseJob, readJob } from './job';

const NULL = new Uint8Array([0xa0, 0xc8, 0xeb, 0x85, 0xf3, 0xcc, 0xe1, 0x7f]);
const RAD = Math.PI / 180;

/** Little-endian byte builder. */
class Bytes {
  parts: number[] = [];
  u8(...v: number[]) {
    this.parts.push(...v);
    return this;
  }
  u16(v: number) {
    return this.u8(v & 0xff, v >> 8);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.u8(...b);
  }
  i32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.u8(...b);
  }
  f64(v: number | null) {
    if (v === null) return this.u8(...NULL);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.u8(...b);
  }
  str(s: string) {
    return this.u8(...new TextEncoder().encode(s), 0);
  }
  chars(s: string) {
    return this.u8(...new TextEncoder().encode(s));
  }
  zeros(n: number) {
    return this.u8(...new Array(n).fill(0));
  }
  get bytes() {
    return new Uint8Array(this.parts);
  }
}

// 2026-03-02T09:30:00 local, PST (UTC-8), as seconds since 1980-01-01.
const T = (Date.UTC(2026, 2, 2, 9, 30) - Date.UTC(1980, 0, 1)) / 1000;

function record(kind: number, parent: number, type: number, id: number, payload: Uint8Array, seconds = T) {
  const body = new Bytes().u8(0).u16(kind).u32(parent).u16(type).u32(id).f64(seconds).u16(480).u8(...payload).bytes;
  const crc = crc16(body);
  return new Bytes().u32(body.length + 2).u8(...body).u16(crc).bytes;
}
const NEW = 0x2a30;
const CHILD = 0x2a33;

function header() {
  const b = new Bytes().chars('Trimble General Survey Journal').zeros(12).u8(1, 4, 0, 26, 10, 15);
  return b.bytes;
}

interface Feature {
  name: string;
  attrs?: [type: number, name: string, value: string | number | null, index?: number][];
}

function features(list: Feature[]) {
  const b = new Bytes().u8(0).u32(list.length);
  for (const f of list) {
    b.u8(0).str(f.name).u8(3).u16(0).u32(f.attrs?.length ?? 0);
    for (const [type, name, value, index] of f.attrs ?? []) {
      b.u16(type).str(name);
      if (type === 0) b.f64(value as number | null);
      else if (type === 2) b.u16(index ?? 0).str(value as string);
      else b.str(value as string);
    }
  }
  return b;
}

function point(name: string, list: Feature[], source: string, method: number, survey: number, cls: number, description = '') {
  return features(list).str(description).zeros(7).str(name).chars(source).u16(method).u16(survey).u16(cls).u16(0).u16(1).bytes;
}

function wgs84(lat: number, lon: number, h: number) {
  return new Bytes().u8(0).f64(lat * RAD).f64(lon * RAD).f64(h).bytes;
}

const BASE = [37.3, -121.9, -10] as const;
const DELTA = [12.5, -3.25, 4] as const;
const ATTITUDE = { yaw: -30 * RAD, pitch: 5 * RAD, roll: -2 * RAD };

function sampleJob(more?: (add: (r: Uint8Array) => void) => void): Uint8Array {
  const parts: Uint8Array[] = [header()];
  const add = (r: Uint8Array) => parts.push(r);
  // Job created as "Template", renamed to "Synthetic".
  add(record(NEW, 0, 0, 1, new Bytes().u8(0).str('Template').u8(0).str('SN123').str('2026.11 (26.10.313)').str('Trimble Access').u8(0).bytes));
  add(record(CHILD, 0, 1003, 2, new Bytes().u8(0, 2).str('Synthetic').bytes));
  add(record(NEW, 0, 51, 3, new Bytes().u8(0).u16(6).u16(6).bytes));
  add(record(NEW, 0, 41, 4, new Bytes().zeros(16).u8(2).zeros(18).bytes));
  add(record(NEW, 0, 36, 5, new Bytes().u8(0).chars('KI').f64(6378137).f64(1 / 298.257222101).u32(0xffffffff).i32(7019).bytes));
  // California zone 3, angles in radians.
  const proj = new Bytes().u8(0).chars('KI').u16(7).f64(36.5 * RAD).f64(-120.5 * RAD).f64(null).f64(500000).f64(2000000);
  proj.f64(null).f64(null).u8(0, 0).f64((38 + 26 / 60) * RAD).f64((37 + 4 / 60) * RAD).zeros(16).f64(1).f64(null).f64(null).f64(30).zeros(33);
  add(record(NEW, 0, 38, 6, proj.bytes));
  add(record(NEW, 0, 87, 7, new Bytes().u8(0).str('United States/NAD83/CA SRS').str('California Zone 3').str('NAD83').bytes));
  // Base: keyed-in point, a null antenna at the base and a reference record.
  add(record(NEW, 0, 2, 10, point('BASE', [], 'SI', 60, 0, 4)));
  add(record(CHILD, 10, 15, 11, wgs84(...BASE)));
  const equipment = (receiver: string, method: string, vertical: number) =>
    new Bytes().u8(0).str(receiver).str('').str('S1').f64(6.5).str(`${receiver} Internal`).str('').str(method).str('').u16(720).u8(1).u8(0).f64(0).f64(0).f64(vertical).chars('NM').u8(1, 0, 0, 0).f64(null).f64(null).bytes;
  add(record(NEW, 0, 45, 12, equipment('', 'Antenna Phase Center', 0)));
  add(record(NEW, 0, 46, 13, new Bytes().u8(0).f64(0.5).u8(3, 0).u32(12).u32(0).f64(null).bytes));
  add(record(NEW, 0, 70, 14, new Bytes().u8(0).str('BASE').u32(13).chars('KI').bytes));
  // Rover: 2 m pole to the bottom of the quick release, 0.18106 m to the phase centre.
  add(record(NEW, 0, 45, 15, equipment('R980', 'Bottom of quick release', 0.18106)));
  add(record(NEW, 0, 46, 16, new Bytes().u8(0).f64(2).u8(3, 0).u32(15).u32(0).f64(null).bytes));
  // A tilted GNSS shot with a feature code, its attributes edited later.
  const wall: Feature = {
    name: 'WALB',
    attrs: [
      [2, 'Material', 'Concrete', 2],
      [0, 'Height', 3.3],
      [1, 'Desc_1', 'old'],
      [8, 'Photo_1', 'wall.jpg'],
    ],
  };
  add(record(NEW, 0, 2, 20, point('100', [wall, { name: 'BL' }], 'TP', 11, 15, 4, 'top of wall')));
  const vector = new Bytes().u8(0).f64(DELTA[0]).f64(DELTA[1]).f64(DELTA[2]).u32(14).u32(16).u8(3);
  vector.f64(ATTITUDE.yaw).f64(ATTITUDE.pitch).f64(ATTITUDE.roll).f64(0.03).f64(0.001).f64(0.001);
  add(record(CHILD, 20, 9, 21, vector.bytes));
  add(record(NEW, 0, 35, 22, new Bytes().u8(0).f64(0.008).f64(0.012).bytes));
  add(record(NEW, 0, 31, 23, new Bytes().u8(0).bytes));
  const edited = { ...wall, attrs: wall.attrs!.map((a) => (a[1] === 'Desc_1' ? ([1, 'Desc_1', 'new'] as typeof a) : a)) };
  add(record(CHILD, 20, 1004, 24, features([edited, { name: 'BL' }]).bytes));
  // A point 0.5 m due east of the base, then deleted, with a note.
  add(record(NEW, 0, 2, 30, point('101', [{ name: 'TREE' }], 'TP', 6, 15, 4)));
  add(record(CHILD, 30, 19, 31, new Bytes().u8(0).str('BASE').f64(90 * RAD).f64(0.5).f64(0).u8(0x49, 4).bytes));
  add(record(CHILD, 30, 1000, 32, new Bytes().u8(0, 0).bytes));
  add(record(CHILD, 30, 1, 33, new Bytes().str('Deleted 9:31:00 AM 3/2/2026\r\n').bytes));
  // A keyed-in grid point.
  add(record(NEW, 0, 2, 40, point('CP1', [{ name: 'CTRLP' }], 'KI', 1, 0, 9)));
  add(record(CHILD, 40, 17, 41, new Bytes().u8(0).f64(600000).f64(1900000).f64(25).bytes));
  more?.(add);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('readJob', () => {
  it('recognises a job file and splits it into records', () => {
    const bytes = sampleJob();
    expect(isJob(bytes)).toBe(true);
    expect(isJob(new TextEncoder().encode('<?xml version="1.0"?><JOBFile/>'))).toBe(false);
    const job = readJob(bytes);
    expect(job.version).toBe('26.10.15');
    expect(job.records.map((r) => r.id).slice(0, 3)).toEqual([1, 2, 3]);
    expect(job.records[0].time).toBe('2026-03-02T09:30:00');
    expect(job.records[0].utcOffset).toBe(480);
  });

  it('rejects a damaged record', () => {
    const bytes = sampleJob();
    bytes[0x30 + 10] ^= 0xff;
    expect(() => readJob(bytes)).toThrow(JobParseError);
    const good = sampleJob();
    expect(() => readJob(good.subarray(0, good.length - 3))).toThrow(/truncated/);
  });

  it('computes CRC-16/ARC', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
  });
});

describe('parseJob', () => {
  const doc = parseJob(sampleJob());
  const byName = new Map(doc.points.map((p) => [p.name, p]));

  it('reads the job name, units and coordinate system', () => {
    expect(doc.job.jobName).toBe('Synthetic');
    expect(doc.job.controllerSerialNumber).toBe('SN123');
    expect(doc.crs.systemName).toBe('United States/NAD83/CA SRS');
    expect(doc.crs.distanceUnits).toBe('USSurveyFeet');
    expect(doc.crs.projection?.proj4).toContain('+proj=lcc +lat_0=36.5 +lon_0=-120.5');
    expect(doc.crs.scaleFactor?.value).toBeCloseTo(0.99995, 4);
    expect(doc.format).toBe('job');
  });

  it('reads points, codes, edited attributes and deletes', () => {
    expect(doc.points.map((p) => p.name)).toEqual(['BASE', '100', 'CP1']);
    const p = byName.get('100')!;
    expect(p.code).toBe('WALB BL');
    expect(p.method).toBe('GNSS observation');
    expect(p.surveyMethod).toBe('Network RTK');
    expect(p.type).toBe('GNSS');
    expect(p.attributes['FieldBook.Description1']).toBe('top of wall');
    expect(p.features).toEqual([
      { name: 'WALB', attributes: { Material: 'Concrete', Height: '3.3', Desc_1: 'new', Photo_1: 'Synthetic Files/wall.jpg' } },
    ]);
    expect(p.stored).toBe('2026-03-02T09:30:00');
  });

  it('keeps deleted points out of the reductions', () => {
    const xml = jobToJxl(sampleJob());
    expect(xml).toContain('<Name>101</Name>');
    expect(xml).toContain('<Deleted>true</Deleted>');
    expect(xml).toContain('Deleted 9:31:00 AM 3/2/2026');
    expect(byName.has('101')).toBe(false);
  });

  it('reduces a tilted GNSS shot to the ground', () => {
    const c = byName.get('100')!.coords;
    // Same reduction by hand: base mark + base antenna, + vector, then down the pole.
    const base = up(BASE, 0.5);
    const apc = addEcef(base, DELTA);
    const [lat, lon, h] = groundUnderAntenna(apc, 2.18106, ATTITUDE);
    expect(c.lat).toBeCloseTo(lat / RAD, 10);
    expect(c.lon).toBeCloseTo(lon / RAD, 10);
    expect(c.height).toBeCloseTo(h, 6);
    // The pole is 2.18 m long and leans about 5.4°, so the mark is ~0.2 m from under the antenna.
    expect(apc[2] - h).toBeCloseTo(2.18106 * Math.cos(5 * RAD) * Math.cos(2 * RAD), 3);
    expect(c.north).toBeDefined();
    expect(c.east).toBeDefined();
  });

  it('keeps keyed-in grid coordinates', () => {
    const c = byName.get('CP1')!.coords;
    expect([c.north, c.east, c.elevation]).toEqual([600000, 1900000, 25]);
    expect(byName.get('CP1')!.classification).toBe('Control');
    expect(doc.gridOnlyCount).toBe(1);
  });
});

// Small helpers for the hand reduction, in radians and metres.
const A = 6378137;
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
function toEcef(lat: number, lon: number, h: number) {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + h) * Math.sin(lat)];
}
function fromEcef([x, y, z]: number[]): [number, number, number] {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lat, lon, h];
}
function up(p: readonly [number, number, number], d: number): [number, number, number] {
  return [p[0] * RAD, p[1] * RAD, p[2] + d];
}
function addEcef(p: [number, number, number], d: readonly number[]): [number, number, number] {
  const x = toEcef(...p);
  return fromEcef([x[0] + d[0], x[1] + d[1], x[2] + d[2]]);
}

// A geoid grid file whose surface is a plane: -30 m at 37°N 122°W, rising
// 1 m per degree north and 2 m per degree east.
function planeGgf(): Uint8Array {
  const [south, west, step, rows, cols] = [37, 237.5, 0.1, 11, 11];
  const b = new Bytes().u8(0, 0).chars('TNL GRID FILE').u8(0).chars('Plane').zeros(27);
  b.f64(south).f64(south + step * (rows - 1)).f64(west).f64(west + step * (cols - 1)).f64(step).f64(step).i32(rows).i32(cols).zeros(42);
  const cells = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells[r * cols + c] = -30 + r * step + 2 * (west + c * step - 238);
  return new Uint8Array([...b.bytes, ...new Uint8Array(cells.buffer)]);
}

/** A second day's work on the sample job: a calibration, edits and repeat shots. */
function busyJob(): Uint8Array {
  return sampleJob((add) => {
    // Vertical adjustment: geoid model "plane" and a calibration constant.
    const vertical = new Bytes().u8(0).chars('CB').u16(4).f64(600000).f64(1900000).f64(0).f64(0).f64(-0.02).str('plane').i32(-1);
    add(record(NEW, 0, 40, 50, vertical.bytes));
    add(record(NEW, 0, 54, 51, new Bytes().u8(0).str('Lib').str('/files/Lib.fxl').str('Lib.fxl').u8(0, 0, 0, 1).bytes));
    add(record(NEW, 0, 49, 52, new Bytes().u8(0, 1, 0).bytes));
    add(record(NEW, 0, 151, 53, new Bytes().u8(0).str('MOUNT').str('CMRx').str('Network').str('10.0.0.1').u16(2101).zeros(21).bytes));
    const pair = new Bytes().u8(0).str('CP1').str('100').u8(3, 0).f64(-0.01).f64(0.02).f64(0.0224).f64(600000).f64(1900000).f64(25);
    add(record(NEW, 0, 44, 54, pair.f64(0.012).f64(-0.016).f64(0.01).u32(20).bytes));
    // An untilted shot whose attributes were edited before it was stored, so
    // the point record opens with a note. Later renamed from 200 to 201.
    const noted = new Bytes().str('Modified 9:40:00 AM 3/2/2026\r\nOld values TREE\r\n').u8(...features([{ name: 'TREE' }]).bytes.subarray(1));
    noted.str('').zeros(7).str('200').chars('TP').u16(13).u16(15).u16(4).u16(0).u16(1);
    add(record(NEW, 0, 2, 60, noted.bytes));
    add(record(CHILD, 60, 8, 61, new Bytes().u8(0).f64(DELTA[0]).f64(DELTA[1]).f64(DELTA[2]).u32(14).u32(16).bytes));
    add(record(NEW, 0, 172, 62, new Bytes().u8(0, 1).f64(0.5 * RAD).f64(-0.25 * RAD).bytes));
    add(record(NEW, 0, 33, 63, new Bytes().u8(0).u16(19).f64(0.01).f64(1e-5).f64(2e-6).f64(-3e-6).f64(4e-5).f64(5e-6).f64(6e-5).f64(1).bytes));
    add(record(NEW, 0, 31, 64, new Bytes().u8(0).bytes));
    add(record(CHILD, 60, 1003, 65, new Bytes().u8(0, 0).str('201').bytes));
    // A point copied from a control file.
    const copied = new Bytes().u8(...features([{ name: 'CTRL' }]).bytes).str('').zeros(7).str('CP2').chars('CC').u16(59).u16(0).u16(4).u8(0).str('/files/control.csv').u16(0);
    add(record(NEW, 0, 2, 70, copied.bytes));
    add(record(CHILD, 70, 17, 71, new Bytes().u8(0).f64(600100).f64(1900100).f64(26).bytes));
    // Point 100 measured again as a check, then the average of both.
    add(record(NEW, 0, 2, 80, point('100', [], 'TP', 13, 15, 0)));
    add(record(CHILD, 80, 8, 81, new Bytes().u8(0).f64(DELTA[0]).f64(DELTA[1]).f64(DELTA[2] + 1).u32(14).u32(16).bytes));
    add(record(NEW, 0, 31, 82, new Bytes().u8(0).bytes));
    add(record(NEW, 0, 2, 90, point('100', [], 'AV', 1, 0, 7)));
    add(record(CHILD, 90, 15, 91, wgs84(37.3001, -121.9001, -8)));
    add(record(NEW, 0, 144, 92, new Bytes().u8(0).f64(0.001).f64(0.002).f64(0.003).bytes));
    const residuals = new Bytes().u8(0).u32(1).zeros(17).u32(20).u8(1).f64(0.004).f64(-0.005).f64(0.006).f64(null).f64(null).f64(null).zeros(2);
    add(record(NEW, 0, 155, 93, residuals.bytes));
    add(record(NEW, 0, 31, 94, new Bytes().u8(0).bytes));
  });
}

describe('a job with a calibration, edits and repeat shots', () => {
  const bytes = busyJob();
  const geoid = readGgf(planeGgf());
  const xml = jobToJxl(bytes, { geoid });
  const doc = parseJob(bytes, { geoid });
  const byName = new Map(doc.points.map((p) => [p.name, p]));
  const record = (id: number) => xml.slice(xml.indexOf(`ID="${id.toString(16).padStart(8, '0')}"`)).split(/<\/\w+Record>/)[0];

  it('names the geoid model the job needs', () => {
    expect(jobGeoidFile(bytes)).toBe('plane');
    expect(jobGeoidFile(sampleJob())).toBeUndefined();
    expect(record(50)).toContain('<GeoidName>Plane</GeoidName>');
  });

  it('works out elevations from the geoid model and the vertical adjustment', () => {
    const c = byName.get('201')!.coords;
    // The job's ellipsoid is GRS80, so the height above it is found first.
    const n = -30 + (c.lat! - 37) + 2 * (c.lon! + 122);
    expect(c.elevation).toBeCloseTo(c.height! - n - 0.02, 3);
    expect(record(60)).toContain('<ComputedGrid>');
    expect(parseJob(bytes).points.find((p) => p.name === '201')!.coords.elevation).toBeUndefined();
  });

  it('reads a point that opens with a note, and its rename', () => {
    expect(record(60)).toContain('<Name>201</Name>');
    expect(record(60)).toContain('<Note>Old values TREE</Note>');
    expect(byName.get('201')!.code).toBe('TREE');
    expect(byName.has('200')).toBe(false);
  });

  it('reads bubble tilt and the vector covariance', () => {
    expect(record(60)).toMatch(/<Type>VerticalTiltError<\/Type>\s*<Attitude>\s*<Pitch>0.5<\/Pitch>\s*<Roll>-0.25<\/Roll>/);
    expect(record(60)).toMatch(/<QualityControl2>\s*<NumberOfSatellites>19<\/NumberOfSatellites>\s*<ErrorScale>0.01</);
    expect(record(60)).toContain('<VCVzz>0.00006</VCVzz>');
  });

  it('reads a copied point and the file it came from', () => {
    expect(record(70)).toContain('<Method>CopiedPoint</Method>');
    expect(record(70)).toContain('<Source>/files/control.csv</Source>');
    expect(byName.get('CP2')!.coords.elevation).toBe(26);
  });

  it('keeps one point per name, by class', () => {
    expect(doc.points.filter((p) => p.name === '100')).toHaveLength(1);
    const p = byName.get('100')!;
    expect(p.id).toBe('0000005a');
    expect(p.classification).toBe('Averaged');
    expect(p.coords.lat).toBeCloseTo(37.3001, 9);
    expect(record(90)).toMatch(/<EastStandardDeviation>0.002</);
    expect(record(90)).toMatch(/<ObservationID>00000014<\/ObservationID>\s*<IncludedInAverageComputation>true</);
    expect(record(90)).toMatch(/<DeltaElevation>0.006</);
  });

  it('reads the calibration, its residuals and the RTK data source', () => {
    expect(doc.calibration?.vertical).toMatchObject({ type: 'GeoidModelAndInclinedPlane', constant: -0.02 });
    expect(doc.calibration?.pairs).toEqual([
      {
        gridPoint: 'CP1',
        gnssPoint: '100',
        dimension: '3D',
        residual: { north: 0.012, east: -0.016, elevation: 0.01, horizontal: 0.02, vertical: -0.01 },
        residualSource: 'File',
      },
    ]);
    expect(doc.calibration?.bases[0]).toMatchObject({ base: 'BASE' });
    expect(record(53)).toMatch(/<MountPoint>MOUNT<\/MountPoint>\s*<DataFormat>CMRx<\/DataFormat>\s*<Solution>Network<\/Solution>\s*<IPAddress>10.0.0.1<\/IPAddress>\s*<IPPort>2101</);
    expect(record(51)).toMatch(/<LibraryName>Lib<\/LibraryName>\s*<SourceFilename>Lib.fxl</);
    expect(record(52)).toContain('<Event>StartRoverSurvey</Event>');
  });
});
