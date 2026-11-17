// Reader for Trimble Access binary job files (.job).
//
// Trimble doesn't publish this format. The layout here was worked out by
// comparing JOB files with JobXML exported from the same jobs, and is written
// up in docs/job-format.md. In short: a 48-byte header, then a journal of
// length-prefixed records, each with a CRC. Records are never rewritten in
// place: an edit, a delete or a new set of feature attributes is a later
// record that points back at the one it changes, so the current state of a
// job is found by replaying the journal.
//
// Rather than build a second document model, the job is translated into
// JobXML and handed to the JobXML parser, so everything downstream (map,
// properties, linework, calibration) works the same for both. The JOB doesn't
// store the ground positions, grid coordinates or elevations Trimble Access
// computes, so GNSS shots are reduced here (base + vector, antenna height and
// tilt), projected with the job's own coordinate system and calibration, and
// given elevations from the geoid model when its file is supplied.
//
// Read-only: nothing here writes JOB files.

import proj4 from 'proj4';
import { verticalAdjustment, type VerticalAdjustment } from './calibration';
import { detectCrs } from './crs';
import { applyPlaneAdjustment, removePlaneAdjustment } from './datum';
import { undulation, type GeoidGrid } from './geoid';
import { parseJxl, type JxlDocument, type ParseOptions } from './jxl';

export class JobParseError extends Error {}

const MAGIC = 'Trimble General Survey Journal';
const HEADER_LENGTH = 0x30;

/** Trimble's "no value" double (about 1e308). */
const NULL_DOUBLE = 1e307;

/** Record kinds: the 16-bit tag after the status byte. */
const KIND_NEW = 0x2a30;
const KIND_REPLACE = 0x2a31;
const KIND_CHILD_REPLACE = 0x2a32;
const KIND_CHILD = 0x2a33;

/** Record types seen so far. Names follow the matching JobXML record. */
export const RecordType = {
  Header: 0,
  Note: 1,
  Point: 2,
  GnssVector: 8,
  GnssVectorTilted: 9,
  Wgs84Position: 15,
  GridPosition: 17,
  Polar: 19,
  TotalStationObservation: 21,
  PointEnd: 31,
  QualityControl1: 32,
  QualityControl2: 33,
  Precision: 35,
  Ellipsoid: 36,
  Datum: 37,
  Projection: 38,
  HorizontalAdjustment: 39,
  VerticalAdjustment: 40,
  Corrections: 41,
  CalibrationPoint: 44,
  GpsEquipment: 45,
  Antenna: 46,
  SurveyEvent: 49,
  Units: 51,
  FeatureCoding: 54,
  Initialisation: 68,
  Reference: 70,
  CoordinateSystem: 87,
  ActiveMapFiles: 127,
  GridStandardDeviations: 144,
  TimeZone: 146,
  NtripDataSource: 151,
  AverageResiduals: 155,
  BubbleTilt: 172,
  KinematicTransformations: 216,
  Deleted: 1000,
  JobName: 1003,
  Features: 1004,
} as const;

export interface JobRecord {
  /** Byte offset of the record's length field. */
  offset: number;
  /** First byte of the record. Its meaning isn't known yet (0-3). */
  status: number;
  kind: number;
  /** For a child or replacement record, the record it belongs to. */
  parent: number;
  type: number;
  id: number;
  /** Controller local time, as JobXML writes it: 2026-09-24T07:38:38. */
  time: string;
  /** Minutes to add to the local time to get UTC. */
  utcOffset: number;
  /** Everything after the 23-byte record header, without the CRC. */
  payload: Uint8Array;
}

export interface JobFile {
  /** Trimble Access database version from the header, e.g. "26.10.15". */
  version: string;
  records: JobRecord[];
}

/** True when the bytes start like a Trimble Access job file. */
export function isJob(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LENGTH) return false;
  return new TextDecoder('latin1').decode(bytes.subarray(0, MAGIC.length)) === MAGIC;
}

/** Split a job file into its records, checking each one's CRC. */
export function readJob(bytes: Uint8Array): JobFile {
  if (!isJob(bytes)) throw new JobParseError('Not a Trimble Access job file: the header is missing.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = `${bytes[0x2d]}.${bytes[0x2e]}.${bytes[0x2f]}`;
  const records: JobRecord[] = [];
  let o = HEADER_LENGTH;
  while (o + 4 <= bytes.length) {
    const n = view.getUint32(o, true);
    if (n < 25 || o + 4 + n > bytes.length) {
      throw new JobParseError(`Record at byte ${o} runs past the end of the file. The file may be truncated.`);
    }
    const body = bytes.subarray(o + 4, o + 4 + n);
    if (crc16(body.subarray(0, n - 2)) !== view.getUint16(o + 4 + n - 2, true)) {
      throw new JobParseError(`Record at byte ${o} fails its checksum. The file may be damaged.`);
    }
    const r = new Cursor(body);
    const status = r.u8();
    const kind = r.u16();
    const parent = r.u32();
    const type = r.u16();
    const id = r.u32();
    const seconds = r.f64Raw();
    const utcOffset = r.u16();
    records.push({ offset: o, status, kind, parent, type, id, time: localTime(seconds), utcOffset, payload: body.subarray(23, n - 2) });
    o += 4 + n;
  }
  return { version, records };
}

/** CRC-16/ARC (reflected 0x8005, initial value 0). */
export function crc16(data: Uint8Array): number {
  let c = 0;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  return c;
}

/** Seconds since 1980-01-01 in controller local time → "YYYY-MM-DDTHH:MM:SS". */
function localTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > NULL_DOUBLE) return '';
  return new Date(Date.UTC(1980, 0, 1) + Math.round(seconds) * 1000).toISOString().slice(0, 19);
}

