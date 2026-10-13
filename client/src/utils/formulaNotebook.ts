import type { Node } from '@xyflow/react';
import type { ExprNode } from '../types';

export interface FormulaLine { left: string; right: string; result: boolean }
export interface FormulaInput { symbol: string; path: string }
export interface FormulaSheet {
  id: string;
  sequence: number;
  name: string;
  output: string;
  channel: string;
  lines: FormulaLine[];
  inputs: FormulaInput[];
}

const subscripts = '₀₁₂₃₄₅₆₇₈₉';
const indexed = (letter: string, n: number) => letter + String(n).replace(/\d/g, digit => subscripts[Number(digit)]);
const binary: Record<string, string> = {
  difference: ' − ', quotient: ' ÷ ', pow: ' ^ ', mod: ' mod ',
  gt: ' > ', lt: ' < ', ge: ' ≥ ', le: ' ≤ ', eq: ' = ', nq: ' ≠ ',
};
const unary: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan', asin: 'asin', acos: 'acos',
  atan: 'atan', sqrt: '√', exp: 'exp', log: 'ln',
  fraction: 'frac', integer: 'floor',
};
const channelLabel = (name: string, fallback: string) =>
  name === '__JSBSIM_SYSTEM_TOP_LEVEL_FUNCTIONS__' ? '系统函数' : name || fallback;

/** A read-only derivation. One XML operator becomes one written line, so
 * nested operations keep their original order and every leaf remains visible. */
export function expressionToNotebook(expression: ExprNode, output: string): {
  lines: FormulaLine[]; inputs: FormulaInput[];
} {
  const lines: FormulaLine[] = [];
  const inputs: FormulaInput[] = [];
  const symbols = new Map<string, string>();
  const input = (path: string) => {
    if (!symbols.has(path)) {
      const symbol = indexed('u', inputs.length + 1);
      symbols.set(path, symbol);
      inputs.push({ symbol, path });
    }
    return symbols.get(path)!;
  };
  const write = (right: string) => {
    const symbol = indexed('t', lines.length + 1);
    lines.push({ left: symbol, right, result: false });
    return symbol;
  };
  const visit = (node: ExprNode | undefined | null): string => {
    if (!node) return '∅';
    const n = node as any;
    switch (node.kind) {
      case 'property': case 'function_ref': return input(String(n.name || ''));
      case 'value': return String(n.value);
      case 'pi': return 'π';
      case 'random': return write('random()');
      case 'urandom': return write('urandom()');
      case 'table': {
        const variables = [n.var1, n.var2, n.var3].filter((value): value is string => !!value).map(input);
        return write(`Table${n.tableType || ''}(${variables.join(', ')})`);
      }
      case 'sum': case 'product': case 'and': case 'or': case 'min': case 'max':
      case 'avg': case 'roundmultiple': {
        const values = (n.children || []).map(visit);
        if (node.kind === 'sum') return write(values.join(' + ') || '0');
        if (node.kind === 'product') return write(values.join(' × ') || '1');
        if (node.kind === 'and') return write(values.join(' ∧ '));
        if (node.kind === 'or') return write(values.join(' ∨ '));
        return write(`${node.kind}(${values.join(', ')})`);
      }
      case 'difference': case 'quotient': case 'pow': case 'mod':
      case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq': {
        const a = visit(n.left ?? n.base), b = visit(n.right ?? n.exponent);
        return write(a + binary[node.kind] + b);
      }
      case 'atan2': return write(`atan2(${visit(n.y)}, ${visit(n.x)})`);
      case 'ifthen': return write(`if ${visit(n.cond)} then ${visit(n.then)} else ${visit(n.else)}`);
      case 'switch': {
        const index = visit(n.index);
        const cases = (n.cases || []).map(visit);
        const fallback = visit(n.default);
        return write(`switch(${index}; ${cases.join(', ')}; default ${fallback})`);
      }
      case 'toradians': return write(`${visit(n.child)} × π / 180`);
      case 'todegrees': return write(`${visit(n.child)} × 180 / π`);
      case 'abs': return write(`|${visit(n.child)}|`);
      case 'not': return write(`¬(${visit(n.child)})`);
      default:
        if (unary[node.kind]) return write(`${unary[node.kind]}(${visit(n.child)})`);
        // Keep an unknown operation explicit rather than inventing a result.
        return write(`${node.kind}(${[...(n.children || []), n.child].filter(Boolean).map(visit).join(', ')})`);
    }
  };
  const answer = visit(expression);
  // The final line names the actual output. Avoid an extra alias for the root
  // operation while retaining every intermediate operation above it.
  if (lines.length && lines[lines.length - 1].left === answer) {
    lines[lines.length - 1] = { ...lines[lines.length - 1], left: output, result: true };
  } else {
    lines.push({ left: output, right: answer, result: true });
  }
  return { lines, inputs };
}

export function signalFormulaSheets(nodes: Node[]): FormulaSheet[] {
  const eligible = nodes.filter(node => node.data?.kind === 'component' &&
    (['function', 'fcs_function', 'aero_table'].includes(String(node.data.itemType)) &&
      !!(node.data.expression as ExprNode | undefined)?.kind ||
      node.data.itemType === 'integrator'));
  // The app appends a synthetic channel for top-level XML functions to keep
  // canvas node IDs stable. In the notebook, show those functions first.
  eligible.sort((a, b) => Number(!!(b.data.expression as ExprNode | undefined)?.kind) -
    Number(!!(a.data.expression as ExprNode | undefined)?.kind));
  return eligible.map((node, index) => {
    const data = node.data as Record<string, any>;
    const name = String(data.name || data.outputSignal || node.id);
    const output = name.split('/').pop() || name;
    if (data.itemType === 'integrator') {
      const path = String(data.inputs?.[0] || '');
      const coefficient = String(data.compProps?.c1?.value ?? data.compProps?.c1 ?? 'C₁');
      return { id: node.id, sequence: index + 1, name, output,
        channel: channelLabel(String(data.chName || ''), '飞控通道'),
        inputs: path ? [{ symbol: 'u₁', path }] : [],
        lines: [
          { left: 'H(s)', right: `${coefficient} / s`, result: false },
          { left: output, right: 'H(s) × u₁', result: true },
        ] };
    }
    return { id: node.id, sequence: index + 1, name, output,
      channel: channelLabel(String(data.chName || ''), '系统函数'),
      ...expressionToNotebook(data.expression as ExprNode, output) };
  });
}
