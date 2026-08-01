import type { Node, Edge } from '@xyflow/react';
import { orderRanksByBarycenter } from './layoutUtils';
import type {
  ExprNode, ExprValue, ExprProperty, ExprFunctionRef, ExprTable,
  ExprProduct, ExprSum, ExprDifference, ExprQuotient, ExprPow,
  ExprUnary, ExprAtan2, ExprIfThen, ExprSwitch, ExprComparison,
  UnaryOp, ComparisonOp,
} from '../types';

// ── Block definitions ──────────────────────────────────────────────────────

export interface BlockDef {
  kind: string;
  label: string;
  category: 'input' | 'math' | 'func' | 'logic' | 'table';
  color: string;
  icon: string;
  inputCount: number | 'variable'; // number of input ports
  outputCount: number;
}

export const BLOCK_DEFS: Record<string, BlockDef> = {
  value:         { kind: 'value',         label: '常数',       category: 'input', color: '#10b981', icon: '🔢', inputCount: 0, outputCount: 1 },
  property:      { kind: 'property',      label: '属性',       category: 'input', color: '#3b82f6', icon: '📌', inputCount: 0, outputCount: 1 },
  function_ref:  { kind: 'function_ref',  label: '函数引用',   category: 'input', color: '#8b5cf6', icon: '🔗', inputCount: 0, outputCount: 1 },
  table:         { kind: 'table',         label: '查表',       category: 'table', color: '#f59e0b', icon: '📊', inputCount: 0, outputCount: 1 },
  product:       { kind: 'product',       label: '乘积 ×',     category: 'math',  color: '#ef4444', icon: '✕',  inputCount: 'variable', outputCount: 1 },
  sum:           { kind: 'sum',           label: '求和 +',     category: 'math',  color: '#f97316', icon: '∑',  inputCount: 'variable', outputCount: 1 },
  difference:    { kind: 'difference',    label: '差 −',       category: 'math',  color: '#e11d48', icon: '−',  inputCount: 2, outputCount: 1 },
  quotient:      { kind: 'quotient',      label: '商 ÷',       category: 'math',  color: '#dc2626', icon: '÷',  inputCount: 2, outputCount: 1 },
  pow:           { kind: 'pow',           label: '幂 ^',       category: 'math',  color: '#be123c', icon: '^',  inputCount: 2, outputCount: 1 },
  abs:           { kind: 'abs',           label: '绝对值',     category: 'func',  color: '#7c3aed', icon: '|x|', inputCount: 1, outputCount: 1 },
  sin:           { kind: 'sin',           label: 'sin',        category: 'func',  color: '#7c3aed', icon: 'sin', inputCount: 1, outputCount: 1 },
  cos:           { kind: 'cos',           label: 'cos',        category: 'func',  color: '#7c3aed', icon: 'cos', inputCount: 1, outputCount: 1 },
  tan:           { kind: 'tan',           label: 'tan',        category: 'func',  color: '#7c3aed', icon: 'tan', inputCount: 1, outputCount: 1 },
  asin:          { kind: 'asin',          label: 'asin',       category: 'func',  color: '#7c3aed', icon: 'asin', inputCount: 1, outputCount: 1 },
  acos:          { kind: 'acos',          label: 'acos',       category: 'func',  color: '#7c3aed', icon: 'acos', inputCount: 1, outputCount: 1 },
  atan:          { kind: 'atan',          label: 'atan',       category: 'func',  color: '#7c3aed', icon: 'atan', inputCount: 1, outputCount: 1 },
  sqrt:          { kind: 'sqrt',          label: '√',          category: 'func',  color: '#7c3aed', icon: '√',  inputCount: 1, outputCount: 1 },
  exp:           { kind: 'exp',           label: 'exp',        category: 'func',  color: '#7c3aed', icon: 'eˣ', inputCount: 1, outputCount: 1 },
  atan2:         { kind: 'atan2',         label: 'atan2',      category: 'func',  color: '#6d28d9', icon: 'atan2', inputCount: 2, outputCount: 1 },
  gt:            { kind: 'gt',            label: '>',          category: 'logic', color: '#0ea5e9', icon: '>',  inputCount: 2, outputCount: 1 },
  lt:            { kind: 'lt',            label: '<',          category: 'logic', color: '#0ea5e9', icon: '<',  inputCount: 2, outputCount: 1 },
  ge:            { kind: 'ge',            label: '≥',          category: 'logic', color: '#0ea5e9', icon: '≥',  inputCount: 2, outputCount: 1 },
  le:            { kind: 'le',            label: '≤',          category: 'logic', color: '#0ea5e9', icon: '≤',  inputCount: 2, outputCount: 1 },
  eq:            { kind: 'eq',            label: '==',         category: 'logic', color: '#0ea5e9', icon: '=',  inputCount: 2, outputCount: 1 },
  nq:            { kind: 'nq',            label: '!=',         category: 'logic', color: '#0ea5e9', icon: '≠',  inputCount: 2, outputCount: 1 },
  ifthen:        { kind: 'ifthen',        label: 'IF-THEN',    category: 'logic', color: '#0284c7', icon: 'if', inputCount: 3, outputCount: 1 },
  switch:        { kind: 'switch',        label: 'SWITCH',     category: 'logic', color: '#0369a1', icon: 'sw', inputCount: 'variable', outputCount: 1 },
  // ── Additional functions from JSBSimCommon.xsd <func_group> ──
  min:           { kind: 'min', label: '最小 min', category: 'math', color: '#f97316', icon: 'min', inputCount: 'variable', outputCount: 1 },
  max:           { kind: 'max', label: '最大 max', category: 'math', color: '#f97316', icon: 'max', inputCount: 'variable', outputCount: 1 },
  avg:           { kind: 'avg', label: '平均 avg', category: 'math', color: '#fb923c', icon: 'avg', inputCount: 'variable', outputCount: 1 },
  mod:           { kind: 'mod', label: '取模 mod', category: 'math', color: '#be123c', icon: 'mod', inputCount: 2, outputCount: 1 },
  and:           { kind: 'and', label: '与 and', category: 'logic', color: '#0ea5e9', icon: '∧', inputCount: 'variable', outputCount: 1 },
  or:            { kind: 'or', label: '或 or', category: 'logic', color: '#0ea5e9', icon: '∨', inputCount: 'variable', outputCount: 1 },
  not:           { kind: 'not', label: '非 not', category: 'logic', color: '#0284c7', icon: '¬', inputCount: 1, outputCount: 1 },
  fraction:      { kind: 'fraction', label: '小数 frac', category: 'func', color: '#7c3aed', icon: 'frac', inputCount: 1, outputCount: 1 },
  integer:       { kind: 'integer', label: '取整 int', category: 'func', color: '#7c3aed', icon: 'int', inputCount: 1, outputCount: 1 },
  toradians:     { kind: 'toradians', label: '→弧度', category: 'func', color: '#7c3aed', icon: '→rad', inputCount: 1, outputCount: 1 },
  todegrees:     { kind: 'todegrees', label: '→角度', category: 'func', color: '#7c3aed', icon: '→deg', inputCount: 1, outputCount: 1 },
  random:        { kind: 'random', label: '随机', category: 'func', color: '#7c3aed', icon: 'rand', inputCount: 0, outputCount: 1 },
  urandom:       { kind: 'urandom', label: '均匀随机', category: 'func', color: '#7c3aed', icon: 'urand', inputCount: 0, outputCount: 1 },
  pi:            { kind: 'pi', label: 'π', category: 'func', color: '#7c3aed', icon: 'π', inputCount: 0, outputCount: 1 },
  roundmultiple: { kind: 'roundmultiple', label: '取整倍 rnd', category: 'math', color: '#f97316', icon: 'rnd', inputCount: 'variable', outputCount: 1 },
};

