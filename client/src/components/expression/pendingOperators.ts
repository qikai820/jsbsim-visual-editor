import type { Node } from '@xyflow/react';
import { buildSignalGraph } from '../../utils/signalGraph';
import { treeToGraph } from '../../utils/expressionConverter';

// Empty parser attributes and omitted attributes serialize to the same XML.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined &&
    !(key === 'attrs' && value[key] && Object.keys(value[key]).length === 0)).map(key => [key, canonical(value[key])]));
}
// Only serialized signal data matters: moving or resizing a block is layout.
function componentValue(data: any) {
  return JSON.stringify(canonical([data.itemType, data.name, data.outputSignal, data.inputs, data.expression,
    data.cliptoMin, data.cliptoMax, data.compProps, !!data.disabled, !!data.channelDisabled]));
}
function expressionValue(expr: any) {
  if (!expr) return '';
  // Descendants are displayed as separate blocks, so compare each block's own
  // properties instead of marking all its ancestors when one value changes.
  const own = Object.fromEntries(Object.entries(expr).filter(([key, value]) =>
    !Array.isArray(value) || key === 'breakpoints1' || key === 'breakpoints2' || key === 'data')
    .filter(([, value]) => !value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)));
  return JSON.stringify(canonical(own));
}

// Layout/measurement changes do not change the simulator baseline. Never run
// a graph layout just to compare serialized component values.
const baselineGraphs = new WeakMap<any[], Map<string, Node>>();
function baselineComponents(channels: any[] | null): Map<string, Node> {
  if (!channels) return new Map();
  let baseline = baselineGraphs.get(channels);
  if (!baseline) {
    baseline = new Map(buildSignalGraph(channels, [], { layout: false }).nodes
      .filter((node: Node) => node.data?.kind === 'component').map((node: Node) => [node.id, node]));
    baselineGraphs.set(channels, baseline);
  }
  return baseline;
}

export function pendingOperatorIds(nodes: Node[], baselineChannels: any[] | null): Set<string> {
  const result = new Set<string>();
  const baseline = baselineComponents(baselineChannels);
  const byName = new Map<string, any>();
  for (const old of baseline.values()) {
    const key = `${old.data.itemType}:${old.data.name}`;
    byName.set(key, byName.has(key) ? null : old);
  }
  const match = (node: Node) => {
    const data: any = node.data;
    const indexed: any = baseline.get(node.id);
    if (indexed?.data.name === data.name && indexed.data.itemType === data.itemType) return indexed;
    return byName.get(`${data.itemType}:${data.name}`) || indexed;
  };
  const owners = new Map(nodes.filter(node => node.data?.kind === 'component').map(node => [node.id, node]));
  const oldOwner = (ownerId: string) => { const owner = owners.get(ownerId); return owner ? match(owner) : undefined; };
  const expressionBaseline = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const data: any = node.data;
    if (data.kind === 'component') {
      const old: any = match(node);
      if (!old || componentValue(data) !== componentValue(old.data)) result.add(node.id);
    } else if (data.kind === 'tablePreview') {
      const old: any = oldOwner(data.ownerId);
      if (!old || JSON.stringify(data.expression) !== JSON.stringify(old.data.expression?.children?.[data.factorIndex])) result.add(node.id);
    } else if (data.kind === 'exprBlock') {
      const old: any = oldOwner(data.ownerId);
      if (!old?.data.expression) { result.add(node.id); continue; }
      if (!expressionBaseline.has(data.ownerId)) {
        const map = new Map<string, string>();
        for (const oldNode of treeToGraph(old.data.expression).nodes) map.set(`${data.ownerId}/exp/${oldNode.id}`, expressionValue(oldNode.data.exprNode));
        expressionBaseline.set(data.ownerId, map);
      }
      if (expressionBaseline.get(data.ownerId)!.get(node.id) !== expressionValue(data.exprNode)) result.add(node.id);
    }
  }
  return result;
}

const incomingCache = new WeakMap<any[], Map<string, string>>();
function incomingSignatures(edges: any[]): Map<string, string> {
  let result = incomingCache.get(edges);
  if (result) return result;
  const lists = new Map<string, any[][]>();
  for (const edge of edges) {
    let list = lists.get(edge.target);
    if (!list) lists.set(edge.target, list = []);
    list.push([edge.targetHandle, edge.source]);
  }
  result = new Map([...lists].map(([id, list]) => [id,
    JSON.stringify(list.sort((a, b) => String(a[0]).localeCompare(String(b[0]))))]));
  incomingCache.set(edges, result);
  return result;
}
const expressionBaselines = new WeakMap<object, { values: Map<string, string>; incoming: Map<string, string> }>();
export function pendingExpressionIds(nodes: Node[], edges: any[], baselineExpression: any | null): Set<string> {
  const result = new Set<string>();
  if (!baselineExpression) { nodes.forEach(node => result.add(node.id)); return result; }
  let baseline = expressionBaselines.get(baselineExpression);
  if (!baseline) {
    const graph = treeToGraph(baselineExpression);
    baseline = { values: new Map(graph.nodes.map(node => [node.id, expressionValue(node.data.exprNode)])), incoming: incomingSignatures(graph.edges) };
    expressionBaselines.set(baselineExpression, baseline);
  }
  const incoming = incomingSignatures(edges);
  for (const node of nodes) {
    if (baseline.values.get(node.id) !== expressionValue(node.data.exprNode) ||
      (incoming.get(node.id) || '[]') !== (baseline.incoming.get(node.id) || '[]')) result.add(node.id);
  }
  return result;
}
