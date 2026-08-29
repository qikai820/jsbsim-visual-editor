import { useMemo, useState } from 'react';
import type { ExprNode, ExprTable } from '../../types';
import TableChart from './TableChart';

interface LutTablePreviewProps {
  title: string;
  expression?: ExprNode;
  onClose: () => void;
}

function findTable(expr: ExprNode | undefined): ExprTable | undefined {
  if (!expr) return undefined;
  if (expr.kind === 'table') return expr;
  const value = expr as any;
  for (const child of value.children || []) {
    const table = findTable(child);
    if (table) return table;
  }
  return findTable(value.left) || findTable(value.right) || findTable(value.child);
}

function label(value: string, fallback: string) {
  return value?.split('/').filter(Boolean).pop() || fallback;
}

function fmt(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) return '—';
  return Math.abs(value) >= 1000 ? value.toFixed(0) : Number(value.toFixed(5)).toString();
}

function DimensionIcon({ type }: { type: ExprTable['tableType'] }) {
  if (type === '1D') return <span className="lut-dimension-icon lut-dimension-1d">╱╲</span>;
  if (type === '2D') return <span className="lut-dimension-icon lut-dimension-2d">▦</span>;
  return <span className="lut-dimension-icon lut-dimension-3d">◇</span>;
}

function DataGrid({ table }: { table: ExprTable }) {
  const [slice, setSlice] = useState(0);
  const bp1 = table.breakpoints1 || [];
  const bp2 = table.breakpoints2 || [];
  const bp3 = table.breakpoints3 || [];
  const rows = table.data || [];
  const is1D = table.tableType === '1D';
  const is3D = table.tableType === '3D';
  const sliceRows = is3D ? rows.slice(slice * bp1.length, (slice + 1) * bp1.length) : rows;

  if (is1D) {
    return <table className="lut-data-grid"><thead><tr><th>{label(table.var1, 'x')}</th><th>输出</th></tr></thead>
      <tbody>{bp1.map((x, i) => <tr key={i}><th>{fmt(x)}</th><td>{fmt(rows[i]?.[0])}</td></tr>)}</tbody></table>;
  }

  return <>
    {is3D && <div className="lut-slice-picker"><span>{label(table.var3, 'z')} 切片</span>
      {bp3.map((value, index) => <button key={index} className={slice === index ? 'active' : ''} onClick={() => setSlice(index)}>{fmt(value)}</button>)}
    </div>}
    <table className="lut-data-grid"><thead><tr><th>{label(table.var1, '行')} ＼ {label(table.var2, '列')} →</th>
      {bp2.map((x, i) => <th key={i}>{fmt(x)}</th>)}</tr></thead>
      <tbody>{bp1.map((x, ri) => <tr key={ri}><th>{fmt(x)}</th>{bp2.map((_, ci) => <td key={ci}>{fmt(sliceRows[ri]?.[ci])}</td>)}</tr>)}</tbody>
    </table>
  </>;
}

export default function LutTablePreview({ title, expression, onClose }: LutTablePreviewProps) {
  const table = useMemo(() => findTable(expression), [expression]);
  if (!table) return null;
  const dimensions = table.tableType === '1D' ? 1 : table.tableType === '2D' ? 2 : 3;
  const size = `${table.breakpoints1.length} × ${table.tableType === '1D' ? 1 : table.breakpoints2.length}${table.tableType === '3D' ? ` × ${table.breakpoints3.length}` : ''}`;

  return <div className="lut-preview-overlay" onMouseDown={onClose}>
    <section className="lut-preview-dialog" onMouseDown={e => e.stopPropagation()}>
      <header className="lut-preview-header"><div><b>▦ LUT 插值表</b><span>{title}</span></div><button onClick={onClose} title="关闭">×</button></header>
      <div className="lut-preview-summary"><div className="lut-dimension-card"><DimensionIcon type={table.tableType} /><div><b>{dimensions}D 插值</b><span>{size} 个断点</span></div></div>
        <div className="lut-vars"><span>x: {label(table.var1, 'var1')}</span>{dimensions > 1 && <span>y: {label(table.var2, 'var2')}</span>}{dimensions > 2 && <span>z: {label(table.var3, 'var3')}</span>}</div></div>
      <div className="lut-preview-body"><div className="lut-chart-panel"><div className="lut-panel-label">多维预览</div><TableChart expr={table} width={420} height={260} /></div>
        <div className="lut-grid-panel"><div className="lut-panel-label">断点与数据表</div><div className="lut-grid-scroll"><DataGrid table={table} /></div></div></div>
    </section>
  </div>;
}
