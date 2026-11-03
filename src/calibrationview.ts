// The Calibration tab: site calibration parameters, the point pairs and their
// residuals, checkshots on control, and the RTK bases the job was measured from.

import type { BaseCheck, Calibration, CalibrationPair, Checkshot, RtkBase } from './calibration';
import { formatLength, latLonDms, type Unit } from './properties';
import { esc } from './util';

/** Checkshots and base offsets larger than this are flagged (about 0.1 ft). */
export const CHECK_TOLERANCE = 0.03;

/**
 * HTML for the Calibration tab. `pointIndex` finds a point by name, so rows can
 * open it; rows carry `data-point` for the caller to wire up.
 */
export function calibrationHtml(cal: Calibration, unit: Unit, pointIndex: (name: string) => number | undefined): string {
  const out: string[] = [];
  out.push(summary(cal, unit));
  out.push(parameters(cal, unit));
  if (cal.pairs.length) out.push(pairsTable(cal.pairs, unit, pointIndex));
  if (cal.checkshots.length) out.push(checkshotTable(cal.checkshots, unit, pointIndex));
  if (cal.baseChecks.length) out.push(baseCheckTable(cal.baseChecks, unit, pointIndex));
  if (cal.bases.length) out.push(basesTable(cal.bases, pointIndex));
  return out.join('');
}

