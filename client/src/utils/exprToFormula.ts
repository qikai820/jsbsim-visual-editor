import type { ExprNode } from '../types';

// Convert an ExprNode tree to a readable formula string
export function exprToFormula(expr: ExprNode | undefined | null): string {
  if (!expr || !expr.kind) return '';
  try {
    switch (expr.kind) {
      case 'value':
        return formatNum(expr.value);

      case 'property': {
        const parts = expr.name.split('/');
        const short = parts[parts.length - 1];
        return short;
      }

      case 'function_ref':
        return `${expr.name.split('/').pop()}()`;

      case 'table': {
        const v = expr.var1.split('/').pop() || '?';
        return `Table(${v})`;
      }

      case 'product': {
        const children = (expr as any).children || [];
        if (children.length === 0) return '0';
        const parts = children.map((c: ExprNode) => wrapIfNeeded(c, 'product'));
        return parts.join(' × ');
      }

      case 'sum': {
        const children = (expr as any).children || [];
        if (children.length === 0) return '0';
        const parts = children.map((c: ExprNode) => wrapIfNeeded(c, 'sum'));
        return parts.join(' + ');
      }

      case 'difference': {
        const left = wrapIfNeeded((expr as any).left, 'difference');
        const right = wrapIfNeeded((expr as any).right, 'difference');
        return `${left} − ${right}`;
      }

      case 'quotient': {
        const left = wrapIfNeeded((expr as any).left, 'quotient');
        const right = wrapIfNeeded((expr as any).right, 'quotient');
        return `${left} ÷ ${right}`;
      }

      case 'pow': {
        const base = wrapIfNeeded((expr as any).base, 'pow');
        const exp = wrapIfNeeded((expr as any).exponent, 'pow');
        return `${base}^${exp}`;
      }

      case 'sin': return `sin(${exprToFormula((expr as any).child)})`;
      case 'cos': return `cos(${exprToFormula((expr as any).child)})`;
      case 'tan': return `tan(${exprToFormula((expr as any).child)})`;
      case 'asin': return `asin(${exprToFormula((expr as any).child)})`;
      case 'acos': return `acos(${exprToFormula((expr as any).child)})`;
      case 'atan': return `atan(${exprToFormula((expr as any).child)})`;
      case 'sqrt': return `√(${exprToFormula((expr as any).child)})`;
      case 'abs': return `|${exprToFormula((expr as any).child)}|`;
      case 'exp': return `e^(${exprToFormula((expr as any).child)})`;

      case 'atan2': {
        const y = exprToFormula((expr as any).y);
        const x = exprToFormula((expr as any).x);
        return `atan2(${y}, ${x})`;
      }

      case 'ifthen': {
        const cond = exprToFormula((expr as any).cond);
        const then = exprToFormula((expr as any).then);
        const else_ = exprToFormula((expr as any).else);
        return `if ${cond} then ${else_}`;
      }

      case 'switch': {
        const idx = exprToFormula((expr as any).index);
        const cases = ((expr as any).cases || []).map((c: ExprNode) => exprToFormula(c));
        return `switch(${idx}) [${cases.join(', ')}]`;
      }

      case 'gt': return `${exprToFormula((expr as any).left)} > ${exprToFormula((expr as any).right)}`;
      case 'lt': return `${exprToFormula((expr as any).left)} < ${exprToFormula((expr as any).right)}`;
      case 'ge': return `${exprToFormula((expr as any).left)} ≥ ${exprToFormula((expr as any).right)}`;
      case 'le': return `${exprToFormula((expr as any).left)} ≤ ${exprToFormula((expr as any).right)}`;
      case 'eq': return `${exprToFormula((expr as any).left)} = ${exprToFormula((expr as any).right)}`;
      case 'nq': return `${exprToFormula((expr as any).left)} ≠ ${exprToFormula((expr as any).right)}`;

      default: return '?';
    }
  } catch {
    return '?';
  }
}

