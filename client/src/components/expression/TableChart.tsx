import { useMemo } from 'react';
import type { ExprNode } from '../../types';

interface TableChartProps {
  expr: ExprNode & { kind: 'table' };
  width?: number;
  height?: number;
}

// Color interpolation for heatmap
function valueToColor(val: number | undefined | null, min: number, max: number): string {
  const v = (val !== undefined && val !== null && !isNaN(val)) ? val : 0;
  const range = max - min || 1;
  const t = Math.max(0, Math.min(1, (v - min) / range));
  // Blue → Cyan → Green → Yellow → Red
  const r = t < 0.5 ? Math.round(t * 2 * 100) : Math.round(100 + (t - 0.5) * 2 * 155);
  const g = t < 0.25 ? Math.round(100 + t * 4 * 155) : t < 0.75 ? 255 : Math.round(255 - (t - 0.75) * 4 * 200);
  const b = t < 0.5 ? Math.round(255 - t * 2 * 255) : 0;
  return `rgb(${r},${g},${b})`;
}

function formatNum(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return '0';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (n === 0) return '0';
  return n.toFixed(3);
}

// ── 1D Line Chart ───────────────────────────────────────────────────────────

function LineChart1D({ expr, width, height }: TableChartProps) {
  const padding = { top: 20, right: 15, bottom: 35, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const { points, xMin, xMax, yMin, yMax, xTicks, yTicks } = useMemo(() => {
    const bp = expr.breakpoints1 || [];
    const data = expr.data || [];
    if (bp.length === 0 || data.length === 0) {
      return { points: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1, xTicks: [0, 1], yTicks: [0, 1] };
    }
    const vals = data.map(r => {
      const v = r?.[0];
      return (v !== undefined && v !== null && !isNaN(v)) ? v : 0;
    });

    const xMin = Math.min(...bp);
    const xMax = Math.max(...bp);
    const yMin = Math.min(...vals);
    const yMax = Math.max(...vals);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const points = bp.map((x, i) => {
      const rawVal = data[i]?.[0];
      const val = (rawVal !== undefined && rawVal !== null && !isNaN(rawVal)) ? rawVal : 0;
      return {
        x: padding.left + ((x - xMin) / xRange) * chartW,
        y: padding.top + chartH - ((val - yMin) / yRange) * chartH,
        val,
        bp: x,
      };
    });

    // Generate tick marks
    const xTicks = generateTicks(xMin, xMax, 5);
    const yTicks = generateTicks(yMin, yMax, 4);

    return { points, xMin, xMax, yMin, yMax, xTicks, yTicks };
  }, [expr, chartW, chartH, padding.left, padding.top]);

  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  // Build SVG path
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  // Area fill path
  const areaD = pathD +
    ` L${points[points.length - 1]?.x ?? 0},${padding.top + chartH}` +
    ` L${points[0]?.x ?? 0},${padding.top + chartH} Z`;

  const varLabel = expr.var1.split('/').pop() || 'x';

  return (
    <svg width={width} height={height} className="table-chart-svg">
      {/* Grid lines */}
      {yTicks.map((t, i) => {
        const y = padding.top + chartH - ((t - yMin) / yRange) * chartH;
        return (
          <g key={`yt-${i}`}>
            <line x1={padding.left} y1={y} x2={padding.left + chartW} y2={y}
              stroke="#e2e8f0" strokeWidth={0.5} />
            <text x={padding.left - 5} y={y + 3} textAnchor="end"
              className="chart-tick-text">{formatNum(t)}</text>
          </g>
        );
      })}
      {xTicks.map((t, i) => {
        const x = padding.left + ((t - xMin) / xRange) * chartW;
        return (
          <g key={`xt-${i}`}>
            <line x1={x} y1={padding.top} x2={x} y2={padding.top + chartH}
              stroke="#e2e8f0" strokeWidth={0.5} />
            <text x={x} y={padding.top + chartH + 14} textAnchor="middle"
              className="chart-tick-text">{formatNum(t)}</text>
          </g>
        );
      })}

      {/* Axes */}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + chartH}
        stroke="#94a3b8" strokeWidth={1} />
      <line x1={padding.left} y1={padding.top + chartH} x2={padding.left + chartW} y2={padding.top + chartH}
        stroke="#94a3b8" strokeWidth={1} />

      {/* Area fill */}
      <path d={areaD} fill="url(#areaGrad)" opacity={0.3} />

      {/* Line */}
      <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinejoin="round" />

      {/* Data points */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3.5} fill="#fff" stroke="#3b82f6" strokeWidth={1.5} />
          <title>{`${varLabel}=${formatNum(p.bp)}, f(x)=${formatNum(p.val)}`}</title>
        </g>
      ))}

      {/* Axis labels */}
      <text x={padding.left + chartW / 2} y={height - 3} textAnchor="middle"
        className="chart-axis-label">{varLabel}</text>
      <text x={12} y={padding.top + chartH / 2} textAnchor="middle"
        className="chart-axis-label" transform={`rotate(-90, 12, ${padding.top + chartH / 2})`}>f(x)</text>

      {/* Gradient definition */}
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ── 2D Heatmap ──────────────────────────────────────────────────────────────