class Cursor {
  private view: DataView;
  constructor(
    private bytes: Uint8Array,
    public o = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.bytes.length - this.o;
  }
  u8() {
    return this.bytes[this.o++];
  }
  u16() {
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  f64Raw() {
    const v = this.view.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }
  /** A double, or undefined for Trimble's null value. */
  f64() {
    const v = this.f64Raw();
    return Number.isFinite(v) && Math.abs(v) < NULL_DOUBLE ? v : undefined;
  }
  /** Null-terminated UTF-8 string. */
  str() {
    let e = this.o;
    while (e < this.bytes.length && this.bytes[e] !== 0) e++;
    const s = new TextDecoder().decode(this.bytes.subarray(this.o, e));
    this.o = e + 1;
    return s;
  }
  chars(n: number) {
    const s = new TextDecoder('latin1').decode(this.bytes.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
  at(o: number) {
    this.o = o;
    return this;
  }
}

// ---------------------------------------------------------------- decoders

export interface JobAttribute {
  name: string;
  /** JobXML attribute type: Numeric, Text, Menu, File, Photo... */
  type: string;
  value: string;
  itemIndex?: number;
}

export interface JobFeature {
  name: string;
  attributes: JobAttribute[];
}

export interface JobPointRecord {
  name: string;
  /** Note text stored with the point: "Modified ...", "Old values ...". */
  note: string;
  features: JobFeature[];
  description1: string;
  description2: string;
  /** Two-letter source tag: KI keyed in, TP topo, SI base, CN control... */
  source: string;
  method: string;
  surveyMethod: string;
  classification: string;
  /** For a point copied from another file, the file it came from. */
  sourceFile: string;
}

const ATTRIBUTE_TYPES: Record<number, string> = { 0: 'Numeric', 1: 'Text', 2: 'Menu', 5: 'File', 8: 'Photo' };

// Enum values seen so far, checked against JobXML. Anything else is shown as
// its number so it can be filled in later.
const METHODS: Record<number, string> = {
  1: 'Coordinates',
  6: 'BearingDistancePointIntersection',
  11: 'GpsStaticObservation',
  13: 'GpsRTKControlPoint',
  59: 'CopiedPoint',
  60: 'FromBase',
};
const SURVEY_METHODS: Record<number, string> = { 0: 'KeyedIn', 1: 'Autonomous', 14: 'RTK', 15: 'NetworkRTK' };
const CLASSIFICATIONS: Record<number, string> = { 0: 'Check', 3: 'Construction', 4: 'Normal', 7: 'Averaged', 9: 'Control' };

function enumName(map: Record<number, string>, v: number): string {
  return map[v] ?? `Unknown${v}`;
}

/** The feature codes and their attributes, as in a point or a type 1004 record. */
function readFeatures(c: Cursor): JobFeature[] {
  const n = c.u32();
  const out: JobFeature[] = [];
  for (let i = 0; i < n; i++) {
    c.u8();
    const name = c.str();
    c.u8();
    c.u16();
    const count = c.u32();
    const attributes: JobAttribute[] = [];
    for (let k = 0; k < count; k++) {
      const t = c.u16();
      const attrName = c.str();
      const type = ATTRIBUTE_TYPES[t] ?? `Unknown${t}`;
      if (t === 0) {
        const v = c.f64();
        attributes.push({ name: attrName, type, value: v === undefined ? '' : num(v) });
      } else if (t === 2) {
        const itemIndex = c.u16();
        attributes.push({ name: attrName, type, value: c.str(), itemIndex });
      } else {
        attributes.push({ name: attrName, type, value: c.str() });
      }
    }
    out.push({ name, attributes });
  }
  return out;
}

export function decodePoint(payload: Uint8Array): JobPointRecord {
  const c = new Cursor(payload);
  // The record opens with the point's note text (empty for most points).
  const note = c.str();
  const features = readFeatures(c);
  const description1 = c.str();
  // Seven bytes sit between the first description and the name. They are all
  // zero in every sample so far; the first is taken to be an empty second
  // description, since a string would fit there.
  const description2 = c.str();
  c.o += 6;
  const name = c.str();
  const source = c.chars(2);
  const method = c.u16();
  const survey = c.u16();
  const cls = c.u16();
  c.u8();
  const sourceFile = c.remaining > 0 ? c.str() : '';
  return {
    name,
    note,
    features,
    description1,
    description2,
    source,
    method: enumName(METHODS, method),
    surveyMethod: enumName(SURVEY_METHODS, survey),
    classification: enumName(CLASSIFICATIONS, cls),
    sourceFile,
  };
}

interface Vector {
  dx: number;
  dy: number;
  dz: number;
  reference: number;
  antenna: number;
  /** Yaw, pitch and roll in radians, when the receiver's IMU measured tilt. */
  attitude?: { yaw: number; pitch: number; roll: number; sdYaw?: number; sdPitch?: number; sdRoll?: number };
}

function decodeVector(payload: Uint8Array): Vector {
  const c = new Cursor(payload, 1);
  const v: Vector = { dx: c.f64Raw(), dy: c.f64Raw(), dz: c.f64Raw(), reference: c.u32(), antenna: c.u32() };
  if (c.remaining >= 49 && c.u8() === 3) {
    v.attitude = { yaw: c.f64Raw(), pitch: c.f64Raw(), roll: c.f64Raw(), sdYaw: c.f64(), sdPitch: c.f64(), sdRoll: c.f64() };
  }
  return v;
}

interface Equipment {
  receiverType: string;
  receiverSerial: string;
  firmware?: number;
  antennaType: string;
  measurementMethod: string;
  antennaNumber: number;
  antennaMethod: number;
  tapeAdjustment?: number;
  horizontalOffset?: number;
  verticalOffset?: number;
}

function decodeEquipment(payload: Uint8Array): Equipment {
  const c = new Cursor(payload, 1);
  const receiverType = c.str();
  c.str();
  const receiverSerial = c.str();
  const firmware = c.f64();
  const antennaType = c.str();
  c.str();
  const measurementMethod = c.str();
  c.str();
  const antennaNumber = c.u16();
  const antennaMethod = c.u8();
  c.u8();
  return {
    receiverType,
    receiverSerial,
    firmware,
    antennaType,
    measurementMethod,
    antennaNumber,
    antennaMethod,
    tapeAdjustment: c.f64(),
    horizontalOffset: c.f64(),
    verticalOffset: c.f64(),
  };
}

const ANTENNA_MEASUREMENTS: Record<number, string> = { 0: 'Corrected', 3: 'Raw' };

function decodeAntenna(payload: Uint8Array) {
  const c = new Cursor(payload, 1);
  const measuredHeight = c.f64();
  const type = c.u8();
  c.u8();
  return { measuredHeight, measurementType: ANTENNA_MEASUREMENTS[type], equipment: c.u32() };
}

// ---------------------------------------------------------------- geodesy

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = 180 / Math.PI;

type Vec3 = [number, number, number];

function geodeticToEcef(lat: number, lon: number, h: number): Vec3 {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + h) * Math.sin(lat)];
}

function ecefToGeodetic([x, y, z]: Vec3, a = A, e2 = E2): Vec3 {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return [lat, lon, h];
}

/** Local east/north/up offset → ECEF offset at lat/lon (radians). */
function enuToEcef(lat: number, lon: number, e: number, n: number, u: number): Vec3 {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return [-so * e - sl * co * n + cl * co * u, co * e - sl * so * n + cl * so * u, cl * n + sl * u];
}

function offset(pos: Vec3, d: Vec3): Vec3 {
  const x = geodeticToEcef(...pos);
  return ecefToGeodetic([x[0] + d[0], x[1] + d[1], x[2] + d[2]]);
}

/**
 * Ground point under a GNSS antenna. `height` is from the ground mark to the
 * antenna phase centre, along the pole. With IMU tilt the pole leans by pitch
 * (about the device's right axis) and roll (about its forward axis), and the
 * device faces `yaw`. These sign conventions reproduce Trimble Access's
 * reductions to well under a millimetre.
 */
export function groundUnderAntenna(apc: Vec3, height: number, attitude?: Vector['attitude']): Vec3 {
  let e = 0;
  let n = 0;
  let u = height;
  if (attitude) {
    const p = -attitude.pitch;
    const r = attitude.roll;
    const az = -attitude.yaw;
    const fwd = height * Math.sin(p) * Math.cos(r);
    const right = height * Math.sin(r);
    u = height * Math.cos(p) * Math.cos(r);
    e = fwd * Math.sin(az) + right * Math.cos(az);
    n = fwd * Math.cos(az) - right * Math.sin(az);
  }
  const d = enuToEcef(apc[0], apc[1], -e, -n, -u);
  return offset(apc, d);
}

// ---------------------------------------------------------------- the journal

/** Current state of every record after replaying edits and deletes. */
class Journal {
  byId = new Map<number, JobRecord>();
  children = new Map<number, JobRecord[]>();
  position = new Map<JobRecord, number>();
  constructor(public file: JobFile) {
    file.records.forEach((r, i) => this.position.set(r, i));
    for (const r of file.records) {
      if (r.kind === KIND_NEW) this.byId.set(r.id, r);
      else if (r.kind === KIND_REPLACE) this.byId.set(r.parent, r);
      else if (r.kind === KIND_CHILD || r.kind === KIND_CHILD_REPLACE) {
        const list = this.children.get(r.parent) ?? [];
        list.push(r);
        this.children.set(r.parent, list);
      }
    }
  }
  /** Top-level records in file order, each in its latest version. */
  *topLevel(): Generator<JobRecord> {
    for (const r of this.file.records) {
      if (r.kind !== KIND_NEW) continue;
      const latest = this.byId.get(r.id) ?? r;
      if (latest === r) yield r;
      else {
        // A replacement keeps the record's place, ID and time, as in JobXML.
        const current = { ...latest, id: r.id, time: r.time };
        this.position.set(current, this.position.get(r)!);
        yield current;
      }
    }
  }
  latestChild(id: number, type: number): JobRecord | undefined {
    const list = this.children.get(id);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].type === type) return list[i];
    return undefined;
  }
  childrenOf(id: number, type: number): JobRecord[] {
    return (this.children.get(id) ?? []).filter((r) => r.type === type);
  }
}

