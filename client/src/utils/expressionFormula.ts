import type { ExprNode, ExprTable } from '../types';
import { multi, binary, unary, leaf, asNode } from './expressionKinds';

/** Editable formula syntax uses full property paths in braces, e.g. {velocities/u-fps}. */
export function expressionToFormulaText(expr: ExprNode): string {
  const n = expr as any;
  const show = (child: ExprNode) => expressionToFormulaText(child);
  switch (expr.kind) {
    case 'value': return String(expr.value);
    case 'property': return `{${expr.name}}`;
    case 'function_ref': return `ref({${expr.name}})`;
    case 'table': return `table(${JSON.stringify(expr)})`;
    case 'pi': return 'pi';
    case 'random': case 'urandom': return `${expr.kind}()`;
    case 'sum': return `(${expr.children.map(show).join(' + ')})`;
    case 'product': return `(${expr.children.map(show).join(' × ')})`;
    case 'difference': return `(${show(expr.left)} - ${show(expr.right)})`;
    case 'quotient': return `(${show(expr.left)} ÷ ${show(expr.right)})`;
    case 'pow': return `(${show(expr.base)} ^ ${show(expr.exponent)})`;
    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq': {
      const symbol: Record<string, string> = { gt: '>', lt: '<', ge: '>=', le: '<=', eq: '==', nq: '!=' };
      return `(${show(n.left)} ${symbol[expr.kind]} ${show(n.right)})`;
    }
    case 'atan2': return `atan2(${show(expr.y)}, ${show(expr.x)})`;
    case 'ifthen': return `ifthen(${show(expr.cond)}, ${show(expr.then)}, ${show(expr.else)})`;
    case 'switch': return `switch(${[expr.index, ...expr.cases, expr.default].map(show).join(', ')})`;
    case 'min': case 'max': case 'avg': case 'and': case 'or': case 'roundmultiple':
      return `${expr.kind}(${expr.children.map(show).join(', ')})`;
    case 'mod': return `mod(${show(expr.left)}, ${show(expr.right)})`;
    default:
      if (unary.has(expr.kind)) return `${expr.kind}(${show(n.child)})`;
      throw new Error(`手写公式暂不支持 ${expr.kind}`);
  }
}

function checkedTable(value: unknown): ExprTable {
  const table = value as Partial<ExprTable> | null;
  if (!table || table.kind !== 'table' || !['1D', '2D', '3D'].includes(String(table.tableType)) ||
      typeof table.var1 !== 'string' || typeof table.var2 !== 'string' || typeof table.var3 !== 'string' ||
      !Array.isArray(table.data) || !table.data.every(row => Array.isArray(row) && row.every(Number.isFinite)) ||
      !Array.isArray(table.breakpoints1) || !table.breakpoints1.every(Number.isFinite) ||
      !Array.isArray(table.breakpoints2) || !table.breakpoints2.every(Number.isFinite) ||
      !Array.isArray(table.breakpoints3) || !table.breakpoints3.every(Number.isFinite)) {
    throw new Error('查表数据格式无效');
  }
  return table as ExprTable;
}