function summary(cal: Calibration, unit: Unit): string {
  const lines: string[] = [];
  const calibrated = cal.horizontal || (cal.vertical && /InclinedPlane/.test(cal.vertical.type));
  if (calibrated) {
    const n = cal.pairs.length;
    lines.push(
      `${n ? `Calibrated on ${n} point pair${n === 1 ? '' : 's'}` : 'Calibration has no point pairs in the file'}${cal.computed ? `, ${esc(stamp(cal.computed))}` : ''}.`,
    );
  } else {
    lines.push('No site calibration: GNSS points use the projection and geoid alone.');
  }
  const withResidual = cal.pairs.filter((p) => p.residual);
  if (withResidual.length) {
    const h = Math.max(...withResidual.map((p) => p.residual!.horizontal));
    const verticals = withResidual.map((p) => p.residual!.elevation).filter((v): v is number => v !== undefined);
    const v = verticals.length ? Math.max(...verticals.map(Math.abs)) : undefined;
    lines.push(`Largest residual: ${formatLength(h, unit)} horizontal${v !== undefined ? `, ${formatLength(v, unit)} vertical` : ''}.`);
  }
  if (cal.pairs.some((p) => p.residualSource === 'Computed')) {
    lines.push(
      'Residuals are not stored in the file, which usually means the calibration was imported. They are worked out here from each GNSS point’s computed grid, so they only show how well the calibration fits the observations it came with.',
    );
  }
  const worst = cal.checkshots.reduce<Checkshot | undefined>((a, c) => (!a || c.horizontal > a.horizontal ? c : a), undefined);
  if (worst && worst.horizontal > CHECK_TOLERANCE) {
    lines.push(
      `<span class="warn-text">Checkshots miss control by up to ${formatLength(worst.horizontal, unit)} (${esc(worst.design || worst.name)}).</span>`,
    );
  }
  for (const b of cal.baseChecks.filter((b) => b.horizontal > CHECK_TOLERANCE)) {
    lines.push(
      `<span class="warn-text">Base ${esc(b.base)} lands ${formatLength(b.horizontal, unit)} from ${esc(b.point)}.</span> ` +
        'If they are the same station, its published coordinates have changed, and a calibration observed from the old ones will be off by about that much.',
    );
  }
  return `<div class="cal-summary">${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
}

function parameters(cal: Calibration, unit: Unit): string {
  const rows: [string, string][] = [];
  const h = cal.horizontal;
  rows.push(['Horizontal', humanType(cal.horizontalType) || 'None']);
  if (h) {
    rows.push(['Origin', `N ${grid(h.originNorth, unit)}, E ${grid(h.originEast, unit)}`]);
    rows.push(['Shift', `N ${signed(h.translationNorth, unit)}, E ${signed(h.translationEast, unit)}`]);
    rows.push(['Rotation', `${(h.rotation * 3600).toFixed(3)}″`]);
    rows.push(['Scale', `${h.scale.toFixed(9)} (${signedNumber((h.scale - 1) * 1e6, 2)} ppm)`]);
  }
  const v = cal.vertical;
  rows.push(['Vertical', v ? humanType(v.type) : 'None']);
  if (v?.geoid) rows.push(['Geoid', v.geoid]);
  if (v && /InclinedPlane/.test(v.type)) {
    rows.push(['Constant', signed(v.constant, unit)]);
    rows.push(['Slope north', `${signedNumber(v.slopeNorth * 1e6, 2)} ppm`]);
    rows.push(['Slope east', `${signedNumber(v.slopeEast * 1e6, 2)} ppm`]);
    if (v.originNorth !== undefined && v.originEast !== undefined) {
      rows.push(['Plane origin', `N ${grid(v.originNorth, unit)}, E ${grid(v.originEast, unit)}`]);
    }
  }
  return `<h3>Parameters</h3><table class="kv">${rows.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('')}</table>`;
}

function pairsTable(pairs: CalibrationPair[], unit: Unit, pointIndex: (name: string) => number | undefined): string {
  const worstH = Math.max(...pairs.map((p) => p.residual?.horizontal ?? 0));
  const worstV = Math.max(...pairs.map((p) => Math.abs(p.residual?.elevation ?? 0)));
  const rows = pairs.map((p) => {
    const r = p.residual;
    const cells = r
      ? [
          num(r.north, unit),
          num(r.east, unit),
          r.elevation !== undefined ? num(r.elevation, unit, Math.abs(r.elevation) === worstV && worstV > 0 ? 'max' : undefined) : '',
          length(r.horizontal, unit, r.horizontal === worstH && worstH > 0 ? 'max' : undefined),
        ]
      : ['', '', '', ''];
    return row(p.gridPoint, `${p.gnssPoint}${p.dimension && p.dimension !== '3D' ? ` · ${p.dimension}` : ''}`, cells, pointIndex(p.gridPoint));
  });
  return (
    `<h3>Point pairs</h3>` +
    `<table class="cal-table">${head(['Point', 'ΔN', 'ΔE', 'ΔElev', 'Horiz'], unit)}<tbody>${rows.join('')}</tbody></table>` +
    `<p class="group-note">Residuals are control minus calibrated GNSS, as Trimble Access shows them.</p>`
  );
}

function checkshotTable(shots: Checkshot[], unit: Unit, pointIndex: (name: string) => number | undefined): string {
  const rows = shots.map((c) =>
    row(
      c.design || c.name,
      `${c.name} · ${stamp(c.stored)}`,
      [
        num(c.north, unit),
        num(c.east, unit),
        c.elevation !== undefined ? num(c.elevation, unit, Math.abs(c.elevation) > CHECK_TOLERANCE ? 'warn' : undefined) : '',
        length(c.horizontal, unit, c.horizontal > CHECK_TOLERANCE ? 'warn' : undefined),
      ],
      pointIndex(c.name) ?? pointIndex(c.design),
    ),
  );
  return (
    `<h3>Checkshots</h3>` +
    `<table class="cal-table">${head(['Staked', 'ΔN', 'ΔE', 'ΔElev', 'Horiz'], unit)}<tbody>${rows.join('')}</tbody></table>` +
    `<p class="group-note">Design minus measured, as the stakeout screen shows them. A consistent miss in one direction points to the calibration or the base, not the shots.</p>`
  );
}

function baseCheckTable(checks: BaseCheck[], unit: Unit, pointIndex: (name: string) => number | undefined): string {
  const rows = checks.map((b) =>
    row(
      b.point,
      `near base ${b.base}`,
      [
        num(b.north, unit),
        num(b.east, unit),
        b.elevation !== undefined ? num(b.elevation, unit) : '',
        length(b.horizontal, unit, b.horizontal > CHECK_TOLERANCE ? 'warn' : undefined),
      ],
      pointIndex(b.point),
    ),
  );
  return (
    `<h3>Base against nearby points</h3>` +
    `<table class="cal-table">${head(['Point', 'ΔN', 'ΔE', 'ΔElev', 'Horiz'], unit)}<tbody>${rows.join('')}</tbody></table>` +
    `<p class="group-note">Other points within 5 m of an RTK base, minus the base as this calibration places it.</p>`
  );
}

function basesTable(bases: RtkBase[], pointIndex: (name: string) => number | undefined): string {
  const rows = bases.map((b) => {
    const source = [b.mountPoint, b.format, b.solution].filter(Boolean).join(' · ');
    const vrs = b.vrs ? `VRS ${b.vrs.id} at ${latLonDms(b.vrs.lat, 'N', 'S')} ${latLonDms(b.vrs.lon, 'E', 'W')}` : '';
    const station = b.prsId ? `PRS ${b.prsId}` : '';
    const sub = [source, vrs, station, b.newBase ? 'new base station detected' : ''].filter(Boolean).join(' · ');
    const index = pointIndex(b.base);
    return (
      `<tr${index !== undefined ? ` data-point="${index}"` : ''}>` +
      `<td>${esc(stamp(b.stored))}</td>` +
      `<td><span class="cal-name">${esc(b.base)}</span><span class="sub-value">${esc(sub)}</span></td>` +
      `<td class="n">${b.points}</td></tr>`
    );
  });
  return (
    `<h3>RTK bases</h3>` +
    `<table class="cal-table"><thead><tr><th>Connected</th><th>Base</th><th class="n">Points</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
    `<p class="group-note">A network moves its virtual base to wherever the rover connects, so VRS positions differ between sessions. What the calibration depends on is the physical reference station's coordinates.</p>`
  );
}

