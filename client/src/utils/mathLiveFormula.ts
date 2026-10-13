import { ComputeEngine } from '@cortex-js/compute-engine';
import type { ExprNode } from '../types';

const engine = new ComputeEngine();
export interface MathLiveFormula { latex: string; signals: string[] }

const greekSymbols: Record<string, string> = {
  alpha: 'α', beta: 'β', EulerGamma: 'γ', phi: 'φ', GoldenRatio: 'φ',
  theta: 'θ', thetaSymbol: 'θ', psi: 'ψ', delta: 'δ', rho: 'ρ',
};

function symbolName(value: string): string | null {
  if (value === 'CatalanConstant') return 'G';
  if (/^[A-Za-z]$/.test(value)) return value;
  return greekSymbols[value] || null;
}

function parseExpression(latex: string): unknown {
  // MathLive shortens u_{1} to u_1 when editing. Compute Engine otherwise
  // reads a following + as part of that unbraced subscript.
  return engine.parse(latex.replace(/\bu_(\d+)/g, 'u_{$1}'), { canonical: false }).json;
}

/** List the named variables that need a signal binding in the formula. */
export function mathLiveSymbols(latex: string): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      const name = symbolName(value);
      if (name) found.add(name);
      return;
    }
    if (!Array.isArray(value)) return;
    if (value[0] === 'At' && value[1] === 'u') return;
    value.slice(1).forEach(visit);
  };
  visit(parseExpression(latex));
  return [...found];
}

/** The MathLive document uses u₁, u₂... so property paths remain unambiguous. */
export function expressionToMathLive(expr: ExprNode): MathLiveFormula {
  const signals: string[] = [];
  const symbol = (path: string) => {
    let index = signals.indexOf(path);
    if (index < 0) { signals.push(path); index = signals.length - 1; }
    return `u_{${index + 1}}`;
  };
  const show = (node: ExprNode): string => {
    const n = node as any;
    switch (node.kind) {
      case 'value': return String(node.value);
      case 'property': return symbol(node.name);
      case 'pi': return '\\pi';
      case 'sum': return `\\left(${node.children.map(show).join('+')}\\right)`;
      case 'product': return `\\left(${node.children.map(show).join('\\cdot ')}\\right)`;
      case 'difference': return `\\left(${show(node.left)}-${show(node.right)}\\right)`;
      case 'quotient': return `\\frac{${show(node.left)}}{${show(node.right)}}`;
      case 'pow': return `{${show(node.base)}}^{${show(node.exponent)}}`;
      case 'min': case 'max': return `\\${node.kind}\\left(${node.children.map(show).join(',')}\\right)`;
      case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq': {
        const op: Record<string, string> = { gt: '>', lt: '<', ge: '\\ge', le: '\\le', eq: '=', nq: '\\ne' };
        return `${show(node.left)}${op[node.kind]}${show(node.right)}`;
      }
      case 'abs': return `\\left|${show(node.child)}\\right|`;
      case 'sqrt': return `\\sqrt{${show(node.child)}}`;
      case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan': case 'exp':
        return `\\${node.kind}\\left(${show(n.child)}\\right)`;
      default: throw new Error(`MathLive 暂不支持 ${node.kind}；可使用画布或 XML 源码编辑`);
    }
  };
  return { latex: show(expr), signals };
}

export function parseMathLive(latex: string, signals: string[], symbolBindings: Record<string, string> = {}): ExprNode {
  const parsed = parseExpression(latex);
  const convert = (value: unknown): ExprNode => {
    if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'value', value };
    if (value === 'Pi') return { kind: 'pi' };
    if (typeof value === 'string') {
      const name = symbolName(value);
      if (name) {
        const path = symbolBindings[name]?.trim();
        if (!path) throw new Error(`${name} 未绑定信号`);
        return { kind: 'property', name: path };
      }
    }
    if (typeof value === 'object' && value && !Array.isArray(value) && 'num' in value) {
      const numeric = Number((value as { num: string }).num);
      if (Number.isFinite(numeric)) return { kind: 'value', value: numeric };
    }
    if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error('公式中有无法识别的符号');
    const [op, ...args] = value;
    if (op === 'Delimiter' && args.length >= 1) return convert(args[0]);
    if (op === 'At' && args[0] === 'u') {
      const number = Number(args[1]);
      const index = number - 1;
      if (!Number.isInteger(index) || !signals[index]) throw new Error(`u${Number.isFinite(number) ? number : '?'} 未绑定信号`);
      return { kind: 'property', name: signals[index] };
    }
    if (op === 'Negate' && args.length === 1) {
      const child = convert(args[0]);
      if (child.kind === 'value') return { kind: 'value', value: -child.value };
      return { kind: 'product', children: [{ kind: 'value', value: -1 }, child] };
    }
    if (op === 'Add' && args.length >= 2) return { kind: 'sum', children: args.map(convert) };
    if (['Multiply', 'InvisibleOperator'].includes(op) && args.length >= 2) return { kind: 'product', children: args.map(convert) };
    if (op === 'Subtract' && args.length === 2) return { kind: 'difference', left: convert(args[0]), right: convert(args[1]) };
    if (op === 'Divide' && args.length === 2) return { kind: 'quotient', left: convert(args[0]), right: convert(args[1]) };
    if (op === 'Power' && args.length === 2) return { kind: 'pow', base: convert(args[0]), exponent: convert(args[1]) };
    const multi: Record<string, 'min' | 'max'> = { Min: 'min', Max: 'max' };
    if (multi[op] && args.length) return { kind: multi[op], children: args.map(convert) };
    const comparison: Record<string, 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'nq'> = {
      Greater: 'gt', Less: 'lt', GreaterEqual: 'ge', LessEqual: 'le', Equal: 'eq', NotEqual: 'nq',
    };
    if (comparison[op] && args.length === 2) return { kind: comparison[op], left: convert(args[0]), right: convert(args[1]) };
    const unary: Record<string, 'abs' | 'sqrt' | 'sin' | 'cos' | 'tan' | 'asin' | 'acos' | 'atan' | 'exp'> = {
      Abs: 'abs', Sqrt: 'sqrt', Sin: 'sin', Cos: 'cos', Tan: 'tan', Arcsin: 'asin',
      Arccos: 'acos', Arctan: 'atan', Exp: 'exp',
    };
    if (unary[op] && args.length === 1) return { kind: unary[op], child: convert(args[0]) };
    throw new Error(`MathLive 暂不支持 ${op}；可使用画布或 XML 源码编辑`);
  };
  return convert(parsed);
}