// ---------------------------------------------------------------- JobXML output

class Xml {
  out: string[] = [];
  private depth = 1;
  open(tag: string, attrs: Record<string, string> = {}) {
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join('');
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${a}>`);
    this.depth++;
  }
  close(tag: string) {
    this.depth--;
    this.out.push(`${'  '.repeat(this.depth)}</${tag}>`);
  }
  el(tag: string, value: string | number | undefined, attrs: Record<string, string> = {}) {
    if (value === undefined) return;
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join('');
    const text = typeof value === 'number' ? num(value) : esc(value);
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${a}>${text}</${tag}>`);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(14)));
}

function hexId(id: number): string {
  return id.toString(16).padStart(8, '0');
}

const deg = (rad: number) => rad * DEG;
const degOrUndefined = (rad: number | undefined) => (rad === undefined ? undefined : rad * DEG);
/** EPSG codes and IDs are -1 when there isn't one. */
const code = (v: number) => (v < 0 ? undefined : v);

const PROJECTION_TYPES: Record<number, string> = { 1: 'ScaleOnly', 7: 'Lambert2Parallel' };
const HORIZONTAL_TYPES: Record<number, string> = { 0: 'NoAdjustment', 1: 'PlaneAdjustment' };
// 4 and 5 both come out of Trimble Access as GeoidModelAndInclinedPlane. In the
// samples 4 is a calibration computed on the controller and 5 one that was
// carried into a new job; the numbers in them are laid out the same.
const VERTICAL_TYPES: Record<number, string> = {
  0: 'NoAdjustment',
  3: 'GeoidModel',
  4: 'GeoidModelAndInclinedPlane',
  5: 'GeoidModelAndInclinedPlane',
};
const DISTANCES: Record<number, string> = { 0: 'GridDistance', 2: 'GroundDistance' };
const DIMENSIONS: Record<number, string> = { 1: '1D', 2: '2D', 3: '3D' };

// Units are numbered in one list across every kind of unit. Only the ones
// seen in a job with a matching JobXML are named.
const UNITS: Record<number, string> = {
  0: 'Metres',
  6: 'USSurveyFeet',
  14: 'DMSDegrees',
  29: 'Celsius',
  30: 'Fahrenheit',
  31: 'MilliBar',
  32: 'InchHg',
  37: 'SquareMetres',
  40: 'SquareUSSurveyFeet',
  50: 'CubicMetres',
  54: 'CubicUSSurveyYards',
  59: 'Kilograms',
  65: 'Pounds',
};
const PRECISION_UNITS: Record<number, string> = { 0: '1Sigma', 1: '95Percent', 3: 'DRMS' };
const SURVEY_EVENTS: Record<number, string> = { 1: 'StartRoverSurvey', 3: 'EndSurvey' };
const INITIALISATION_EVENTS: Record<number, string> = { 7: 'RTKInitialised', 8: 'RTKNotInitialised' };
const INITIALISATION_TYPES: Record<number, string> = { 3: 'OnTheFly', 4: 'ResetRTK' };

/** Record types that make up the coordinate system; read first, since points need it. */
const SYSTEM_TYPES = new Set<number>([
  RecordType.Units,
  RecordType.Corrections,
  RecordType.Ellipsoid,
  RecordType.Projection,
  RecordType.Datum,
  RecordType.HorizontalAdjustment,
  RecordType.VerticalAdjustment,
  RecordType.CoordinateSystem,
  RecordType.KinematicTransformations,
]);

/** What the coordinate system records say that the rest of the translation needs. */
interface SystemInfo {
  projectHeight?: number;
  systemName?: string;
  zoneName?: string;
  datumName?: string;
  /** File name of the geoid model, without its extension: g18us. */
  geoidFile?: string;
  distanceUnits?: string;
  heightUnits?: string;
}