// ── Layout constants ────────────────────────────────────────────────────────

const COL_WIDTH = 220;
const ROW_HEIGHT = 90;
const START_X = 50;
const START_Y = 50;

// ── Tree → Graph ────────────────────────────────────────────────────────────

interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

let _nodeIdCounter = 0;

function nextBlockId(): string {
  return `blk-${++_nodeIdCounter}`;
}

export function resetBlockIdCounter(): void {
  _nodeIdCounter = 0;
}

/**
 * Convert an expression tree into ReactFlow nodes and edges.
 * Returns the graph plus the ID of the root (output) node.
 */
export function treeToGraph(expr: ExprNode): LayoutResult & { rootId: string } {
  resetBlockIdCounter();
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // First pass: assign tree nodes to graph nodes, compute depth
  interface TreeNodeInfo {
    id: string;
    expr: ExprNode;
    depth: number;
    childEdges: { sourceId: string; targetPort: number }[];
  }

  const infoMap = new Map<object, TreeNodeInfo>();

  function assignDepth(e: ExprNode): number {
    if (infoMap.has(e)) return infoMap.get(e)!.depth;

    let depth = 0;
    const children = getChildren(e);

    if (children.length > 0) {
      const maxChildDepth = Math.max(...children.map(c => assignDepth(c)));
      depth = maxChildDepth + 1;
    }

    const id = nextBlockId();
    const info: TreeNodeInfo = { id, expr: e, depth, childEdges: [] };
    infoMap.set(e, info);
    return depth;
  }

  assignDepth(expr);

  // Group by depth for column assignment
  const byDepth = new Map<number, ExprNode[]>();
  for (const [exprRef, info] of infoMap) {
    if (!byDepth.has(info.depth)) byDepth.set(info.depth, []);
    byDepth.get(info.depth)!.push(exprRef as ExprNode);
  }

  // Order each depth by the median position of neighbours (parent / children)
  // to keep subtrees vertically aligned and reduce edge crossings.
  const byDepthIds = new Map<number, string[]>();
  const idToExpr = new Map<string, ExprNode>();
  const parentOf = new Map<string, string>();
  for (const [, info] of infoMap) {
    if (!byDepthIds.has(info.depth)) byDepthIds.set(info.depth, []);
    byDepthIds.get(info.depth)!.push(info.id);
    idToExpr.set(info.id, info.expr as ExprNode);
  }
  for (const [exprRef, info] of infoMap) {
    for (const c of getChildren(info.expr)) {
      const ci = infoMap.get(c);
      if (ci) parentOf.set(ci.id, info.id);
    }
  }
  const prevAdj = new Map<string, string[]>();
  const nextAdj = new Map<string, string[]>();
  for (const [, info] of infoMap) {
    const id = info.id;
    const childIds = getChildren(info.expr)
      .map((c) => infoMap.get(c)?.id)
      .filter((x): x is string => !!x);
    prevAdj.set(id, childIds);
    if (parentOf.has(id)) nextAdj.set(id, [parentOf.get(id)!]);
  }
  orderRanksByBarycenter(byDepthIds, { prev: prevAdj, next: nextAdj });

  // Create nodes with positions
  for (const [depth, ids] of byDepthIds) {
    ids.forEach((id, rowIdx) => {
      const e = idToExpr.get(id)!;
      const info = infoMap.get(e)!;
      const def = BLOCK_DEFS[e.kind];
      const inputCount = getInputCount(e);

      nodes.push({
        id: info.id,
        type: 'functionBlock',
        position: {
          x: START_X + depth * COL_WIDTH,
          y: START_Y + rowIdx * ROW_HEIGHT,
        },
        data: {
          exprNode: e,
          blockDef: def,
          inputCount,
          blockId: info.id,
        },
      });
    });
  }

  // Create edges from children to parents
  for (const [exprRef, info] of infoMap) {
    const e = exprRef as ExprNode;
    const children = getChildren(e);

    children.forEach((child, portIdx) => {
      const childInfo = infoMap.get(child)!;
      edges.push({
        id: `e-${childInfo.id}-${info.id}-${portIdx}`,
        source: childInfo.id,
        target: info.id,
        targetHandle: `in-${portIdx}`,
        sourceHandle: 'out-0',
        type: 'smoothstep',
        animated: false,
      });
    });
  }

  const rootInfo = infoMap.get(expr)!;
  return { nodes, edges, rootId: rootInfo.id };
}