class FormulaParser {
  private pos = 0;
  constructor(private readonly source: string) {}
  private space() { while (/\s/.test(this.source[this.pos] || '')) this.pos++; }
  private at(value: string) { this.space(); return this.source.startsWith(value, this.pos); }
  private take(value: string) {
    if (!this.at(value)) throw new Error(`第 ${this.pos + 1} 个字符附近需要 ${value}`);
    this.pos += value.length;
  }
  private name(): string {
    this.space();
    const found = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.source.slice(this.pos));
    if (!found) throw new Error(`第 ${this.pos + 1} 个字符附近需要函数名或属性`);
    this.pos += found[0].length;
    return found[0];
  }
  private property(): ExprNode {
    this.take('{');
    const end = this.source.indexOf('}', this.pos);
    if (end < 0) throw new Error('属性路径缺少右花括号 }');
    const name = this.source.slice(this.pos, end).trim();
    if (!name) throw new Error('属性路径不能为空');
    this.pos = end + 1;
    return { kind: 'property', name };
  }
  private table(): ExprNode {
    this.space();
    const start = this.pos;
    let quoted = false, escaped = false, braces = 0, brackets = 0;
    while (this.pos < this.source.length) {
      const c = this.source[this.pos];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
      else if (c === ')' && braces === 0 && brackets === 0) break;
      this.pos++;
    }
    let object: unknown;
    try { object = JSON.parse(this.source.slice(start, this.pos)); }
    catch { throw new Error('table(...) 内需要完整的查表 JSON'); }
    this.take(')');
    return checkedTable(object);
  }
  private call(kind: string, args: ExprNode[]): ExprNode {
    if (kind === 'ref') {
      if (args.length !== 1 || args[0].kind !== 'property') throw new Error('ref() 需要一个 {属性路径}');
      return { kind: 'function_ref', name: args[0].name };
    }
    if (leaf.has(kind)) {
      if (args.length) throw new Error(`${kind}() 不接受参数`);
      return asNode(kind);
    }
    if (unary.has(kind)) {
      if (args.length !== 1) throw new Error(`${kind}() 需要一个参数`);
      return asNode(kind, { child: args[0] });
    }
    if (multi.has(kind)) {
      if (!args.length) throw new Error(`${kind}() 至少需要一个参数`);
      return asNode(kind, { children: args });
    }
    if (binary.has(kind)) {
      if (args.length !== 2) throw new Error(`${kind}() 需要两个参数`);
      if (kind === 'pow') return { kind: 'pow', base: args[0], exponent: args[1] };
      if (kind === 'atan2') return { kind: 'atan2', y: args[0], x: args[1] };
      return asNode(kind, { left: args[0], right: args[1] });
    }
    if (kind === 'ifthen') {
      if (args.length !== 3) throw new Error('ifthen() 需要条件、真值、假值');
      return { kind: 'ifthen', cond: args[0], then: args[1], else: args[2] };
    }
    if (kind === 'switch') {
      if (args.length < 2) throw new Error('switch() 至少需要索引和默认值');
      return { kind: 'switch', index: args[0], cases: args.slice(1, -1), default: args[args.length - 1] };
    }
    throw new Error(`未知函数 ${kind}()`);
  }
  private primary(): ExprNode {
    this.space();
    if (this.at('{')) return this.property();
    if (this.at('(')) { this.take('('); const result = this.expression(0); this.take(')'); return result; }
    if (this.at('-')) {
      this.take('-');
      const child = this.expression(35);
      return child.kind === 'value' ? { kind: 'value', value: -child.value }
        : { kind: 'product', children: [{ kind: 'value', value: -1 }, child] };
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.pos));
    if (number) {
      this.pos += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error('数值超出范围');
      return { kind: 'value', value };
    }
    const kind = this.name();
    if (kind === 'pi' && !this.at('(')) return { kind: 'pi' };
    this.take('(');
    if (kind === 'table') return this.table();
    const args: ExprNode[] = [];
    if (!this.at(')')) {
      do {
        args.push(this.expression(0));
        if (!this.at(',')) break;
        this.take(',');
      } while (true);
    }
    this.take(')');
    return this.call(kind, args);
  }
  private operator(): { symbol: string; precedence: number } | null {
    this.space();
    for (const [symbol, precedence] of [['>=', 10], ['<=', 10], ['==', 10], ['!=', 10],
      ['>', 10], ['<', 10], ['+', 20], ['-', 20], ['×', 30], ['*', 30], ['÷', 30], ['/', 30], ['^', 40]] as const) {
      if (this.source.startsWith(symbol, this.pos)) return { symbol, precedence };
    }
    return null;
  }
  private expression(min: number): ExprNode {
    let left = this.primary();
    while (true) {
      const op = this.operator();
      if (!op || op.precedence < min) break;
      this.pos += op.symbol.length;
      const right = this.expression(op.precedence + (op.symbol === '^' ? 0 : 1));
      if (op.symbol === '+' || op.symbol === '×' || op.symbol === '*') {
        const kind = op.symbol === '+' ? 'sum' : 'product';
        left = asNode(kind, { children: left.kind === kind ? [...(left as any).children, right] : [left, right] });
      } else if (op.symbol === '-') left = { kind: 'difference', left, right };
      else if (op.symbol === '÷' || op.symbol === '/') left = { kind: 'quotient', left, right };
      else if (op.symbol === '^') left = { kind: 'pow', base: left, exponent: right };
      else {
        const kind: Record<string, string> = { '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le', '==': 'eq', '!=': 'nq' };
        left = asNode(kind[op.symbol], { left, right });
      }
    }
    return left;
  }
  parse(): ExprNode {
    const result = this.expression(0);
    this.space();
    if (this.pos !== this.source.length) throw new Error(`第 ${this.pos + 1} 个字符附近有未识别内容`);
    return result;
  }
}

export function parseFormulaText(source: string): ExprNode {
  if (!source.trim()) throw new Error('公式不能为空');
  return new FormulaParser(source).parse();
}
