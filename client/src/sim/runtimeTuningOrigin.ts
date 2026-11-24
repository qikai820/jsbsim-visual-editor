import type { AircraftNode } from '../types';

// Zustand subscriptions run synchronously. Explicit wind editing stores drafts
// without triggering the automatic tuning subscriber a second time.
let depth = 0;
export const automaticRuntimeTuningSuppressed = () => depth > 0;
export function withoutAutomaticRuntimeTuning(update: () => void) {
  depth++;
  try { update(); } finally { depth--; }
}

// Keep the pre-edit values alongside the immutable editor parameter record.
// Undo and redo restore those records, while project files contain only the draft values.
const draftParameters = new WeakMap<AircraftNode['data']['params'], Map<string, unknown>>();

export function trackRuntimeDraftParameters(previous: AircraftNode['data']['params'], next: AircraftNode['data']['params'],
  keys: string[], draftOnly: boolean) {
  const existing = draftParameters.get(previous);
  if (!existing && !draftOnly) return;
  const retained = new Map(existing);
  for (const key of keys) {
    if (Object.is(previous[key], next[key])) continue;
    if (!draftOnly) retained.delete(key);
    else if (!retained.has(key)) retained.set(key, previous[key]);
  }
  if (retained.size) draftParameters.set(next, retained);
}

export function projectForAutomaticRuntimeTuning<T extends { nodes: AircraftNode[] }>(project: T): T {
  if (!project.nodes.some(node => draftParameters.has(node.data.params))) return project;
  return { ...project, nodes: project.nodes.map(node => {
    const retained = draftParameters.get(node.data.params);
    return retained ? { ...node, data: { ...node.data, params: { ...node.data.params, ...Object.fromEntries(retained) } } } : node;
  }) };
}