// ── Graph → Tree ────────────────────────────────────────────────────────────

/**
 * Convert ReactFlow nodes and edges back into an expression tree.
 * The rootId identifies the output node.
 */
export function graphToTree(
  nodes: Node[],
  edges: Edge[],
  rootId: string
): ExprNode | null {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const rootNode = nodeMap.get(rootId);
  if (!rootNode) return null;

  // Track visited nodes to prevent infinite loops
  const visited = new Set<string>();

  function buildTree(nodeId: string): ExprNode | null {
    if (visited.has(nodeId)) return null; // prevent cycles
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return null;

    const data = node.data as any;
    const exprNode = data.exprNode as ExprNode;
    if (!exprNode) return null;

    // Leaf nodes - return as-is
    if (exprNode.kind === 'value' || exprNode.kind === 'property' ||
        exprNode.kind === 'function_ref' || exprNode.kind === 'table') {
      return { ...exprNode };
    }

    // Find incoming edges sorted by target handle port index
    const incoming = edges
      .filter(e => e.target === nodeId)
      .sort((a, b) => {
        const pa = parseInt((a.targetHandle || 'in-0').replace('in-', ''));
        const pb = parseInt((b.targetHandle || 'in-0').replace('in-', ''));
        return pa - pb;
      });

    const childExprs = incoming
      .map(e => buildTree(e.source))
      .filter(Boolean) as ExprNode[];

    return rebuildExprNode(exprNode, childExprs);
  }

  return buildTree(rootId);
}