/** Write one coordinate system record as JobXML. `geoidName` is the model's own name, when its file is at hand. */
function writeSystemRecord(x: Xml, r: JobRecord, info: SystemInfo, geoidName?: string) {
  const c = new Cursor(r.payload);
  const attrs = { ID: hexId(r.id), TimeStamp: r.time };
  switch (r.type) {
    case RecordType.Units: {
      const u = Array.from({ length: 12 }, (_, i) => (3 + 2 * i <= r.payload.length ? c.at(1 + 2 * i).u16() : -1));
      info.distanceUnits = UNITS[u[0]];
      info.heightUnits = UNITS[u[1]];
      x.open('UnitsRecord', attrs);
      x.el('DistanceUnits', UNITS[u[0]]);
      x.el('HeightUnits', UNITS[u[1]]);
      x.el('AngleUnits', UNITS[u[2]]);
      x.el('LatitudeLongitudeUnits', UNITS[u[3]]);
      x.el('TemperatureUnits', UNITS[u[6]]);
      x.el('PressureUnits', UNITS[u[7]]);
      x.el('AreaUnits', UNITS[u[9]]);
      x.el('VolumeUnits', UNITS[u[10]]);
      if (r.payload.length >= 54) {
        x.el('PrecisionUnits', PRECISION_UNITS[c.at(50).u16()]);
        x.el('MassUnits', UNITS[c.u16()]);
      }
      x.close('UnitsRecord');
      break;
    }
    case RecordType.Corrections: {
      x.open('CorrectionsRecord', attrs);
      const d = c.at(16).u8();
      x.el('Distances', DISTANCES[d] ?? `Unknown${d}`);
      x.close('CorrectionsRecord');
      break;
    }
    case RecordType.Ellipsoid: {
      x.open('EllipsoidRecord', attrs);
      c.at(3);
      x.el('EarthRadius', c.f64());
      x.el('Flattening', c.f64());
      c.u32();
      x.el('LocalEllipsoidEPSG', code(c.i32()));
      x.close('EllipsoidRecord');
      break;
    }
    case RecordType.Projection: {
      const type = c.at(3).u16();
      x.open('ProjectionRecord', attrs);
      x.open('Projection');
      x.el('Type', PROJECTION_TYPES[type] ?? `Unknown${type}`);
      // Angles are stored in radians.
      x.el('CentralLatitude', degOrUndefined(c.at(5).f64()));
      x.el('CentralLongitude', degOrUndefined(c.at(13).f64()));
      x.el('Scale', c.at(21).f64());
      x.el('FalseNorthing', c.at(29).f64());
      x.el('FalseEasting', c.at(37).f64());
      x.el('Parallel1', degOrUndefined(c.at(63).f64()));
      x.el('Parallel2', degOrUndefined(c.at(71).f64()));
      x.close('Projection');
      x.open('LocalSite');
      x.el('Type', 'Grid');
      // Older versions have two fewer bytes in the middle, so count from the end.
      info.projectHeight = c.at(r.payload.length - 41).f64();
      x.el('ProjectLocationHeight', info.projectHeight);
      x.close('LocalSite');
      x.close('ProjectionRecord');
      break;
    }
    case RecordType.Datum: {
      x.open('DatumRecord', attrs);
      x.el('ReferenceGlobalFrameID', code(c.at(62).i32()));
      x.el('ReferenceGlobalFrameEPSG', code(c.i32()));
      x.el('ReferenceGlobalFrameEpoch', c.at(74).f64()?.toFixed(2));
      x.el('ReferenceGlobalFrameName', c.at(82).str() || undefined);
      x.el('DisplacementModelName', c.str() || undefined);
      x.close('DatumRecord');
      break;
    }
    case RecordType.HorizontalAdjustment: {
      const type = c.at(3).u16();
      x.open('HorizontalAdjustmentRecord', attrs);
      x.el('Type', HORIZONTAL_TYPES[type] ?? `Unknown${type}`);
      x.el('OriginNorth', c.f64());
      x.el('OriginEast', c.f64());
      x.el('TranslationNorth', c.f64());
      x.el('TranslationEast', c.f64());
      x.el('Rotation', degOrUndefined(c.f64()));
      x.el('ScaleFactor', c.f64());
      x.close('HorizontalAdjustmentRecord');
      break;
    }
    case RecordType.VerticalAdjustment: {
      const type = c.at(3).u16();
      x.open('VerticalAdjustmentRecord', attrs);
      x.el('Type', VERTICAL_TYPES[type] ?? `Unknown${type}`);
      x.el('OriginNorth', c.f64());
      x.el('OriginEast', c.f64());
      x.el('SlopeNorthPerUnit', c.f64());
      x.el('SlopeEastPerUnit', c.f64());
      x.el('ConstantAdjustment', c.f64());
      // The job names the model's file; its proper name is in the file itself.
      const file = c.str();
      if (file) info.geoidFile = file;
      x.el('GeoidName', file ? (geoidName ?? file) : undefined);
      x.el('GeoidFile', file || undefined);
      x.close('VerticalAdjustmentRecord');
      break;
    }
    case RecordType.CoordinateSystem: {
      x.open('CoordinateSystemRecord', attrs);
      c.at(1);
      info.systemName = c.str();
      info.zoneName = c.str();
      info.datumName = c.str();
      x.el('SystemName', info.systemName);
      x.el('ZoneName', info.zoneName);
      x.el('DatumName', info.datumName);
      if (r.payload.length - c.o >= 12) {
        c.at(r.payload.length - 12);
        x.el('ZoneID', code(c.i32()));
        x.el('ProjectedCoordinateReferenceSystemEPSG', code(c.i32()));
        x.el('CompoundCoordinateReferenceSystemEPSG', code(c.i32()));
      }
      x.close('CoordinateSystemRecord');
      break;
    }
    case RecordType.KinematicTransformations:
      writeKinematic(x, c, attrs);
      break;
  }
}

/** Options for reading a JOB file. */
export interface JobOptions {
  /** Name to give the job, instead of the one stored in it. */
  jobName?: string;
  /**
   * The geoid model the job names (see `jobGeoidFile`). A JOB stores ellipsoid
   * heights only, so without it measured points have no elevation.
   */
  geoid?: GeoidGrid;
}

/** The geoid model file a job's elevations need, without its extension: "g18us". */
export function jobGeoidFile(bytes: Uint8Array): string | undefined {
  const j = new Journal(readJob(bytes));
  const info: SystemInfo = {};
  for (const r of j.topLevel()) if (r.type === RecordType.VerticalAdjustment) writeSystemRecord(new Xml(), r, info);
  return info.geoidFile;
}

interface PointState {
  record: JobRecord;
  point: JobPointRecord;
  deleted: boolean;
  wgs84?: Vec3;
  grid?: { north: number; east: number; elevation?: number };
}

/** What a point needs from the rest of the job. */
interface Context {
  j: Journal;
  jobName: string;
  /** Ground positions of the points read so far, by name. */
  positions: Map<string, Vec3>;
  /** The point each of those positions belongs to. */
  held: Map<string, JobPointRecord>;
  references: Map<number, { name: string; antenna: number }>;
  /** Grid position of a WGS84 position, once the job has a projection. */
  toGrid?: (p: Vec3) => { north: number; east: number; elevation?: number };
}

