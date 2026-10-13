import type { ExprNode } from '../types';

export const multi = new Set(['sum', 'product', 'min', 'max', 'avg', 'and', 'or', 'roundmultiple']);
export const binary = new Set(['difference', 'quotient', 'pow', 'mod', 'gt', 'lt', 'ge', 'le', 'eq', 'nq', 'atan2']);
export const unary = new Set(['abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'exp',
  'fraction', 'integer', 'toradians', 'todegrees', 'not']);
export const leaf = new Set(['pi', 'random', 'urandom']);

export const asNode = (kind: string, fields: Record<string, unknown> = {}): ExprNode =>
  ({ kind, ...fields } as ExprNode);
