import type { Node } from '@xyflow/react';
import type { AircraftNodeData, ProjectXmlFile, SubFile, SystemDef } from '../types';

export type SignalOriginKind = 'xml-definition' | 'xml-reference' | 'graph-output' | 'graph-input' | 'runtime';
export interface SignalOrigin { kind: SignalOriginKind; source: string }
export interface SignalEntry { path: string; origins: SignalOrigin[] }

const componentTags = new Set([
  'function', 'fcs_function', 'summer', 'pure_gain', 'pid', 'integrator',
  'scheduled_gain', 'bias', 'constant', 'difference', 'product', 'quotient',
  'pow', 'atan2', 'switch', 'actuator', 'aerosurface_scale', 'angle',
  'kinematic', 'deadband', 'lag_filter', 'lead_lag_filter',
  'second_order_filter', 'washout_filter', 'sensor', 'gyro',
  'accelerometer', 'magnetometer', 'waypoint_distance', 'waypoint_heading',
]);

export function normalizeSignalPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const path = value.trim().replace(/^[-+](?=[A-Za-z_/])/, '');
  return path && !/\s|[<>{},]/.test(path) && /^[A-Za-z_/][A-Za-z0-9_./:\[\]-]*$/.test(path) ? path : '';
}

function add(index: Map<string, SignalEntry>, raw: unknown, kind: SignalOriginKind, source: string): void {
  const path = normalizeSignalPath(raw);
  if (!path) return;
  let entry = index.get(path);
  if (!entry) { entry = { path, origins: [] }; index.set(path, entry); }
  if (!entry.origins.some(origin => origin.kind === kind && origin.source === source)) {
    entry.origins.push({ kind, source });
  }
}

function addList(index: Map<string, SignalEntry>, value: unknown, kind: SignalOriginKind, source: string): void {
  if (typeof value !== 'string') return;
  value.split(',').forEach(path => add(index, path, kind, source));
}

export function indexXmlSignals(files: ProjectXmlFile[]): SignalEntry[] {
  const index = new Map<string, SignalEntry>();
  if (typeof DOMParser === 'undefined') return [];
  for (const file of files) {
    const xml = file.currentXml || file.originalXml;
    if (!xml?.trim()) continue;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) continue;
    for (const element of Array.from(doc.getElementsByTagName('*'))) {
      const tag = element.tagName;
      if (tag === 'property') {
        const kind = element.hasAttribute('value') || element.hasAttribute('name')
          ? 'xml-definition' : 'xml-reference';
        add(index, element.getAttribute('name') || element.textContent, kind, file.path);
      } else if (tag === 'function_ref' || tag === 'independentVar' || tag === 'input') {
        if (!element.children.length) add(index, element.textContent, 'xml-reference', file.path);
      } else if (tag === 'output') {
        if (!element.children.length) add(index, element.textContent, 'xml-definition', file.path);
      }
      if (componentTags.has(tag)) add(index, element.getAttribute('name'), 'xml-definition', file.path);
    }
  }
  return [...index.values()];
}

function collectExpression(index: Map<string, SignalEntry>, value: any, source: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(child => collectExpression(index, child, source)); return; }
  if (value.kind === 'property' || value.kind === 'function_ref') {
    add(index, value.name, 'graph-input', source);
  } else if (value.kind === 'table') {
    for (const key of ['var1', 'var2', 'var3']) add(index, value[key], 'graph-input', source);
  }
  for (const key of ['children', 'child', 'left', 'right', 'base', 'exponent', 'cond', 'then', 'else',
    'index', 'cases', 'default', 'x', 'y']) collectExpression(index, value[key], source);
}

function collectItems(index: Map<string, SignalEntry>, items: any[], source: string): void {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    add(index, item.name || item.output, 'graph-output', source);
    collectExpression(index, item.expression, source);
    for (const field of ['input', 'inputs', 'output', 'property', 'properties']) {
      const raw = item.componentProps?.[field] ?? item[field];
      if (Array.isArray(raw)) raw.forEach(value => addList(index, typeof value === 'object' ? value?.value : value, 'graph-input', source));
      else addList(index, typeof raw === 'object' ? raw?.value : raw, 'graph-input', source);
    }
    if (Array.isArray(item.items)) collectItems(index, item.items, source);
  }
}

function parsedArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const result = JSON.parse(value); return Array.isArray(result) ? result : []; }
  catch { return []; }
}

export function indexGraphSignals(nodes: Node<AircraftNodeData>[]): SignalEntry[] {
  const index = new Map<string, SignalEntry>();
  for (const node of nodes) {
    const params = node.data.params || {};
    const source = String(params.referencePath || params.source?.path || node.data.label || node.id);
    for (const key of ['channels', 'topLevelItems', 'coefficients']) {
      const entries = parsedArray(params[key]);
      if (key === 'channels') entries.forEach(channel => collectItems(index, channel?.items || [], source));
      else collectItems(index, entries, source);
    }
    if (node.data.componentType === 'system' || node.data.componentType === 'flight_control') {
      addList(index, params.properties, 'graph-input', source);
    }
    for (const [key, raw] of Object.entries(params)) {
      if (key === 'properties' && node.data.componentType === 'system') continue;
      if (key === 'properties' || key.endsWith('_properties') || key.startsWith('hil_imu_') ||
          key.startsWith('hil_pressure_') || key.startsWith('hil_gps_')) {
        addList(index, raw, 'graph-input', source);
      }
    }
  }
  return [...index.values()];
}

export function mergeSignalIndexes(...groups: SignalEntry[][]): SignalEntry[] {
  const index = new Map<string, SignalEntry>();
  for (const group of groups) for (const entry of group) {
    for (const origin of entry.origins) add(index, entry.path, origin.kind, origin.source);
  }
  return [...index.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function runtimeSignalIndex(paths: string[]): SignalEntry[] {
  const index = new Map<string, SignalEntry>();
  paths.forEach(path => add(index, path, 'runtime', '已发现属性缓存'));
  return [...index.values()];
}

export function indexSubFileSignals(files: SubFile[]): SignalEntry[] {
  const index = new Map<string, SignalEntry>();
  for (const file of files) {
    if (file.fileType !== 'system') continue;
    for (const property of (file.data as SystemDef).properties || []) {
      add(index, property.name, 'graph-output', `systems/${file.fileName}`);
    }
  }
  return [...index.values()];
}