// Wrap child expression in parentheses if needed for correct precedence
function wrapIfNeeded(child: ExprNode, parentKind: string): string {
  const s = exprToFormula(child);
  if (!child || !child.kind) return s;
  // Add parens for lower-precedence operations inside higher-precedence parents
  if (parentKind === 'product' && (child.kind === 'sum' || child.kind === 'difference')) {
    return `(${s})`;
  }
  if ((parentKind === 'quotient' || parentKind === 'pow') && child.kind !== 'value' && child.kind !== 'property') {
    return `(${s})`;
  }
  if (parentKind === 'difference' && (child.kind === 'sum' || child.kind === 'difference')) {
    // Right side of subtraction needs parens
    return s;
  }
  return s;
}

function formatNum(n: number): string {
  if (isNaN(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 100000) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (n === 0) return '0';
  return n.toFixed(4);
}

// Render formula as HTML-like segments for styled display
export interface FormulaSegment {
  text: string;
  type: 'number' | 'property' | 'operator' | 'function' | 'table' | 'paren';
}

export function exprToSegments(expr: ExprNode | undefined | null): FormulaSegment[] {
  if (!expr || !expr.kind) return [];
  try {
    switch (expr.kind) {
      case 'value':
        return [{ text: formatNum(expr.value), type: 'number' }];

      case 'property': {
        const short = expr.name.split('/').pop() || expr.name;
        return [{ text: short, type: 'property' }];
      }

      case 'function_ref':
        return [{ text: `${expr.name.split('/').pop()}()`, type: 'function' }];

      case 'table': {
        const v = expr.var1.split('/').pop() || '?';
        return [{ text: `Table(${v})`, type: 'table' }];
      }

      case 'product': {
        const children = (expr as any).children || [];
        const segs: FormulaSegment[] = [];
        children.forEach((c: ExprNode, i: number) => {
          if (i > 0) segs.push({ text: ' × ', type: 'operator' });
          segs.push(...exprToSegments(c));
        });
        return segs;
      }

      case 'sum': {
        const children = (expr as any).children || [];
        const segs: FormulaSegment[] = [];
        children.forEach((c: ExprNode, i: number) => {
          if (i > 0) segs.push({ text: ' + ', type: 'operator' });
          segs.push(...exprToSegments(c));
        });
        return segs;
      }

      case 'difference':
        return [
          ...exprToSegments((expr as any).left),
          { text: ' − ', type: 'operator' },
          ...exprToSegments((expr as any).right),
        ];

      case 'quotient':
        return [
          ...exprToSegments((expr as any).left),
          { text: ' ÷ ', type: 'operator' },
          ...exprToSegments((expr as any).right),
        ];

      case 'pow':
        return [
          ...exprToSegments((expr as any).base),
          { text: '^', type: 'operator' },
          ...exprToSegments((expr as any).exponent),
        ];

      case 'sin': case 'cos': case 'tan':
      case 'asin': case 'acos': case 'atan':
      case 'sqrt': case 'exp':
        return [
          { text: expr.kind, type: 'function' },
          { text: '(', type: 'paren' },
          ...exprToSegments((expr as any).child),
          { text: ')', type: 'paren' },
        ];

      case 'abs':
        return [
          { text: '|', type: 'paren' },
          ...exprToSegments((expr as any).child),
          { text: '|', type: 'paren' },
        ];

      case 'atan2':
        return [
          { text: 'atan2(', type: 'function' },
          ...exprToSegments((expr as any).y),
          { text: ', ', type: 'operator' },
          ...exprToSegments((expr as any).x),
          { text: ')', type: 'paren' },
        ];

      case 'ifthen':
        return [
          { text: 'if ', type: 'function' },
          ...exprToSegments((expr as any).cond),
          { text: ' then ', type: 'function' },
          ...exprToSegments((expr as any).then),
          { text: ' else ', type: 'function' },
          ...exprToSegments((expr as any).else),
        ];

      default:
        return [{ text: exprToFormula(expr), type: 'operator' }];
    }
  } catch {
    return [{ text: '?', type: 'operator' }];
  }
}
