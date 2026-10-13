import type { ExprNode, ExprTable } from '../types';
import { multi, binary, unary, leaf, asNode } from './expressionKinds';

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const indent = (depth: number) => '  '.repeat(depth);

function tableToXml(table: ExprTable, depth: number): string {
  const p = indent(depth), q = indent(depth + 1);
  const vars = [`${q}<independentVar${table.tableType === '1D' ? '' : ' lookup="row"'}>${xmlEscape(table.var1)}</independentVar>`];
  if (table.tableType !== '1D') vars.push(`${q}<independentVar lookup="column">${xmlEscape(table.var2)}</independentVar>`);
  if (table.tableType === '3D' && table.var3) vars.push(`${q}<independentVar lookup="z">${xmlEscape(table.var3)}</independentVar>`);
  const dataBlock = (rows: number[][], breakPoint?: number) => {
    const attr = breakPoint === undefined ? '' : ` breakPoint="${breakPoint}"`;
    return `${q}<tableData${attr}>\n${rows.map(row => `${indent(depth + 2)}${row.join('  ')}`).join('\n')}\n${q}</tableData>`;
  };
  let data: string[];
  if (table.tableType === '1D') {
    data = [dataBlock(table.data.map((row, i) => [table.breakpoints1[i] ?? 0, row[0] ?? 0]))];
  } else if (table.tableType === '2D') {
    data = [dataBlock([table.breakpoints2, ...table.data.map((row, i) => [table.breakpoints1[i] ?? 0, ...row])])];
  } else {
    const rowsPerSlice = Math.max(1, table.breakpoints1.length);
    data = table.breakpoints3.map((bp, slice) => dataBlock([
      table.breakpoints2,
      ...table.breakpoints1.map((rowBp, row) => [rowBp, ...(table.data[slice * rowsPerSlice + row] || [])]),
    ], bp));
  }
  return `${p}<table>\n${[...vars, ...data].join('\n')}\n${p}</table>`;
}

function bodyXml(expr: ExprNode, depth: number): string {
  const n = expr as any, p = indent(depth), tag = expr.kind;
  if (tag === 'value') return `${p}<value>${expr.value}</value>`;
  if (tag === 'property' || tag === 'function_ref') return `${p}<property>${xmlEscape(n.name)}</property>`;
  if (tag === 'table') return tableToXml(expr as ExprTable, depth);
  if (leaf.has(tag)) return `${p}<${tag}/>`;
  let children: ExprNode[];
  if (multi.has(tag)) children = n.children;
  else if (tag === 'pow') children = [n.base, n.exponent];
  else if (tag === 'atan2') children = [n.y, n.x];
  else if (tag === 'ifthen') children = [n.cond, n.then, n.else];
  else if (tag === 'switch') children = [n.index, ...n.cases, n.default];
  else if (binary.has(tag)) children = [n.left, n.right];
  else if (unary.has(tag)) children = [n.child];
  else throw new Error(`XML 源码暂不支持 ${tag}`);
  return `${p}<${tag}>\n${children.map(child => bodyXml(child, depth + 1)).join('\n')}\n${p}</${tag}>`;
}

export function expressionToXmlText(expr: ExprNode): string {
  return `<function>\n${bodyXml(expr, 1)}\n</function>`;
}

const elements = (parent: Element): Element[] => Array.from(parent.children);
const text = (element: Element) => element.textContent?.trim() || '';
const number = (value: string): number => {
  if (!value || !Number.isFinite(Number(value))) throw new Error(`无效数值：${value || '空'}`);
  return Number(value);
};
const rows = (element: Element): number[][] => text(element).split(/\r?\n/).map(line => line.trim())
  .filter(Boolean).map(line => line.split(/\s+/).map(number));