/** Translate a JOB file into JobXML text. */
export function jobToJxl(bytes: Uint8Array, opts: JobOptions | string = {}): string {
  const options = typeof opts === 'string' ? { jobName: opts } : opts;
  const file = readJob(bytes);
  const j = new Journal(file);
  const header = file.records.find((r) => r.type === RecordType.Header);
  // The header names the job it was created as (often a template it was
  // copied from); a rename or copy adds a child of record 0 with the new name.
  const h = header ? new Cursor((j.byId.get(header.id) ?? header).payload, 1) : undefined;
  const created = h ? { name: h.str(), serial: (h.str(), h.str()), version: h.str() } : undefined;
  const renamed = j.latestChild(0, RecordType.JobName);
  const name = options.jobName || (renamed ? new Cursor(renamed.payload, 2).str() : (created?.name ?? ''));

  const [major, minor, build] = file.version.split('.');
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<JOBFile jobName="${esc(name)}" product="Trimble Access" productVersion="${major}.${minor.padStart(2, '0')}"` +
      ` productDBVersion="${major}${minor.padStart(2, '0')}-${build}"` +
      ` controllerSerialNumber="${esc(created?.serial ?? '')}" originalProductVersion="${esc(created?.version ?? '')}"` +
      ` sourceFormat="JOB" TimeStamp="${header?.time ?? ''}">`,
    '  <FieldBook>',
  ];

  // Trimble Access works out grid coordinates, elevations and the combined
  // scale factor when it exports; the JOB only has the coordinate system. So
  // that is read first, the same way a JobXML file's is, and points are
  // reduced with it. The latest records are the ones in force.
  const info: SystemInfo = {};
  const system = new Xml();
  for (const r of j.topLevel()) if (SYSTEM_TYPES.has(r.type)) writeSystemRecord(system, r, info);
  const systemDoc = new DOMParser().parseFromString([...head, ...system.out, '  </FieldBook>', '</JOBFile>'].join('\n'), 'application/xml');
  const crs = detectCrs(systemDoc.documentElement);
  const project = crs.projection ? proj4('EPSG:4326', crs.projection.proj4) : undefined;
  const verticalRecord = Array.from(systemDoc.getElementsByTagName('VerticalAdjustmentRecord')).at(-1);
  const vertical = verticalRecord && verticalAdjustment(verticalRecord);
  // Latitudes and heights are on the job's own ellipsoid. For NAD83 that is
  // GRS80, a tenth of a millimetre flatter than WGS84: enough to show in a
  // northing and an elevation.
  const ellipsoid = Array.from(systemDoc.getElementsByTagName('EllipsoidRecord'))
    .map((e) => ({ a: Number(e.getElementsByTagName('EarthRadius')[0]?.textContent), f: Number(e.getElementsByTagName('Flattening')[0]?.textContent) }))
    .filter((e) => e.a > 0 && e.f > 0)
    .at(-1);
  const local = (p: Vec3) => (ellipsoid ? ecefToGeodetic(geodeticToEcef(...p), ellipsoid.a, ellipsoid.f * (2 - ellipsoid.f)) : p);
  const toGrid = project
    ? (p: Vec3) => {
        const on = local(p);
        const [e, n] = project.forward([deg(on[1]), deg(on[0])]);
        const [north, east] = crs.adjustment ? applyPlaneAdjustment(crs.adjustment, n, e) : [n, e];
        return { north, east, elevation: elevationOf(p, on[2], north, east, vertical, options.geoid) };
      }
    : undefined;

  const x = new Xml();
  const ctx: Context = { j, jobName: name, positions: new Map(), held: new Map(), references: new Map(), toGrid };
  const points: PointState[] = [];
  for (const r of j.topLevel()) {
    const c = new Cursor(r.payload);
    const attrs = { ID: hexId(r.id), TimeStamp: r.time };
    if (SYSTEM_TYPES.has(r.type)) {
      writeSystemRecord(x, r, info, options.geoid?.name);
      continue;
    }
    switch (r.type) {
      case RecordType.FeatureCoding: {
        c.at(1);
        const library = c.str();
        c.str();
        x.open('FeatureCodingRecord', attrs);
        x.el('LibraryName', library);
        x.el('SourceFilename', c.str());
        x.el('AttributesStored', String(!!library));
        x.close('FeatureCodingRecord');
        break;
      }
      case RecordType.SurveyEvent: {
        const event = c.at(1).u8();
        x.open('SurveyEventRecord', attrs);
        x.el('Event', SURVEY_EVENTS[event] ?? `Unknown${event}`);
        x.close('SurveyEventRecord');
        break;
      }
      case RecordType.Initialisation: {
        const event = c.at(1).u8();
        x.open('InitialisationRecord', attrs);
        x.el('InitialisationEvent', INITIALISATION_EVENTS[event] ?? `Unknown${event}`);
        x.open('Time');
        x.el('GPSWeek', c.at(3).u16());
        x.el('Seconds', c.f64());
        x.close('Time');
        const type = c.at(13).u8();
        x.el('InitialisationType', INITIALISATION_TYPES[type] ?? `Unknown${type}`);
        x.close('InitialisationRecord');
        break;
      }
      case RecordType.ActiveMapFiles: {
        // Only ever one file in the samples, so a second one's layout is unknown.
        const mapFile = r.payload.length > 2 ? c.at(1).str() : '';
        x.open('ActiveMapFilesRecord', attrs);
        x.el('File', mapFile || undefined);
        x.close('ActiveMapFilesRecord');
        break;
      }
      case RecordType.TimeZone: {
        x.open('TimeZoneRecord', attrs);
        x.el('ZoneName', c.at(1).str());
        x.el('HoursToUTC', c.f64());
        x.close('TimeZoneRecord');
        break;
      }
      case RecordType.NtripDataSource: {
        x.open('NTRIPDataSourceRecord', attrs);
        x.el('MountPoint', c.at(1).str());
        x.el('DataFormat', c.str());
        x.el('Solution', c.str());
        x.el('IPAddress', c.str());
        x.el('IPPort', c.u16());
        x.close('NTRIPDataSourceRecord');
        break;
      }
      case RecordType.CalibrationPoint: {
        x.open('CalibrationPointRecord', attrs);
        x.el('GridPointName', c.at(1).str());
        x.el('WGS84PointName', c.str());
        const dimension = c.u8();
        x.el('Dimension', DIMENSIONS[dimension] ?? `Unknown${dimension}`);
        c.u8();
        // Residuals are empty until the calibration has been computed.
        const v = c.f64();
        x.el('HorizontalResidual', c.f64());
        x.el('VerticalResidual', v);
        x.el('Residual3D', c.f64());
        c.o += 24; // the control point's north, east and elevation
        const [dn, de, du] = [c.f64(), c.f64(), c.f64()];
        if (dn !== undefined && de !== undefined) {
          x.open('GridResidual');
          x.el('DeltaNorth', dn);
          x.el('DeltaEast', de);
          x.el('DeltaElevation', du);
          x.close('GridResidual');
        }
        x.close('CalibrationPointRecord');
        break;
      }
      case RecordType.GpsEquipment: {
        const e = decodeEquipment(r.payload);
        x.open('GPSEquipmentRecord', attrs);
        x.el('ReceiverType', e.receiverType);
        x.el('ReceiverSerialNumber', e.receiverSerial);
        x.el('ReceiverFirmwareVersion', e.firmware);
        x.el('AntennaType', e.antennaType);
        x.el('AntennaNumber', e.antennaNumber);
        x.el('AntennaMeasurementMethod', e.measurementMethod);
        x.el('AntennaMethod', e.antennaMethod);
        x.el('AntennaTapeAdjustment', e.tapeAdjustment);
        x.el('AntennaHorizontalOffset', e.horizontalOffset);
        x.el('AntennaVerticalOffset', e.verticalOffset);
        x.close('GPSEquipmentRecord');
        break;
      }
      case RecordType.Antenna: {
        const a = decodeAntenna(r.payload);
        const e = j.byId.get(a.equipment);
        const offsetUp = e ? (decodeEquipment(e.payload).verticalOffset ?? 0) : 0;
        x.open('AntennaRecord', attrs);
        x.el('MeasuredHeight', a.measuredHeight);
        x.el('MeasurementType', a.measurementType);
        x.el('GPSEquipmentID', hexId(a.equipment));
        if (a.measuredHeight !== undefined) x.el('ReducedHeight', a.measuredHeight + offsetUp);
        x.close('AntennaRecord');
        break;
      }
      case RecordType.Reference: {
        const base = c.at(1).str();
        const antenna = c.u32();
        ctx.references.set(r.id, { name: base, antenna });
        x.open('ReferenceRecord', attrs);
        x.el('PointName', base);
        x.el('AntennaID', hexId(antenna));
        x.close('ReferenceRecord');
        break;
      }
      case RecordType.Note: {
        x.open('NoteRecord', attrs);
        x.open('Notes');
        x.el('Note', noteText(r.payload));
        x.close('Notes');
        x.close('NoteRecord');
        break;
      }
      case RecordType.Point:
        points.push(writePoint(x, ctx, r));
        break;
    }
  }
  x.close('FieldBook');

  // One point per name, chosen the way Trimble Access searches its database.
  const reduced = new Map<string, PointState>();
  for (const p of points) {
    if (p.deleted) continue;
    const held = reduced.get(p.point.name);
    if (!held || supersedes(p.point, held.point)) reduced.set(p.point.name, p);
  }
  x.open('Reductions');
  for (const p of points) {
    if (reduced.get(p.point.name) !== p) continue;
    x.open('Point');
    x.el('ID', hexId(p.record.id));
    x.el('Name', p.point.name);
    x.el('Code', codeOf(p.point.features));
    x.el('SurveyMethod', p.point.surveyMethod);
    x.el('Classification', p.point.classification);
    writeWgs84(x, p.wgs84);
    writeGrid(x, 'Grid', p.grid);
    x.close('Point');
  }
  x.close('Reductions');

  x.open('Environment');
  x.open('CoordinateSystem');
  x.el('SystemName', info.systemName);
  x.el('ZoneName', info.zoneName);
  x.el('DatumName', info.datumName);
  // Trimble Access gives the combined scale factor at the middle of the job:
  // the mean of its points' grid coordinates, at the project height.
  const onGrid = [...reduced.values()].filter((p) => p.grid).map((p) => p.grid!);
  if (project && onGrid.length && info.projectHeight !== undefined) {
    const north = onGrid.reduce((s, g) => s + g.north, 0) / onGrid.length;
    const east = onGrid.reduce((s, g) => s + g.east, 0) / onGrid.length;
    const [n, e] = crs.adjustment ? removePlaneAdjustment(crs.adjustment, north, east) : [north, east];
    const [lon, lat] = project.inverse([e, n]);
    x.open('CombinedScaleFactor');
    x.open('Location');
    x.el('Latitude', lat);
    x.el('Longitude', lon);
    x.el('Height', info.projectHeight);
    x.close('Location');
    x.el('Scale', combinedScaleFactor(project, lat / DEG, lon / DEG, info.projectHeight));
    x.close('CombinedScaleFactor');
  }
  x.close('CoordinateSystem');
  if (info.distanceUnits || info.heightUnits) {
    x.open('DisplaySettings');
    x.el('DistanceUnits', info.distanceUnits);
    x.el('HeightUnits', info.heightUnits);
    x.close('DisplaySettings');
  }
  x.close('Environment');

  return [...head, ...x.out, '</JOBFile>', ''].join('\n');
}

// Trimble Access's search rules: of several points with one name, the
// highest class is the point. Within a class the oldest stands, except that
// a newer control point replaces an older one. Only Averaged over Normal and
// Normal over Check are borne out by the samples; the rest follows Trimble's
// documentation.
const CLASS_RANK = ['Control', 'Averaged', 'Adjusted', 'Normal', 'Construction', 'Check'];

function supersedes(candidate: JobPointRecord, held: JobPointRecord): boolean {
  const rank = (p: JobPointRecord) => {
    const i = CLASS_RANK.indexOf(p.classification);
    return i < 0 ? CLASS_RANK.length : i;
  };
  return rank(candidate) < rank(held) || (rank(candidate) === rank(held) && candidate.classification === 'Control');
}

/**
 * Elevation of a WGS84 position under the job's vertical adjustment: the
 * ellipsoid height less the geoid height, plus the calibration's inclined
 * plane where there is one. Undefined without the geoid model.
 */
function elevationOf(
  p: Vec3,
  height: number,
  north: number,
  east: number,
  v: VerticalAdjustment | undefined,
  geoid: GeoidGrid | undefined,
): number | undefined {
  if (!v || !geoid || !v.type.includes('Geoid')) return undefined;
  const n = undulation(geoid, deg(p[0]), deg(p[1]));
  if (n === undefined) return undefined;
  let elevation = height - n;
  if (v.type.includes('InclinedPlane')) {
    // Only the constant is checked against JobXML: every sample's slopes are zero.
    elevation += v.constant + v.slopeNorth * (north - (v.originNorth ?? north)) + v.slopeEast * (east - (v.originEast ?? east));
  }
  return elevation;
}

function writeKinematic(x: Xml, c: Cursor, attrs: Record<string, string>) {
  c.at(1);
  const n = c.u32();
  x.open('KinematicTransformationsRecord', attrs);
  for (let i = 0; i < n; i++) {
    const systemId = c.u32();
    const type = c.u32();
    const name = c.str();
    const source = c.str();
    const target = c.str();
    const epoch = c.f64();
    c.o += 16;
    const v = Array.from({ length: 14 }, () => c.f64Raw());
    c.o += 2;
    x.open('KinematicTransformation');
    x.el('Name', name);
    x.el('SystemID', systemId);
    x.el('SourceRealization', source);
    x.el('TargetRealization', target);
    x.el('ReferenceEpoch', epoch?.toFixed(2));
    x.el('Type', type === 1 ? 'FourteenParameters' : `Unknown${type}`);
    const tags = [
      'RotationX', 'RotationY', 'RotationZ', 'TranslationX', 'TranslationY', 'TranslationZ', 'Scale',
      'DerivativeRotationX', 'DerivativeRotationY', 'DerivativeRotationZ',
      'DerivativeTranslationX', 'DerivativeTranslationY', 'DerivativeTranslationZ', 'DerivativeScale',
    ];
    tags.forEach((t, k) => x.el(t, v[k]));
    x.close('KinematicTransformation');
  }
  x.close('KinematicTransformationsRecord');
}

function noteText(payload: Uint8Array): string {
  return new TextDecoder().decode(payload).replace(/\0+$/, '').trim();
}

function noteLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function codeOf(features: JobFeature[]): string {
  return features.map((f) => f.name).join(' ');
}

function writeWgs84(x: Xml, p: Vec3 | undefined) {
  if (!p) return;
  x.open('WGS84');
  x.el('Latitude', deg(p[0]));
  x.el('Longitude', deg(p[1]));
  x.el('Height', p[2]);
  x.close('WGS84');
}

function writeGrid(x: Xml, tag: string, g: PointState['grid']) {
  if (!g) return;
  x.open(tag);
  x.el('North', g.north);
  x.el('East', g.east);
  x.el('Elevation', g.elevation);
  x.close(tag);
}

function writePoint(x: Xml, ctx: Context, r: JobRecord): PointState {
  const { j, positions, references } = ctx;
  const point = decodePoint(r.payload);
  // A rename, and a later attribute edit, each carry the new value whole.
  const renamed = j.latestChild(r.id, RecordType.JobName);
  if (renamed) point.name = new Cursor(renamed.payload, 2).str();
  const edited = j.latestChild(r.id, RecordType.Features);
  if (edited) point.features = readFeatures(new Cursor(edited.payload, 1));
  const del = j.latestChild(r.id, RecordType.Deleted);
  const deleted = !!del && del.payload[1] === 0;
  const state: PointState = { record: r, point, deleted };

  x.open('PointRecord', { ID: hexId(r.id), TimeStamp: r.time });
  x.el('Name', point.name);
  x.el('Code', codeOf(point.features));
  if (point.description1 || point.description2) {
    x.el('Description1', point.description1, { Name: '' });
    x.el('Description2', point.description2, { Name: '' });
  }
  x.el('Method', point.method);
  x.el('SurveyMethod', point.surveyMethod);
  x.el('Classification', point.classification);
  x.el('Deleted', String(deleted));
  x.el('Source', point.sourceFile || undefined);
  // Like JobXML, only codes that carry feature attributes are listed as
  // features. Plain codes and control codes (BL, EL...) are only in the code.
  const withAttributes = point.features.filter((f) => f.attributes.length);
  if (withAttributes.length) {
    x.open('Features');
    for (const f of withAttributes) {
      x.open('Feature', { Name: f.name });
      for (const a of f.attributes) {
        x.open('Attribute');
        x.el('Name', a.name);
        // Photos live in the job's "<job> Files" folder, which JobXML spells out.
        x.el('Value', a.type === 'Photo' && a.value ? `${ctx.jobName} Files/${a.value}` : a.value);
        x.el('Type', a.type);
        x.el('ItemIndex', a.itemIndex);
        x.close('Attribute');
      }
      x.close('Feature');
    }
    x.close('Features');
  }

  const wgs = j.latestChild(r.id, RecordType.Wgs84Position);
  const grid = j.latestChild(r.id, RecordType.GridPosition);
  const vector = j.latestChild(r.id, RecordType.GnssVectorTilted) ?? j.latestChild(r.id, RecordType.GnssVector);
  const polar = j.latestChild(r.id, RecordType.Polar);
  // A measured point's position is worked out here, not stored.
  let measured = false;

  if (wgs) {
    const c = new Cursor(wgs.payload, 1);
    state.wgs84 = [c.f64Raw(), c.f64Raw(), c.f64Raw()];
    writeWgs84(x, state.wgs84);
  }
  if (grid) {
    const c = new Cursor(grid.payload, 1);
    state.grid = { north: c.f64Raw(), east: c.f64Raw(), elevation: c.f64() };
    writeGrid(x, 'Grid', state.grid);
  }
  if (vector) {
    const v = decodeVector(vector.payload);
    const reference = references.get(v.reference);
    const baseName = reference?.name ?? '';
    x.open('ECEFDeltas');
    x.el('DeltaX', v.dx);
    x.el('DeltaY', v.dy);
    x.el('DeltaZ', v.dz);
    x.close('ECEFDeltas');
    x.el('ReferenceRecordID', hexId(v.reference));
    x.el('RTK_Base', baseName);
    x.el('AntennaID', hexId(v.antenna));
    // An electronic bubble's tilt is noted with the shot but, unlike IMU
    // tilt, isn't used to move the point.
    const bubble = nextOfType(j, r, RecordType.BubbleTilt);
    if (v.attitude || bubble) {
      const b = bubble && new Cursor(bubble.payload, 2);
      x.open('DeviceAxisOrientation');
      x.el('Type', v.attitude ? 'InertialTiltComp' : 'VerticalTiltError');
      x.open('Attitude');
      x.el('Pitch', deg(v.attitude ? v.attitude.pitch : b!.f64Raw()));
      x.el('Roll', deg(v.attitude ? v.attitude.roll : b!.f64Raw()));
      if (v.attitude) x.el('Yaw', deg(v.attitude.yaw));
      x.close('Attitude');
      x.close('DeviceAxisOrientation');
    }
    // The vector runs between the two antennas' phase centres.
    const mark = positions.get(baseName);
    const height = antennaHeight(j, v.antenna);
    if (mark && height !== undefined) {
      const baseHeight = (reference && antennaHeight(j, reference.antenna)) ?? 0;
      const base = offset(mark, enuToEcef(mark[0], mark[1], 0, 0, baseHeight));
      const apc = offset(base, [v.dx, v.dy, v.dz]);
      state.wgs84 = groundUnderAntenna(apc, height, v.attitude);
      measured = true;
    }
  }
  if (polar) {
    const c = new Cursor(polar.payload, 1);
    const source = c.str();
    const azimuth = c.f64Raw();
    const hd = c.f64Raw();
    const vd = c.f64() ?? 0;
    const azimuthType = c.u8();
    const distanceType = c.u8();
    x.el('SourcePoint', source);
    x.open('Polar');
    x.el('Azimuth', deg(azimuth));
    x.el('HorizontalDistance', hd);
    x.el('VerticalDistance', vd);
    x.close('Polar');
    x.el('AzimuthType', azimuthType === 0x49 ? 'WGS84' : `Unknown${azimuthType}`);
    x.el('DistanceType', distanceType === 4 ? 'Ground' : `Unknown${distanceType}`);
    const from = positions.get(source);
    if (from) {
      state.wgs84 = offset(from, enuToEcef(from[0], from[1], hd * Math.sin(azimuth), hd * Math.cos(azimuth), vd));
      measured = true;
    }
  }
  // Grid coordinates of anything that only has a WGS84 position. JobXML
  // calls them computed, to tell them from keyed-in ones.
  if (!state.grid && state.wgs84 && ctx.toGrid) {
    state.grid = ctx.toGrid(state.wgs84);
    if (measured || wgs) writeGrid(x, 'ComputedGrid', state.grid);
  }

  const sd = nextOfType(j, r, RecordType.GridStandardDeviations);
  if (sd) {
    const c = new Cursor(sd.payload, 1);
    x.open('GridStandardDeviations');
    x.el('NorthStandardDeviation', c.f64());
    x.el('EastStandardDeviation', c.f64());
    x.el('ElevationStandardDeviation', c.f64());
    x.close('GridStandardDeviations');
  }
  const residuals = nextOfType(j, r, RecordType.AverageResiduals);
  if (residuals) writeAverageResiduals(x, residuals.payload);
  const precision = nextOfType(j, r, RecordType.Precision);
  if (precision) {
    const c = new Cursor(precision.payload, 1);
    x.open('Precision');
    x.el('Horizontal', c.f64());
    x.el('Vertical', c.f64());
    x.close('Precision');
  }
  const qc = nextOfType(j, r, RecordType.QualityControl1);
  if (qc) writeQc1(x, new Cursor(qc.payload));
  const qc2 = nextOfType(j, r, RecordType.QualityControl2);
  if (qc2) {
    const c = new Cursor(qc2.payload, 1);
    x.open('QualityControl2');
    x.el('NumberOfSatellites', c.u16());
    x.el('ErrorScale', c.f64());
    for (const tag of ['VCVxx', 'VCVxy', 'VCVxz', 'VCVyy', 'VCVyz', 'VCVzz']) x.el(tag, c.f64());
    x.el('UnitVariance', c.f64());
    x.close('QualityControl2');
  }

  // A point edited before it was stored carries its note itself; later
  // edits add note records, each repeating the earlier ones, newest first.
  const note = j.latestChild(r.id, RecordType.Note);
  const notes = noteLines(note ? noteText(note.payload) : point.note);
  if (notes.length) {
    x.open('Notes');
    for (const n of notes) x.el('Note', n);
    x.close('Notes');
  }
  x.close('PointRecord');

  if (!deleted && state.wgs84) {
    const held = ctx.held.get(point.name);
    if (!held || supersedes(point, held)) {
      positions.set(point.name, state.wgs84);
      ctx.held.set(point.name, point);
    }
  }
  return state;
}

/** How each observation of an averaged point differs from the average. */
function writeAverageResiduals(x: Xml, payload: Uint8Array) {
  const c = new Cursor(payload, 1);
  const n = c.u32();
  x.open('AverageResiduals');
  for (let i = 0; i < n && 5 + 72 * (i + 1) <= payload.length; i++) {
    c.at(5 + 72 * i + 17);
    x.open('AverageResidual');
    x.el('ObservationID', hexId(c.u32()));
    x.el('IncludedInAverageComputation', String(c.u8() !== 0));
    const [dn, de, du] = [c.f64(), c.f64(), c.f64()];
    x.open('GridResidual');
    x.el('DeltaNorth', dn);
    x.el('DeltaEast', de);
    x.el('DeltaElevation', du);
    x.close('GridResidual');
    x.close('AverageResidual');
  }
  x.close('AverageResiduals');
}

/**
 * Precision and quality-control records follow their point as top-level
 * records rather than children. Find one before the point's end marker.
 */
function nextOfType(j: Journal, point: JobRecord, type: number): JobRecord | undefined {
  const records = j.file.records;
  let i = j.position.get(point) ?? -1;
  if (i < 0) return undefined;
  for (i++; i < records.length; i++) {
    const r = records[i];
    if (r.kind !== KIND_NEW) continue;
    if (r.type === type) return r;
    if (r.type === RecordType.PointEnd || r.type === RecordType.Point) return undefined;
  }
  return undefined;
}

function writeQc1(x: Xml, c: Cursor) {
  c.at(1);
  // Satellites used, then the minimum during the occupation: total, then by system.
  const used = Array.from({ length: 7 }, () => c.u16());
  const min = Array.from({ length: 7 }, () => c.u16());
  const systems = ['GPS', 'GLONASS', 'Galileo', 'QZSS', 'BeiDou', 'NavIC'];
  x.open('QualityControl1');
  x.el('MinimumNumberOfSatellites', min[0]);
  systems.slice(0, 5).forEach((s, i) => x.el(`Min${s}SVs`, min[i + 1]));
  x.el('NumberOfSatellites', used[0]);
  systems.forEach((s, i) => x.el(`Num${s}SVs`, used[i + 1]));
  c.at(30);
  for (const tag of ['PDOP', 'GDOP', 'HDOP', 'VDOP']) x.el(tag, c.f64());
  for (const tag of ['PDOP', 'GDOP', 'HDOP', 'VDOP']) x.el(`${tag}_AtStore`, c.f64());
  x.el('NumberOfPositionsUsed', c.at(102).u16());
  x.open('StartTime');
  x.el('GPSWeek', c.at(154).u16());
  x.el('Seconds', c.f64());
  x.close('StartTime');
  x.open('EndTime');
  x.el('GPSWeek', c.at(164).u16());
  x.el('Seconds', c.f64());
  x.close('EndTime');
  x.el('RTCMAge', c.at(176).f64());
  x.close('QualityControl1');
}

/**
 * Grid distance ÷ ground distance near lat/lon (radians) at ellipsoid height
 * h: the projection's point scale times the elevation factor R / (R + h).
 */
function combinedScaleFactor(toGrid: proj4.Converter, lat: number, lon: number, h: number): number {
  const d = 50;
  const ends = [-d, d].map((e) => {
    const [la, lo] = offset([lat, lon, 0], enuToEcef(lat, lon, e, e, 0));
    return toGrid.forward([deg(lo), deg(la)]);
  });
  const k = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) / (2 * d * Math.SQRT2);
  const sin2 = Math.sin(lat) ** 2;
  const m = (A * (1 - E2)) / (1 - E2 * sin2) ** 1.5;
  const n = A / Math.sqrt(1 - E2 * sin2);
  const r = Math.sqrt(m * n);
  return (k * r) / (r + h);
}

/** Ground mark to antenna phase centre: measured height plus the antenna's offset. */
function antennaHeight(j: Journal, antennaId: number): number | undefined {
  const a = j.byId.get(antennaId);
  if (!a) return undefined;
  const ant = decodeAntenna(a.payload);
  if (ant.measuredHeight === undefined) return undefined;
  const e = j.byId.get(ant.equipment);
  return ant.measuredHeight + (e ? (decodeEquipment(e.payload).verticalOffset ?? 0) : 0);
}

/** Parse a JOB file into the same document the JobXML parser produces. */
export function parseJob(bytes: Uint8Array, options: ParseOptions & JobOptions = {}): JxlDocument {
  return { ...parseJxl(jobToJxl(bytes, options), options), format: 'job' };
}
