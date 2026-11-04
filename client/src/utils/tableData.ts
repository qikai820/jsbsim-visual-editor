import type { ExprNode, ExprTable } from '../types';

export type TableAxis = 0 | 1 | 2;
export type TablePoint = [number, number, number]; // row, column, layer
export const AXIS_NAMES = ['行', '列', '层'] as const;
const BP_KEYS = ['breakpoints1', 'breakpoints2', 'breakpoints3'] as const;
const VAR_KEYS = ['var1', 'var2', 'var3'] as const;

// Compact enough for a grid, without rounding small coefficients to zero.
// Editing and serialization always use the original full-precision number.
export const formatTableNumber = (value: number) => Number.isFinite(value) ? String(Number(value.toPrecision(9))) : '—';

export const axisCount = (table: ExprTable) => table.tableType === '1D' ? 1 : table.tableType === '2D' ? 2 : 3;
export const axisBreakpoints = (table: ExprTable, axis: TableAxis) => table[BP_KEYS[axis]];
export const axisVariable = (table: ExprTable, axis: TableAxis) => table[VAR_KEYS[axis]];
export const axisLabel = (table: ExprTable, axis: TableAxis) =>
  axisVariable(table, axis).split('/').filter(Boolean).pop() || AXIS_NAMES[axis];

export function tableValue(table: ExprTable, [row, column, layer]: TablePoint): number | undefined {
  return table.data[(table.tableType === '3D' ? layer * table.breakpoints1.length : 0) + row]?.[column];
}

export function setTableValue(table: ExprTable, point: TablePoint, value: number): ExprTable {
  const data = table.data.map(row => [...row]);
  const row = (table.tableType === '3D' ? point[2] * table.breakpoints1.length : 0) + point[0];
  data[row] = [...(data[row] || [])];
  data[row][point[1]] = value;
  return { ...table, data };
}

export function setAxisBreakpoint(table: ExprTable, axis: TableAxis, index: number, value: number): ExprTable {
  const bp = [...axisBreakpoints(table, axis)];
  bp[index] = value;
  return { ...table, [BP_KEYS[axis]]: bp };
}

export function tableSlice(table: ExprTable, fixedAxis: TableAxis = 2, slice = 0) {
  const free = ([0, 1, 2] as TableAxis[]).filter(axis => axis < axisCount(table) &&
    (table.tableType !== '3D' || axis !== fixedAxis));
  const rowAxis = free[0];
  const columnAxis = free[1];
  const rows = rowAxis === undefined ? [] : axisBreakpoints(table, rowAxis);
  const columns = columnAxis === undefined ? [0] : axisBreakpoints(table, columnAxis);
  const pointAt = (row: number, column: number): TablePoint => {
    const point: TablePoint = [0, 0, 0];
    if (table.tableType === '3D') point[fixedAxis] = slice;
    if (rowAxis !== undefined) point[rowAxis] = row;
    if (columnAxis !== undefined) point[columnAxis] = column;
    return point;
  };
  return { rowAxis, columnAxis, rows, columns, pointAt,
    values: rows.map((_, row) => columns.map((_, col) => tableValue(table, pointAt(row, col)))) };
}

// Appending duplicates the boundary values, keeping every other layer intact.
// Removing a breakpoint removes the matching row/column in ALL layers.
export function resizeTableAxis(table: ExprTable, axis: TableAxis, removeIndex?: number): ExprTable {
  const previous = axisBreakpoints(table, axis);
  if (removeIndex !== undefined && (previous.length <= 1 || removeIndex < 0 || removeIndex >= previous.length)) return table;
  const last = previous[previous.length - 1] ?? -1;
  const step = previous.length > 1 ? last - previous[previous.length - 2] : 1;
  const bp = removeIndex === undefined
    ? [...previous, last + (step > 0 && Number.isFinite(step) ? step : 1)]
    : previous.filter((_, index) => index !== removeIndex);
  const next = { ...table, [BP_KEYS[axis]]: bp };
  const sourceIndex = (index: number) => removeIndex === undefined
    ? Math.min(index, Math.max(0, previous.length - 1))
    : index >= removeIndex ? index + 1 : index;
  const layers = table.tableType === '3D' ? next.breakpoints3.length : 1;
  const columns = table.tableType === '1D' ? 1 : next.breakpoints2.length;
  next.data = Array.from({ length: layers }, (_, layer) => next.breakpoints1.map((_, row) =>
    Array.from({ length: columns }, (_, col) => {
      const point: TablePoint = [row, col, layer];
      point[axis] = sourceIndex(point[axis]);
      return tableValue(table, point) ?? 0;
    }))).flat();
  return next;
}