function head(labels: string[], unit: Unit): string {
  return `<thead><tr>${labels.map((l, i) => `<th${i ? ' class="n"' : ''}>${esc(l)}${i ? ` <span class="unit">${esc(unit.label)}</span>` : ''}</th>`).join('')}</tr></thead>`;
}

function row(name: string, sub: string, cells: string[], index: number | undefined): string {
  return (
    `<tr${index !== undefined ? ` data-point="${index}"` : ''}>` +
    `<td><span class="cal-name">${esc(name)}</span><span class="sub-value">${esc(sub)}</span></td>` +
    cells.map((c) => `<td class="n">${c}</td>`).join('') +
    `</tr>`
  );
}

/** The largest of its column, or past the checkshot tolerance. */
type Mark = 'max' | 'warn' | undefined;

function marked(v: string, mark: Mark): string {
  if (mark === 'warn') return `<strong class="warn-text">${v}</strong>`;
  return mark === 'max' ? `<strong>${v}</strong>` : v;
}

function num(metres: number, unit: Unit, mark?: Mark): string {
  return marked(signedNumber(metres / unit.metres, 3), mark);
}

/** A distance, which has no sign. */
function length(metres: number, unit: Unit, mark?: Mark): string {
  return marked((metres / unit.metres).toFixed(3), mark);
}

/** A grid coordinate in the job's units. */
function grid(metres: number, unit: Unit): string {
  return formatLength(metres, unit);
}

function signed(metres: number, unit: Unit): string {
  return `${signedNumber(metres / unit.metres, 3)} ${unit.label}`;
}

function signedNumber(v: number, places: number): string {
  const s = v.toFixed(places);
  return v > 0 && Number(s) !== 0 ? `+${s}` : s.replace(/^-(0\.0+)$/, '$1');
}

/** "2026-11-02T11:54:30" → "2026-11-02 11:54". */
function stamp(s: string): string {
  return s.replace('T', ' ').replace(/:\d\d$/, '');
}

/** "GeoidModelAndInclinedPlane" → "Geoid model and inclined plane". */
function humanType(s: string): string {
  if (!s) return '';
  const words = s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
