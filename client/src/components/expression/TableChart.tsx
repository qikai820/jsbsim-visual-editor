import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ExprTable } from '../../types';
import { axisLabel, formatTableNumber, tableRange, tableSlice, valueColor, type TableAxis, type TablePoint } from '../../utils/tableData';
import './tableWorkspace.css';

interface TableChartProps {
  expr: ExprTable;
  width?: number;
  height?: number;
  fixedAxis?: TableAxis;
  slice?: number;
  mode?: 'surface' | 'heatmap';
  selected?: TablePoint;
  onSelect?: (point: TablePoint) => void;
}

const fmt = (n: number | undefined) => n === undefined || !Number.isFinite(n) ? '—' : formatTableNumber(n);
const tick = (n: number) => Number.isFinite(n) ? String(Number(n.toPrecision(5))) : '—';
const samePoint = (a: TablePoint | undefined, b: TablePoint) => a?.every((v, i) => v === b[i]);
const normalize = (value: number, min: number, max: number) => max === min ? .5 : (value - min) / (max - min);
const spaced = (length: number, count = 4) => Array.from(new Set(Array.from({ length: Math.min(length, count) },
  (_, i) => Math.round(i * (length - 1) / Math.max(1, Math.min(length, count) - 1)))));

export default function TableChart({ expr, width = 640, height = 390, fixedAxis = 2, slice = 0,
  mode = 'surface', selected, onSelect }: TableChartProps) {
  const view = useMemo(() => tableSlice(expr, fixedAxis, slice), [expr, fixedAxis, slice]);
  const [min, max] = useMemo(() => tableRange(expr), [expr]);
  const [camera, setCamera] = useState({ yaw: -.65, elevation: .58, zoom: 1 });
  const drag = useRef<{ x: number; y: number; yaw: number; elevation: number; moved: boolean }>();
  const surfaceSvg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = surfaceSvg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      setCamera(current => ({ ...current, zoom: Math.max(.55, Math.min(1.8, current.zoom - event.deltaY * .001)) }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [expr, mode]);
  const id = useId().replace(/:/g, '');
  const w = Math.max(340, width), h = Math.max(230, height);
  const rowLabel = axisLabel(expr, view.rowAxis ?? 0);
  const colLabel = view.columnAxis === undefined ? '' : axisLabel(expr, view.columnAxis);
  const selectedInView = selected && (expr.tableType !== '3D' || selected[fixedAxis] === slice);
  const description = (r: number, c: number) => `${rowLabel} = ${fmt(view.rows[r])}${colLabel ? `, ${colLabel} = ${fmt(view.columns[c])}` : ''}; 输出 = ${fmt(view.values[r]?.[c])}`;
  const choose = (r: number, c: number) => onSelect?.(view.pointAt(r, c));
  const finiteValues = view.values.flat().filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (!view.rows.length || !view.columns.length || !finiteValues.length) {
    return <div className="lut-chart-empty">暂无可显示的数据，请添加断点和数值。</div>;
  }

  const chartSvgProps = { viewBox: `0 0 ${w} ${h}`, className: 'lut-chart-svg', role: 'img',
    'aria-label': expr.tableType === '1D' ? '一维插值曲线' : mode === 'surface' ? '可旋转的三维插值曲面' : '当前切片的热力图' };
  const left = 64, right = w - 28, top = 28, bottom = h - 55;
  const legend = <div className="lut-color-legend"><span>{tick(min)}</span>
    <i style={{ background: `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(t => valueColor(min + t * (max - min), min, max)).join(',')})` }} />
    <span>{tick(max)}</span><small>输出值 · 全表统一色标</small></div>;

  if (expr.tableType === '1D') {
    const xMin = Math.min(...view.rows), xMax = Math.max(...view.rows);
    const point = (r: number) => [left + normalize(view.rows[r], xMin, xMax) * (right - left),
      bottom - normalize(view.values[r][0]!, min, max) * (bottom - top)];
    const path = view.rows.map((_, r) => {
      const [x, y] = point(r); return `${r ? 'L' : 'M'} ${x} ${y}`;
    }).join(' ');
    return <div className="lut-chart"><svg {...chartSvgProps}>
      {Array.from({ length: 5 }, (_, i) => {
        const y = top + i * (bottom - top) / 4;
        return <g key={i}><line x1={left} x2={right} y1={y} y2={y} className="lut-chart-gridline" />
          <text x={left - 9} y={y + 4} textAnchor="end">{tick(max - i * (max - min) / 4)}</text></g>;
      })}
      <path d={`M${left},${top}V${bottom}H${right}`} className="lut-chart-axis" />
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#0d9488" stopOpacity=".23" /><stop offset="1" stopColor="#0d9488" stopOpacity=".02" /></linearGradient></defs>
      <path d={`${path} L${point(view.rows.length - 1)[0]} ${bottom} L${point(0)[0]} ${bottom} Z`} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke="#0d9488" strokeWidth="2.5" />
      {view.rows.map((_, r) => { const [x, y] = point(r); return <circle key={r} cx={x} cy={y}
        r={samePoint(selected, view.pointAt(r, 0)) ? 6 : 4} className="lut-chart-point" tabIndex={onSelect ? 0 : undefined}
        role={onSelect ? 'button' : undefined} aria-label={description(r, 0)}
        onClick={() => choose(r, 0)} onKeyDown={e => { if (e.key === 'Enter') choose(r, 0); }}><title>{description(r, 0)}</title></circle>; })}
      {spaced(view.rows.length, 6).map(r => <text key={r} x={point(r)[0]} y={bottom + 20} textAnchor="middle">{tick(view.rows[r])}</text>)}
      <text x={(left + right) / 2} y={h - 8} textAnchor="middle" className="lut-chart-axis-title">{rowLabel}</text>
      <text x={left} y={17} className="lut-chart-axis-title">输出 f(x)</text>
    </svg>{legend}</div>;
  }

  if (mode === 'heatmap') {
    const cw = (right - left) / view.columns.length, ch = (bottom - top) / view.rows.length;
    return <div className="lut-chart"><svg {...chartSvgProps}>
      {view.values.map((row, r) => row.map((value, c) => <g key={`${r}-${c}`}
        tabIndex={onSelect ? 0 : undefined} role={onSelect ? 'button' : undefined} aria-label={description(r, c)}
        onClick={() => choose(r, c)} onKeyDown={e => { if (e.key === 'Enter') choose(r, c); }}>
        <rect x={left + c * cw} y={top + r * ch} width={cw} height={ch}
          fill={value === undefined || !Number.isFinite(value) ? '#e2e8f0' : valueColor(value, min, max)}
          stroke={samePoint(selected, view.pointAt(r, c)) ? '#0f172a' : '#ffffff88'}
          strokeWidth={samePoint(selected, view.pointAt(r, c)) ? 3 : 1} />
        {cw > 48 && ch > 24 && <text x={left + (c + .5) * cw} y={top + (r + .5) * ch + 4}
          textAnchor="middle" className="lut-heat-value">{tick(value!)}</text>}
        <title>{description(r, c)}</title>
      </g>))}
      {spaced(view.rows.length, Math.floor((bottom - top) / 24)).map(r => <text key={r} x={left - 9} y={top + (r + .5) * ch + 4} textAnchor="end">{tick(view.rows[r])}</text>)}
      {spaced(view.columns.length, Math.floor((right - left) / 65)).map(c => <text key={c} x={left + (c + .5) * cw} y={bottom + 20} textAnchor="middle">{tick(view.columns[c])}</text>)}
      <text x={(left + right) / 2} y={h - 8} textAnchor="middle" className="lut-chart-axis-title">列 → {colLabel}</text>
      <text x={left} y={17} className="lut-chart-axis-title">行 ↓ {rowLabel}</text>
    </svg>{legend}</div>;
  }

  const xMin = Math.min(...view.columns), xMax = Math.max(...view.columns);
  const yMin = Math.min(...view.rows), yMax = Math.max(...view.rows);
  const scale = Math.min(w / 4.5, h / 3.5) * camera.zoom;
  const project = (x: number, y: number, z: number) => {
    const a = x * Math.cos(camera.yaw) - y * Math.sin(camera.yaw);
    const b = x * Math.sin(camera.yaw) + y * Math.cos(camera.yaw);
    return { x: w / 2 + a * scale, y: h * .58 + (b * Math.sin(camera.elevation) - z * Math.cos(camera.elevation)) * scale, depth: b * Math.cos(camera.elevation) + z * Math.sin(camera.elevation) };
  };
  const world = (r: number, c: number, value: number) => project(
    2 * normalize(c, xMin, xMax) - 1, 1 - 2 * normalize(r, yMin, yMax), 1.5 * normalize(value, min, max));
  const vertices = view.values.flatMap((row, r) => row.flatMap((value, c) => value === undefined || !Number.isFinite(value) ? [] :
    [{ ...world(view.rows[r], view.columns[c], value), r, c, value }]));
  const surfaces: { points: string; depth: number; value: number; r: number; c: number }[] = [];
  const subdivisions = view.rows.length * view.columns.length < 1600 ? 2 : 1;
  for (let r = 0; r < view.rows.length - 1; r++) for (let c = 0; c < view.columns.length - 1; c++) {
    const values = [view.values[r][c], view.values[r][c + 1], view.values[r + 1][c + 1], view.values[r + 1][c]];
    if (!values.every(v => v !== undefined && Number.isFinite(v))) continue;
    const sample = (u: number, v: number) => {
      const value = values[0]! * (1 - u) * (1 - v) + values[1]! * u * (1 - v) + values[2]! * u * v + values[3]! * (1 - u) * v;
      return { ...world(view.rows[r] + v * (view.rows[r + 1] - view.rows[r]),
        view.columns[c] + u * (view.columns[c + 1] - view.columns[c]), value), value };
    };
    for (let i = 0; i < subdivisions; i++) for (let j = 0; j < subdivisions; j++) {
      const u = i / subdivisions, v = j / subdivisions, step = 1 / subdivisions;
      const corners = [sample(u, v), sample(u + step, v), sample(u + step, v + step), sample(u, v + step)];
      surfaces.push({ points: corners.map(p => `${p.x},${p.y}`).join(' '),
        depth: corners.reduce((s, p) => s + p.depth, 0) / 4,
        value: corners.reduce((s, p) => s + p.value, 0) / 4, r, c });
    }
  }
  surfaces.sort((a, b) => a.depth - b.depth);
  const origin = project(-1, 1, 0), xEnd = project(1, 1, 0), yEnd = project(-1, -1, 0), zOrigin = project(-1, -1, 0), zEnd = project(-1, -1, 1.6);
  const reset = () => setCamera({ yaw: -.65, elevation: .58, zoom: 1 });
  return <div className="lut-chart lut-surface-chart">
    <div className="lut-camera-tools"><span>拖动旋转 · 滚轮缩放 · 点击数据点定位</span><button type="button" onClick={reset}>复位视角</button></div>
    <svg {...chartSvgProps} ref={surfaceSvg} tabIndex={0}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.focus(); drag.current = { x: e.clientX, y: e.clientY, yaw: camera.yaw, elevation: camera.elevation, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const start = drag.current; if (!start || !e.buttons) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) < 4 && !start.moved) return;
        start.moved = true; setCamera(current => ({ ...current, yaw: start.yaw + dx * .008,
          elevation: Math.max(.12, Math.min(1.4, start.elevation + dy * .006)) })); }}
      onPointerUp={e => {
        if (drag.current && !drag.current.moved && onSelect) {
          const rect = e.currentTarget.getBoundingClientRect(), x = (e.clientX - rect.left) * w / rect.width, y = (e.clientY - rect.top) * h / rect.height;
          const nearest = vertices.reduce((best, p) => (p.x - x) ** 2 + (p.y - y) ** 2 < (best.x - x) ** 2 + (best.y - y) ** 2 ? p : best);
          if (Math.hypot(nearest.x - x, nearest.y - y) < 24) onSelect(view.pointAt(nearest.r, nearest.c));
        }
        e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = undefined; }}
      onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '0'].includes(e.key)) return;
        e.preventDefault(); if (e.key === '0') reset();
        else setCamera(current => ({ yaw: current.yaw + (e.key === 'ArrowLeft' ? -.1 : e.key === 'ArrowRight' ? .1 : 0),
          elevation: Math.max(.12, Math.min(1.4, current.elevation + (e.key === 'ArrowUp' ? .1 : e.key === 'ArrowDown' ? -.1 : 0))),
          zoom: Math.max(.55, Math.min(1.8, current.zoom + (e.key === '+' ? .1 : e.key === '-' ? -.1 : 0))) })); }}>
      <defs><radialGradient id={id}><stop stopColor="#dce9ed" stopOpacity=".6" /><stop offset="1" stopColor="#f8fafc" stopOpacity="0" /></radialGradient></defs>
      <ellipse cx={w / 2} cy={h * .76} rx={w * .35} ry={h * .19} fill={`url(#${id})`} />
      {Array.from({ length: 5 }, (_, i) => {
        const t = -1 + i / 2, a = project(t, -1, 0), b = project(t, 1, 0), c = project(-1, t, 0), d = project(1, t, 0);
        return <g key={i} className="lut-floor-grid"><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} /><line x1={c.x} y1={c.y} x2={d.x} y2={d.y} /></g>;
      })}
      <g className="lut-chart-axis"><path d={`M${xEnd.x},${xEnd.y}L${origin.x},${origin.y}L${yEnd.x},${yEnd.y} M${zOrigin.x},${zOrigin.y}L${zEnd.x},${zEnd.y}`} /></g>
      {surfaces.map((face, i) => <polygon key={i} data-surface-face="true" points={face.points}
        fill={valueColor(face.value, min, max)} stroke="#ffffff50" strokeWidth=".65"><title>{description(face.r, face.c)}</title></polygon>)}
      {/* Degenerate single-row/column tables remain visible as a curve. */}
      {!surfaces.length && <polyline points={vertices.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#189faa" strokeWidth="2" />}
      {vertices.length < 1600 && vertices.map(p => <circle key={`${p.r}-${p.c}`} cx={p.x} cy={p.y} r={samePoint(selected, view.pointAt(p.r, p.c)) ? 6 : 2.5}
        fill={samePoint(selected, view.pointAt(p.r, p.c)) ? '#fff' : valueColor(p.value, min, max)} stroke={samePoint(selected, view.pointAt(p.r, p.c)) ? '#0f172a' : '#ffffffb0'}
        strokeWidth={samePoint(selected, view.pointAt(p.r, p.c)) ? 2.5 : .8} className="lut-surface-point"
        aria-label={description(p.r, p.c)}><title>{description(p.r, p.c)}</title></circle>)}
      {selectedInView && vertices.filter(p => samePoint(selected, view.pointAt(p.r, p.c))).map(p => <g key="selected" pointerEvents="none">
        <circle cx={p.x} cy={p.y} r={10} fill="none" stroke="#0f172a" strokeWidth="1" opacity=".45" />
        <rect x={p.x + 10} y={p.y - 25} width={Math.max(62, fmt(p.value).length * 8 + 16)} height={23} rx={5} fill="#0f172a" />
        <text x={p.x + 18} y={p.y - 9} className="lut-surface-tooltip">{fmt(p.value)}</text>
      </g>)}
      {spaced(view.columns.length).map(c => { const p = project(2 * normalize(view.columns[c], xMin, xMax) - 1, 1, 0);
        return <text key={`c${c}`} x={p.x + 4} y={p.y + 18} textAnchor="middle">{tick(view.columns[c])}</text>; })}
      {spaced(view.rows.length).map(r => { const p = project(-1, 1 - 2 * normalize(view.rows[r], yMin, yMax), 0);
        return <text key={`r${r}`} x={p.x - 10} y={p.y + 4} textAnchor="end">{tick(view.rows[r])}</text>; })}
      {[0, .5, 1].map(t => { const p = project(-1, -1, t * 1.5); return <text key={t} x={p.x - 10} y={p.y - 6} textAnchor="end">{tick(min + t * (max - min))}</text>; })}
      <text x={xEnd.x + 12} y={xEnd.y + 39} textAnchor="middle" className="lut-chart-axis-title">{colLabel}</text>
      <text x={yEnd.x - 12} y={yEnd.y + 26} textAnchor="middle" className="lut-chart-axis-title">{rowLabel}</text>
      <text x={zEnd.x - 7} y={zEnd.y - 13} textAnchor="middle" className="lut-chart-axis-title">输出 f(x)</text>
    </svg>{legend}
  </div>;
}
