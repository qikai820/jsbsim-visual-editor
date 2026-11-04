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
    data.cliptoMin, data.cliptoMax, data.compProps]));
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

export function pendingOperatorIds(nodes: Node[], baselineChannels: any[] | null): Set<string> {
  const result = new Set<string>();
  const baseline = new Map((baselineChannels ? buildSignalGraph(baselineChannels).nodes : [])
    .filter((node: Node) => node.data?.kind === 'component').map((node: Node) => [node.id, node]));
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

export function pendingExpressionIds(nodes: Node[], edges: any[], baselineExpression: any | null): Set<string> {
  const result = new Set<string>();
  if (!baselineExpression) { nodes.forEach(node => result.add(node.id)); return result; }
  const graph = treeToGraph(baselineExpression);
  const old = new Map(graph.nodes.map(node => [node.id, expressionValue(node.data.exprNode)]));
  const incoming = (list: any[], id: string) => JSON.stringify(list.filter(edge => edge.target === id)
    .map(edge => [edge.targetHandle, edge.source]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  for (const node of nodes) {
    if (old.get(node.id) !== expressionValue(node.data.exprNode) || incoming(edges, node.id) !== incoming(graph.edges, node.id)) result.add(node.id);
  }
  return result;
}
