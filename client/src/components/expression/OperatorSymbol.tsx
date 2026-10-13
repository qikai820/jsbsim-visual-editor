import type { ReactNode } from 'react';
import type { ExprTable } from '../../types';

const LABELS: Record<string, string> = {
  sum: 'Σ', summer: 'Σ', product: '×', difference: '−', quotient: '÷',
  pow: 'uⁿ', sqrt: '√u', abs: '|u|', exp: 'eᵘ', log: 'ln', log10: 'log₁₀',
  gt: '>', lt: '<', ge: '≥', le: '≤', eq: '=', nq: '≠',
  and: 'AND', or: 'OR', not: 'NOT', ifthen: 'if', min: 'min', max: 'max',
  avg: 'mean', mod: 'mod', fraction: 'frac', integer: 'floor',
  toradians: 'deg→rad', todegrees: 'rad→deg', random: 'rand', urandom: 'rand',
  pi: 'π', roundmultiple: 'round', pid: 'PID(s)', second_order_filter: 'H(s)',
  actuator: '执行器', kinematic: 'K', angle: '∠', sensor: 'S', gyro: 'ω',
  accelerometer: 'a', magnetometer: 'B', bias: '+ b', constant: 'C',
  function: 'ƒ', fcs_function: 'ƒ', function_ref: 'ƒ', property: 'u', value: 'C',
};
const FRACTIONS: Record<string, [string, string]> = {
  integrator: ['1', 's'], lag_filter: ['1', 'τs + 1'],
  lead_lag_filter: ['a₁s + a₀', 'b₁s + b₀'], washout_filter: ['s', 's + ω'],
};
const TABLE_PLOT = { left: 4, right: 76, top: 4, bottom: 48 };

// Show the actual piecewise-linear lookup curve in a compact 1D table block.
// Each vertex comes from one stored breakpoint/output pair. Incomplete data
// has no preview, so the icon never joins points across a missing row.
function tableCurvePoints(table: ExprTable): { x: number; y: number }[] {
  if (table.tableType !== '1D') return [];
  const points: { x: number; y: number }[] = [];
  for (const [index, x] of (table.breakpoints1 || []).entries()) {
    const y = table.data?.[index]?.[0];
    if (!Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return [];
    points.push({ x, y });
  }
  if (points.length < 2) return [];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const xMin = Math.min(...xs), xRange = Math.max(...xs) - xMin;
  const yMin = Math.min(...ys), yRange = Math.max(...ys) - yMin;
  if (xRange <= 0) return [];
  return points.map(point => {
    const x = TABLE_PLOT.left + ((point.x - xMin) / xRange) * (TABLE_PLOT.right - TABLE_PLOT.left);
    const y = yRange > 0
      ? TABLE_PLOT.bottom - ((point.y - yMin) / yRange) * (TABLE_PLOT.bottom - TABLE_PLOT.top)
      : (TABLE_PLOT.top + TABLE_PLOT.bottom) / 2;
    return { x, y };
  });
}

/** A shared vector vocabulary for both component and expanded-expression blocks. */
export default function OperatorSymbol({ kind, value, table }: { kind: string; value?: string; table?: ExprTable }) {
  let content: ReactNode;
  const fraction = FRACTIONS[kind];
  const text = kind === 'saturation' ? `限幅 ${value || ''}` : value || LABELS[kind] || kind;
  const curvePoints = table ? tableCurvePoints(table) : [];
  const curvePath = curvePoints.map((point, index) =>
    `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  if (kind === 'saturation') {
    content = <><text x="40" y="16" fontSize="17">限幅</text>
      <text x="40" y="37" fontSize={Math.min(14, 112 / Math.max(value?.length || 1, 1))}>{value}</text></>;
  } else if (fraction) {
    content = <><text x="40" y="16" fontSize="13">{fraction[0]}</text>
      <path d="M 10 26 H 70" /><text x="40" y="36" fontSize="13">{fraction[1]}</text></>;
  } else if (kind === 'pure_gain' || kind === 'scheduled_gain') {
    content = <><path d="M 13 6 L 69 26 L 13 46 Z" fill="none" />
      <text x="33" y="27" fontSize="14">{value || 'K'}</text></>;
  } else if (kind === 'table' || kind === 'aero_table') {
    content = <><path d="M 4 4 V 48 H 76" opacity=".5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d="M 4 19 H 76 M 4 33 H 76 M 28 4 V 48 M 52 4 V 48"
        opacity=".15" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {curvePath ? <><path d={curvePath} stroke="#2563eb" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        {curvePoints.map((point, index) =>
          <circle key={index} cx={point.x} cy={point.y} r="1.35" stroke="none" style={{ fill: '#2563eb' }} />)}
      </>
        : <text x="41" y="23" fontSize="10">{table?.tableType || '—'}</text>}
      {!curvePath && <text x="40" y="43" fontSize="9">LUT</text>}</>;
  } else if (kind === 'switch') {
    content = <><path d="M 12 12 H 25 M 12 40 H 25 M 31 16 L 55 26 H 69" />
      <circle cx="27" cy="12" r="2" /><circle cx="27" cy="40" r="2" /></>;
  } else if (kind === 'deadband' || kind === 'aerosurface_scale') {
    content = <><path d="M 12 26 H 68 M 40 7 V 45" opacity=".25" />
      <path d={kind === 'deadband' ? 'M 14 42 L 30 26 H 50 L 66 10' : 'M 12 40 H 26 L 54 12 H 68'} /></>;
  } else {
    const size = text.length <= 2 ? 28 : text.length <= 5 ? 17 : Math.max(9, 76 / (text.length * .6));
    content = <text x="40" y="26" fontSize={size}>{text}</text>;
  }
  const accessibleText = curvePath ? `1D LUT，${table!.breakpoints1.length} 个断点的真实插值曲线` : text;
  const isTable = kind === 'table' || kind === 'aero_table';
  return <svg className={`operator-symbol${isTable ? ' operator-symbol-table' : ''}`}
    viewBox="0 0 80 52" preserveAspectRatio={isTable ? 'none' : undefined} aria-label={accessibleText}
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {content}
  </svg>;
}