/**
 * Rebuild an expression node with new children from the graph.
 */
function rebuildExprNode(original: ExprNode, children: ExprNode[]): ExprNode {
  switch (original.kind) {
    case 'value':
    case 'property':
    case 'function_ref':
    case 'table':
      return { ...original };

    case 'product':
      return { kind: 'product', children };
    case 'sum':
      return { kind: 'sum', children };
    case 'min': case 'max': case 'avg': case 'and': case 'or': case 'roundmultiple':
      return { kind: original.kind, children };

    case 'difference':
      return { kind: 'difference', left: children[0] || valueNode(0), right: children[1] || valueNode(0) };
    case 'quotient':
      return { kind: 'quotient', left: children[0] || valueNode(0), right: children[1] || valueNode(1) };
    case 'pow':
      return { kind: 'pow', base: children[0] || valueNode(0), exponent: children[1] || valueNode(1) };
    case 'atan2':
      return { kind: 'atan2', y: children[0] || valueNode(0), x: children[1] || valueNode(0) };

    case 'abs': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan': case 'sqrt': case 'exp':
      return { kind: original.kind, child: children[0] || valueNode(0) };

    case 'ifthen':
      return {
        kind: 'ifthen',
        cond: children[0] || valueNode(0),
        then: children[1] || valueNode(0),
        else: children[2] || valueNode(0),
      };

    case 'switch': {
      const idx = children[0] || valueNode(0);
      const cases = children.slice(1, -1);
      const def = children[children.length - 1] || valueNode(0);
      return { kind: 'switch', index: idx, cases, default: def };
    }

    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq':
      return { kind: original.kind, left: children[0] || valueNode(0), right: children[1] || valueNode(0) };

    default:
      return original;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getChildren(e: ExprNode): ExprNode[] {
  switch (e.kind) {
    case 'value': case 'property': case 'function_ref': case 'table':
    case 'random': case 'urandom': case 'pi':
      return [];
    case 'product': case 'sum':
    case 'min': case 'max': case 'avg': case 'and': case 'or': case 'roundmultiple':
      return e.children;
    case 'difference': return [e.left, e.right];
    case 'quotient': return [e.left, e.right];
    case 'pow': return [e.base, e.exponent];
    case 'atan2': return [e.y, e.x];
    case 'mod': return [e.left, e.right];
    case 'abs': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan': case 'sqrt': case 'exp':
    case 'fraction': case 'integer': case 'toradians': case 'todegrees': case 'not':
      return [e.child];
    case 'ifthen': return [e.cond, e.then, e.else];
    case 'switch': return [e.index, ...e.cases, e.default];
    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq':
      return [e.left, e.right];
    default:
      return [];
  }
}

function getInputCount(e: ExprNode): number {
  const def = BLOCK_DEFS[e.kind];
  if (!def) return 0;
  if (def.inputCount === 'variable') {
    return getChildren(e).length || 2; // default 2 for empty variable-arity
  }
  return def.inputCount;
}

export function valueNode(v: number): ExprValue {
  return { kind: 'value', value: v };
}

export function propertyNode(name: string): ExprProperty {
  return { kind: 'property', name };
}

// ── Block creation helpers ──────────────────────────────────────────────────

export function createBlock(kind: string): ExprNode {
  switch (kind) {
    case 'value': return { kind: 'value', value: 0 };
    case 'property': return { kind: 'property', name: 'aero/alpha-rad' };
    case 'function_ref': return { kind: 'function_ref', name: 'aero/function/kCDge' };
    case 'table': return {
      kind: 'table', tableType: '1D',
      var1: 'aero/alpha-rad', var2: '', var3: '',
      data: [[0], [0]], breakpoints1: [0, 0.1], breakpoints2: [], breakpoints3: [],
    };
    case 'product': return { kind: 'product', children: [valueNode(1), valueNode(1)] };
    case 'sum': return { kind: 'sum', children: [valueNode(0), valueNode(0)] };
    case 'difference': return { kind: 'difference', left: valueNode(0), right: valueNode(0) };
    case 'quotient': return { kind: 'quotient', left: valueNode(0), right: valueNode(1) };
    case 'pow': return { kind: 'pow', base: valueNode(0), exponent: valueNode(2) };
    case 'atan2': return { kind: 'atan2', y: valueNode(0), x: valueNode(0) };
    case 'ifthen': return { kind: 'ifthen', cond: valueNode(0), then: valueNode(0), else: valueNode(0) };
    case 'switch': return { kind: 'switch', index: valueNode(0), cases: [valueNode(0)], default: valueNode(0) };
    case 'abs': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan': case 'sqrt': case 'exp':
      return { kind: kind as UnaryOp, child: valueNode(0) };
    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq':
      return { kind: kind as ComparisonOp, left: valueNode(0), right: valueNode(0) };
    default:
      return valueNode(0);
  }
}

// ── Migration: old flat format → expression tree ────────────────────────────

export function migrateOldCoefficient(old: any): ExprNode {
  // If it already has an expression field, use it
  if (old.expression) return old.expression;

  // Convert old flat format to expression tree
  if (old.tableType === 'constant') {
    return { kind: 'value', value: old.value || 0 };
  }

  if (old.tableType === '1D' || old.tableType === '2D' || old.tableType === '3D') {
    // Build: product(property(var1), table(...))
    return {
      kind: 'product',
      children: [
        { kind: 'property', name: old.var1 || 'aero/alpha-rad' },
        {
          kind: 'table',
          tableType: old.tableType,
          var1: old.var1 || 'aero/alpha-rad',
          var2: old.var2 || '',
          var3: old.var3 || '',
          data: old.data || [[0]],
          breakpoints1: old.breakpoints1 || [0],
          breakpoints2: old.breakpoints2 || [],
          breakpoints3: old.breakpoints3 || [],
        },
      ],
    };
  }

  // Default: constant 0
  return { kind: 'value', value: 0 };
}
