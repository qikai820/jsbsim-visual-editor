import type { Node, Edge } from '@xyflow/react';
import { moduleIsDisabled } from './disabledXml';
import { extractInputSignals, extractOutputSignal } from './signalGraph';

export interface DisabledDependency { signal: string; producer: string; consumer: string }

/** Property names span system files, so check the complete editor model too. */
export function disabledDependencies(nodes: { data: any }[]): DisabledDependency[] {
  const components: { item: any; disabled: boolean; label: string }[] = [];
  const array = (value: any): any[] => {
    try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []; }
    catch { return []; }
  };
  for (const node of nodes) {
    const params = node.data.params || {};
    const add = (item: any, channelDisabled = false) => components.push({ item,
      disabled: !!(params.disabled || channelDisabled || item.disabled),
      label: `${node.data.label || params.name || '模块'} / ${item.name || item.type}` });
    for (const channel of array(params.channels)) for (const item of array(channel.items)) add(item, channel.disabled);
    for (const item of array(params.topLevelItems)) add(item);
    for (const item of array(params.coefficients)) add({ ...item, type: 'function' });
  }
  const active = new Set<string>(), disabled = new Map<string, string>();
  for (const component of components) {
    for (const signal of [extractOutputSignal(component.item), component.item.name].filter(Boolean)) {
      if (component.disabled) disabled.set(signal, component.label);
      else active.add(signal);
    }
  }
  return components.filter(component => !component.disabled).flatMap(component =>
    [...new Set(extractInputSignals(component.item))].filter(signal => disabled.has(signal) && !active.has(signal))
      .map(signal => ({ signal, producer: disabled.get(signal)!, consumer: component.label })));
}

export function disabledGraph(nodes: Node[], edges: Edge[], moduleDisabled = false) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const disabled = new Set(nodes.filter(node => moduleDisabled || moduleIsDisabled(node.data) ||
    moduleIsDisabled(byId.get(String(node.data?.ownerId))?.data)).map(node => node.id));
  const warnings = new Map<string, string[]>();
  for (const edge of edges) {
    if (!disabled.has(edge.source) || disabled.has(edge.target)) continue;
    const signals = warnings.get(edge.target) || [];
    const name = String(edge.data?.signal || edge.label || '');
    if (name && !signals.includes(name)) signals.push(name);
    warnings.set(edge.target, signals);
  }
  return {
    nodes: nodes.map(node => ({ ...node, data: { ...node.data,
      moduleDisabled: moduleDisabled || !!node.data?.ownerId && disabled.has(String(node.data.ownerId)),
      disabledInputs: warnings.get(node.id) || [],
    }, connectable: !disabled.has(node.id) })),
    edges: edges.map(edge => disabled.has(edge.source) || disabled.has(edge.target)
      ? { ...edge, data: { ...edge.data, moduleDisabled: true } } : edge),
  };
}
