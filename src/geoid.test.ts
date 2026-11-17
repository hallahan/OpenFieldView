// The geoid grid reader, on a small made-up grid. docs/job-format.md has the
// file layout; real elevations are checked in job.compare.test.ts.

import { describe, expect, it } from 'vitest';
import { cropGgf, GeoidParseError, isGgf, readGgf, undulation } from './geoid';

/** A grid from 30°N 100°W, one cell every 0.5°, with heights from f(row, col). */
function grid(rows: number, cols: number, f: (r: number, c: number) => number): Uint8Array {
  const out = new Uint8Array(146 + rows * cols * 4);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('TNL GRID FILE'), 2);
  out.set(new TextEncoder().encode('Test geoid'), 16);
  [30, 30 + 0.5 * (rows - 1), 260, 260 + 0.5 * (cols - 1), 0.5, 0.5].forEach((v, i) => view.setFloat64(48 + 8 * i, v, true));
  view.setInt32(96, rows, true);
  view.setInt32(100, cols, true);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) view.setFloat32(146 + 4 * (r * cols + c), f(r, c), true);
  return out;
}

describe('readGgf', () => {
  const bytes = grid(9, 13, (r, c) => -20 + 0.25 * r * r - 0.5 * c + 0.125 * r * c);
  const g = readGgf(bytes);

  it('reads the header', () => {
    expect(isGgf(bytes)).toBe(true);
    expect(isGgf(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false);
    expect(g).toMatchObject({ name: 'Test geoid', south: 30, west: 260, dLat: 0.5, dLon: 0.5, rows: 9, cols: 13 });
    expect(() => readGgf(bytes.subarray(0, bytes.length - 4))).toThrow(GeoidParseError);
  });

  it('interpolates with a quadratic, so a quadratic surface comes back exactly', () => {
    const f = (lat: number, lon: number) => {
      const r = (lat - 30) / 0.5;
      const c = (lon + 100) / 0.5;
      return -20 + 0.25 * r * r - 0.5 * c + 0.125 * r * c;
    };
    expect(undulation(g, 31, -98)).toBeCloseTo(f(31, -98), 5);
    expect(undulation(g, 31.37, -97.81)).toBeCloseTo(f(31.37, -97.81), 5);
    // The edge cells borrow the rows and columns just inside.
    expect(undulation(g, 30.1, -99.9)).toBeCloseTo(f(30.1, -99.9), 5);
    expect(undulation(g, 31.37, 262.19)).toBeCloseTo(f(31.37, -97.81), 5);
  });

  it('gives nothing outside the grid', () => {
    expect(undulation(g, 29.9, -98)).toBeUndefined();
    expect(undulation(g, 31, -93.9)).toBeUndefined();
  });

  it('crops to an area and gives the same heights there', () => {
    const small = cropGgf(bytes, { south: 31.2, west: -98.1, north: 31.6, east: -97.6 }, 1);
    const s = readGgf(small);
    expect(small.length).toBeLessThan(bytes.length);
    expect(s).toMatchObject({ name: 'Test geoid', south: 30.5, west: 261, rows: 5, cols: 5 });
    for (const [lat, lon] of [[31.2, -98.1], [31.37, -97.81], [31.6, -97.6]]) {
      expect(undulation(s, lat, lon)).toBeCloseTo(undulation(g, lat, lon)!, 6);
    }
    expect(() => cropGgf(bytes, { south: 50, west: -98, north: 51, east: -97 })).toThrow(GeoidParseError);
  });
});