function tableFromXml(element: Element): ExprTable {
  const vars = elements(element).filter(child => child.tagName === 'independentVar');
  const data = elements(element).filter(child => child.tagName === 'tableData');
  if (!vars.length || !data.length) throw new Error('查表需要 independentVar 和 tableData');
  const named = (lookup: string, index: number) => text(vars.find(v => v.getAttribute('lookup') === lookup) || vars[index] || vars[0]);
  const var1 = named('row', 0), var2 = vars.length > 1 ? named('column', 1) : '';
  const var3 = vars.length > 2 ? named('z', 2) : '';
  if (data.length > 1 || data.some(block => block.hasAttribute('breakPoint'))) {
    const breakpoints3 = data.map(block => number(block.getAttribute('breakPoint') || ''));
    const first = rows(data[0]);
    if (first.length < 2) throw new Error('3D 查表缺少列或数据行');
    const breakpoints2 = first[0].length === first[1]?.length ? first[0].slice(1) : first[0];
    const breakpoints1 = first.slice(1).map(row => row[0]);
    const values = data.flatMap(block => {
      const slice = rows(block);
      if (slice.length !== breakpoints1.length + 1 || slice.slice(1).some(row => row.length !== breakpoints2.length + 1))
        throw new Error('3D 查表各层行列数量不一致');
      return slice.slice(1).map(row => row.slice(1));
    });
    return { kind: 'table', tableType: '3D', var1, var2, var3, data: values,
      breakpoints1, breakpoints2, breakpoints3 };
  }
  const matrix = rows(data[0]);
  if (vars.length > 1) {
    if (matrix.length < 2 || !matrix[0].length) throw new Error('2D 查表缺少列或数据行');
    const breakpoints2 = matrix[0].length === matrix[1]?.length ? matrix[0].slice(1) : matrix[0];
    const body = matrix.slice(1);
    if (body.some(row => row.length !== breakpoints2.length + 1)) throw new Error('2D 查表行列数量不一致');
    return { kind: 'table', tableType: '2D', var1, var2, var3: '', data: body.map(row => row.slice(1)),
      breakpoints1: body.map(row => row[0]), breakpoints2, breakpoints3: [] };
  }
  if (!matrix.length || matrix.some(row => row.length !== 2)) throw new Error('1D 查表需要两列数值');
  return { kind: 'table', tableType: '1D', var1, var2: '', var3: '', data: matrix.map(row => [row[1]]),
    breakpoints1: matrix.map(row => row[0]), breakpoints2: [], breakpoints3: [] };
}

function fromElement(element: Element): ExprNode {
  const kind = element.tagName;
  const children = elements(element);
  if (kind === 'value' || kind === 'v') {
    if (children.length) throw new Error('value 不能包含子元素');
    return { kind: 'value', value: number(text(element)) };
  }
  if (kind === 'property' || kind === 'p') {
    if (children.length || !text(element)) throw new Error('property 需要非空属性路径');
    return { kind: 'property', name: text(element) };
  }
  if (kind === 'table') return tableFromXml(element);
  if (leaf.has(kind)) {
    if (children.length) throw new Error(`${kind} 不能包含子元素`);
    return asNode(kind);
  }
  if (!multi.has(kind) && !binary.has(kind) && !unary.has(kind) && kind !== 'ifthen' && kind !== 'switch')
    throw new Error(`不支持的 XML 运算：<${kind}>`);
  const args = children.map(fromElement);
  if (multi.has(kind)) {
    if (!args.length) throw new Error(`<${kind}> 至少需要一个子元素`);
    return asNode(kind, { children: args });
  }
  if (unary.has(kind)) {
    if (args.length !== 1) throw new Error(`<${kind}> 需要一个子元素`);
    return asNode(kind, { child: args[0] });
  }
  if (kind === 'ifthen') {
    if (args.length !== 3) throw new Error('<ifthen> 需要三个子元素');
    return { kind: 'ifthen', cond: args[0], then: args[1], else: args[2] };
  }
  if (kind === 'switch') {
    if (args.length < 2) throw new Error('<switch> 至少需要索引和默认值');
    return { kind: 'switch', index: args[0], cases: args.slice(1, -1), default: args[args.length - 1] };
  }
  if (args.length !== 2) throw new Error(`<${kind}> 需要两个子元素`);
  if (kind === 'pow') return { kind: 'pow', base: args[0], exponent: args[1] };
  if (kind === 'atan2') return { kind: 'atan2', y: args[0], x: args[1] };
  return asNode(kind, { left: args[0], right: args[1] });
}

export function parseXmlText(source: string): ExprNode {
  if (!source.trim()) throw new Error('XML 源码不能为空');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('XML 语法错误，请检查标签是否闭合');
  const root = document.documentElement;
  if (!root) throw new Error('缺少 XML 根元素');
  if (root.tagName !== 'function') return fromElement(root);
  const children = elements(root).filter(child => child.tagName !== 'description');
  if (children.length !== 1) throw new Error('<function> 内需要且只能有一个表达式根元素');
  return fromElement(children[0]);
}