export function convertTableDimension(table: ExprTable, type: ExprTable['tableType'], selected: TablePoint): ExprTable {
  if (type === table.tableType) return table;
  const next = { ...table, tableType: type };
  if (type === '1D') {
    next.data = table.breakpoints1.map((_, row) => [tableValue(table, [row, selected[1], selected[2]]) ?? 0]);
    next.breakpoints2 = []; next.breakpoints3 = []; next.var2 = ''; next.var3 = '';
  } else {
    next.breakpoints2 = table.tableType === '1D' ? [0, 1] : [...table.breakpoints2];
    next.data = table.breakpoints1.map((_, row) => next.breakpoints2.map((_, col) =>
      tableValue(table, [row, table.tableType === '1D' ? 0 : col, selected[2]]) ?? 0));
    if (type === '3D') {
      next.breakpoints3 = [0, 1];
      next.data = [...next.data, ...next.data.map(row => [...row])];
    } else { next.breakpoints3 = []; next.var3 = ''; }
  }
  return next;
}

export function validateTable(table: ExprTable): string[] {
  const errors: string[] = [];
  for (let i = 0; i < axisCount(table); i++) {
    const axis = i as TableAxis, bp = axisBreakpoints(table, axis);
    if (!axisVariable(table, axis).trim()) errors.push(`${AXIS_NAMES[axis]}自变量不能为空`);
    if (!bp.length) errors.push(`${AXIS_NAMES[axis]}轴至少需要一个断点`);
    if (bp.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= bp[index - 1]))) {
      errors.push(`${AXIS_NAMES[axis]}断点必须是有限数值，且严格递增（不能重复）`);
    }
  }
  const expectedRows = table.breakpoints1.length * (table.tableType === '3D' ? table.breakpoints3.length : 1);
  const expectedColumns = table.tableType === '1D' ? 1 : table.breakpoints2.length;
  if (table.data.length !== expectedRows || table.data.some(row => row.length !== expectedColumns || !row.every(Number.isFinite))) {
    errors.push('数据数量与断点不一致，或包含无效数值；请检查数据网格');
  }
  return errors;
}

export function tableRange(table: ExprTable): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const row of table.data) for (const value of row) {
    if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  return min === Infinity ? [0, 1] : [min, max];
}

export function valueColor(value: number, min: number, max: number, alpha = 1) {
  const t = max === min ? .5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  // A continuous blue → teal → gold scale, shared by every slice and the grid.
  const stops = [[49, 92, 190], [24, 159, 170], [83, 190, 149], [242, 195, 85], [231, 124, 61]];
  const position = t * (stops.length - 1), index = Math.min(stops.length - 2, Math.floor(position));
  const rgb = stops[index].map((v, i) => Math.round(v + (stops[index + 1][i] - v) * (position - index)));
  return `rgba(${rgb.join(',')},${alpha})`;
}

export function pasteTableValues(table: ExprTable, fixedAxis: TableAxis, slice: number,
  startRow: number, startColumn: number, text: string): ExprTable {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  if (!text.trim()) throw new Error('粘贴内容为空');
  const values = lines.map(line => (line.includes('\t') ? line.split('\t')
    : /[,;]/.test(line) ? line.split(/[,;]/) : line.trim().split(/\s+/)).map(value => {
    const trimmed = value.trim();
    if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(Number(trimmed))) {
      throw new Error('粘贴失败：只能包含有限数值，不能有空单元格');
    }
    return Number(trimmed);
  }));
  if (values.some(row => row.length !== values[0].length)) throw new Error('粘贴失败：每一行的列数必须相同');
  const view = tableSlice(table, fixedAxis, slice);
  if (startRow + values.length > view.rows.length || startColumn + values[0].length > view.columns.length) {
    throw new Error('粘贴范围超出当前切片，请先添加行或列；原数据未修改');
  }
  const data = table.data.map(row => [...row]);
  for (const [r, row] of values.entries()) for (const [c, value] of row.entries()) {
    const [ri, ci, layer] = view.pointAt(startRow + r, startColumn + c);
    const index = (table.tableType === '3D' ? layer * table.breakpoints1.length : 0) + ri;
    data[index] = [...(data[index] || [])]; data[index][ci] = value;
  }
  return { ...table, data };
}

// Return every table in document order, together with an immutable replacement
// function. This also handles pow/ifthen/switch and multiple tables per product.
export function expressionTables(expression: ExprNode): { table: ExprTable; replace: (table: ExprTable) => ExprNode }[] {
  if (expression.kind === 'table') return [{ table: expression, replace: table => table }];
  const result: ReturnType<typeof expressionTables> = [];
  for (const [key, value] of Object.entries(expression)) {
    const add = (child: ExprNode, index?: number) => {
      if (!child || typeof child !== 'object' || !('kind' in child)) return;
      for (const entry of expressionTables(child)) result.push({ table: entry.table, replace: table => ({
        ...expression, [key]: index === undefined ? entry.replace(table)
          : value.map((item: ExprNode, i: number) => i === index ? entry.replace(table) : item),
      }) as ExprNode });
    };
    if (Array.isArray(value)) value.forEach((child, index) => add(child, index));
    else add(value as ExprNode);
  }
  return result;
}