function Heatmap2D({ expr, width, height }: TableChartProps) {
  const padding = { top: 25, right: 60, bottom: 35, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const { bp1, bp2, data, vMin, vMax, cellW, cellH } = useMemo(() => {
    const bp1 = expr.breakpoints1 || [];
    const bp2 = expr.breakpoints2 || [];
    const data = expr.data || [];
    if (data.length === 0 || bp1.length === 0 || bp2.length === 0) {
      return { bp1: [], bp2: [], data: [], vMin: 0, vMax: 1, cellW: 0, cellH: 0 };
    }
    const allVals = data.flat().filter(v => v !== undefined && v !== null);
    const vMin = allVals.length > 0 ? Math.min(...allVals) : 0;
    const vMax = allVals.length > 0 ? Math.max(...allVals) : 1;
    const cellW = chartW / Math.max(bp2.length, 1);
    const cellH = chartH / Math.max(bp1.length, 1);
    return { bp1, bp2, data, vMin, vMax, cellW, cellH };
  }, [expr, chartW, chartH]);

  const var1Label = expr.var1.split('/').pop() || 'row';
  const var2Label = expr.var2.split('/').pop() || 'col';

  return (
    <svg width={width} height={height} className="table-chart-svg">
      {/* Title */}
      <text x={padding.left + chartW / 2} y={14} textAnchor="middle" className="chart-title-text">
        {var1Label} ↓ / {var2Label} →
      </text>

      {/* Heatmap cells */}
      {data.map((row, ri) =>
        row.map((val, ci) => {
          const safeVal = (val !== undefined && val !== null && !isNaN(val)) ? val : 0;
          return (
            <g key={`${ri}-${ci}`}>
              <rect
                x={padding.left + ci * cellW}
                y={padding.top + ri * cellH}
                width={cellW - 1}
                height={cellH - 1}
                fill={valueToColor(safeVal, vMin, vMax)}
                rx={2}
              />
              {cellW > 30 && cellH > 18 && (
                <text
                  x={padding.left + ci * cellW + cellW / 2}
                  y={padding.top + ri * cellH + cellH / 2 + 3}
                  textAnchor="middle"
                  className="chart-cell-text"
                >
                  {formatNum(safeVal)}
                </text>
              )}
              <title>{`${var1Label}=${formatNum(bp1[ri])}, ${var2Label}=${formatNum(bp2[ci])}: ${formatNum(safeVal)}`}</title>
            </g>
          );
        })
      )}

      {/* Row labels (breakpoints1) */}
      {bp1.map((bp, i) => (
        <text key={`rl-${i}`}
          x={padding.left - 5}
          y={padding.top + i * cellH + cellH / 2 + 3}
          textAnchor="end" className="chart-tick-text">
          {formatNum(bp)}
        </text>
      ))}

      {/* Column labels (breakpoints2) */}
      {bp2.map((bp, i) => (
        <text key={`cl-${i}`}
          x={padding.left + i * cellW + cellW / 2}
          y={padding.top + bp1.length * cellH + 14}
          textAnchor="middle" className="chart-tick-text">
          {formatNum(bp)}
        </text>
      ))}

      {/* Color legend */}
      <defs>
        <linearGradient id="heatGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={valueToColor(0, 0, 1)} />
          <stop offset="50%" stopColor={valueToColor(0.5, 0, 1)} />
          <stop offset="100%" stopColor={valueToColor(1, 0, 1)} />
        </linearGradient>
      </defs>
      <rect x={width - 45} y={padding.top} width={12} height={chartH}
        fill="url(#heatGrad)" rx={3} stroke="#e2e8f0" strokeWidth={0.5} />
      <text x={width - 39} y={padding.top - 5} textAnchor="middle"
        className="chart-tick-text">{formatNum(vMax)}</text>
      <text x={width - 39} y={padding.top + chartH + 14} textAnchor="middle"
        className="chart-tick-text">{formatNum(vMin)}</text>
    </svg>
  );
}

// ── 3D Multi-Heatmap ────────────────────────────────────────────────────────

function Heatmap3D({ expr, width, height }: TableChartProps) {
  const bp1 = expr.breakpoints1 || [];
  const bp2 = expr.breakpoints2 || [];
  const bp3 = expr.breakpoints3 || [];
  const data = expr.data || [];
  const rowsPerTable = bp1.length || 1;
  const cols = bp2.length || 1;

  // Split data into sub-tables
  const tables = useMemo(() => {
    const result = [];
    for (let t = 0; t < bp3.length; t++) {
      const startRow = t * rowsPerTable;
      const tableData = data.slice(startRow, startRow + rowsPerTable);
      result.push({ bp3: bp3[t], data: tableData });
    }
    return result;
  }, [data, bp3, rowsPerTable]);

  const allVals = data.flat().filter(v => v !== undefined && v !== null);
  const vMin = allVals.length > 0 ? Math.min(...allVals) : 0;
  const vMax = allVals.length > 0 ? Math.max(...allVals) : 1;

  const var3Label = expr.var3.split('/').pop() || 'table';
  const var1Label = expr.var1.split('/').pop() || 'row';
  const var2Label = expr.var2.split('/').pop() || 'col';

  // Layout: arrange sub-tables in a grid
  const tablesPerRow = Math.min(tables.length, 3);
  const tableRows = Math.ceil(tables.length / tablesPerRow);
  const gap = 8;
  const labelH = 18;
  const singleW = (width - gap * (tablesPerRow - 1)) / tablesPerRow;
  const singleH = (height - labelH * tableRows - gap * (tableRows - 1)) / tableRows;

  const cellW = (singleW - 40) / Math.max(cols, 1);
  const cellH = (singleH - 25) / Math.max(rowsPerTable, 1);

  return (
    <svg width={width} height={height} className="table-chart-svg">
      {tables.map((tbl, ti) => {
        const col = ti % tablesPerRow;
        const row = Math.floor(ti / tablesPerRow);
        const offsetX = col * (singleW + gap);
        const offsetY = row * (singleH + gap + labelH);

        return (
          <g key={ti} transform={`translate(${offsetX}, ${offsetY})`}>
            {/* Sub-table title */}
            <text x={singleW / 2} y={12} textAnchor="middle" className="chart-subtitle-text">
              {var3Label} = {formatNum(tbl.bp3)}
            </text>

            {/* Heatmap cells */}
            {tbl.data.map((dataRow, ri) =>
              dataRow.map((val, ci) => {
                const safeVal = (val !== undefined && val !== null && !isNaN(val)) ? val : 0;
                return (
                  <g key={`${ri}-${ci}`}>
                    <rect
                      x={35 + ci * cellW}
                      y={18 + ri * cellH}
                      width={Math.max(cellW - 1, 1)}
                      height={Math.max(cellH - 1, 1)}
                      fill={valueToColor(safeVal, vMin, vMax)}
                      rx={1}
                    />
                    {cellW > 25 && cellH > 14 && (
                      <text
                        x={35 + ci * cellW + cellW / 2}
                        y={18 + ri * cellH + cellH / 2 + 3}
                        textAnchor="middle"
                        className="chart-cell-text-sm"
                      >
                        {formatNum(safeVal)}
                      </text>
                    )}
                    <title>{`${var3Label}=${formatNum(tbl.bp3)}, ${var1Label}=${formatNum(bp1[ri])}, ${var2Label}=${formatNum(bp2[ci])}: ${formatNum(safeVal)}`}</title>
                  </g>
                );
              })
            )}

            {/* Row labels */}
            {bp1.map((bp, i) => (
              <text key={`rl-${i}`} x={32} y={18 + i * cellH + cellH / 2 + 3}
                textAnchor="end" className="chart-tick-text-sm">
                {formatNum(bp)}
              </text>
            ))}

            {/* Column labels */}
            {bp2.map((bp, i) => (
              <text key={`cl-${i}`} x={35 + i * cellW + cellW / 2}
                y={18 + rowsPerTable * cellH + 11}
                textAnchor="middle" className="chart-tick-text-sm">
                {formatNum(bp)}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ── Tick generation ─────────────────────────────────────────────────────────

function generateTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const range = max - min;
  const step = niceStep(range / count);
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step * 0.01; t += step) {
    ticks.push(Math.round(t * 1e10) / 1e10);
  }
  return ticks;
}

function niceStep(rough: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  if (frac <= 1.5) return pow;
  if (frac <= 3) return 2 * pow;
  if (frac <= 7) return 5 * pow;
  return 10 * pow;
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function TableChart({ expr, width = 320, height = 200 }: TableChartProps) {
  try {
    if (!expr || expr.kind !== 'table') return null;
    if (expr.tableType === '1D') {
      return <LineChart1D expr={expr} width={width} height={height} />;
    }
    if (expr.tableType === '2D') {
      return <Heatmap2D expr={expr} width={width} height={height} />;
    }
    if (expr.tableType === '3D') {
      return <Heatmap3D expr={expr} width={width} height={Math.max(height, 250)} />;
    }
    return null;
  } catch (e) {
    console.warn('[TableChart] render error:', e);
    return <div style={{ padding: 8, color: '#999', fontSize: 11 }}>图表渲染错误</div>;
  }
}
