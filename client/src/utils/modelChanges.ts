import type { ProjectXmlFile } from '../types';
import { xmlContentEqual } from './xmlContentEqual';

export interface ModelProject {
  aircraft: any;
  nodes: any[];
  edges: any[];
  subFiles?: any[];
  xmlFiles?: ProjectXmlFile[];
}

const nonXmlTypes = new Set(['scope', 'environment', 'force_moment', 'six_dof']);
const editorParams = new Set(['layout', 'source', 'referencePath', '_source_file']);

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]),
  );
  return value;
}

export function xmlParams(params: Record<string, any> = {}): Record<string, any> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !editorParams.has(key)));
}

export function nodeXmlFingerprint(node: any): string {
  return JSON.stringify(stable({ type: node.data.componentType, params: xmlParams(node.data.params) }));
}

export function mainXmlPath(project: ModelProject, model: string): string {
  return project.xmlFiles?.find(file => file.category === 'main')?.path || `aircraft/${model}/${model}.xml`;
}

export function subFileXmlPath(file: any): string {
  const name = String(file.fileName || '').replace(/^\/+/, '').replace(/\.xml$/i, '') + '.xml';
  return `${file.fileType === 'system' ? 'systems' : 'engine'}/${name}`;
}

export function nodeXmlPath(node: any, project: ModelProject, model: string): string {
  const type = node.data.componentType;
  if (type === 'serial_sensor') return `config/models/${model}.serial.xml`;
  if (type === 'pwm_capture') return `config/models/${model}.pwm.xml`;
  const p = node.data.params || {};
  let path = String(p.referencePath || p.source?.path || p._source_file ||
    (['system', 'flight_control', 'engine', 'propeller'].includes(type) ? p.file : '') || '').trim();
  if (!path) return mainXmlPath(project, model);
  if (!/\.xml$/i.test(path)) path += '.xml';
  if (!path.includes('/')) {
    path = ['system', 'flight_control'].includes(type) ? `systems/${path}`
      : ['engine', 'propeller'].includes(type) ? `engine/${path}` : path;
  }
  return path;
}

/** All XML consumers use this comparison, including undo, direct store edits and removals. */
export function changedModelPaths(current: ModelProject, baseline: ModelProject, model: string): string[] {
  const paths = new Set<string>();
  const main = mainXmlPath(current, model);
  if (JSON.stringify(stable(current.aircraft)) !== JSON.stringify(stable(baseline.aircraft))) paths.add(main);
  const before = new Map(baseline.nodes.filter(n => !nonXmlTypes.has(n.data.componentType)).map(n => [n.id, n]));
  const after = new Map(current.nodes.filter(n => !nonXmlTypes.has(n.data.componentType)).map(n => [n.id, n]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), next = after.get(id);
    if (old && next && nodeXmlFingerprint(old) === nodeXmlFingerprint(next)) continue;
    if (old) paths.add(nodeXmlPath(old, baseline, model));
    if (next) paths.add(nodeXmlPath(next, current, model));
    // File-backed modules also have declarations / mounting data in the main
    // model. The XML delta later removes candidates whose content is unchanged.
    if (!old || !next || ['engine', 'propeller'].includes(next.data.componentType) ||
        (old && next && old.data.params?.file !== next.data.params?.file)) paths.add(main);
  }
  const connections = (project: ModelProject) => project.edges
    .filter(edge => before.has(edge.source) || after.has(edge.source))
    .filter(edge => before.has(edge.target) || after.has(edge.target))
    .map(edge => [edge.source, edge.target, edge.sourceHandle || '', edge.targetHandle || '']).sort();
  if (JSON.stringify(connections(current)) !== JSON.stringify(connections(baseline))) {
    paths.add(main);
    for (const node of [...before.values(), ...after.values()]) {
      if (node.data.componentType === 'serial_sensor') paths.add(nodeXmlPath(node, current, model));
    }
  }
  const oldSubfiles = new Map((baseline.subFiles || []).map(file => [file.id, file]));
  const newSubfiles = new Map((current.subFiles || []).map(file => [file.id, file]));
  for (const id of new Set([...oldSubfiles.keys(), ...newSubfiles.keys()])) {
    const old = oldSubfiles.get(id), next = newSubfiles.get(id);
    if (JSON.stringify(stable(old)) === JSON.stringify(stable(next))) continue;
    if (old) paths.add(subFileXmlPath(old));
    if (next) paths.add(subFileXmlPath(next));
  }
  // Explicit source edits are also part of the model, independently of nodes.
  for (const file of current.xmlFiles || []) {
    const old = baseline.xmlFiles?.find(item => item.path === file.path);
    const previous = old?.currentXml || old?.originalXml || file.originalXml;
    if (file.currentXml && file.currentXml !== previous && !xmlContentEqual(file.currentXml, previous)) paths.add(file.path);
  }
  return [...paths].sort();
}

export function remoteBaselineKey(model: string): string {
  return `jsbsim-remote-baseline:${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function readRemoteBaseline(model: string): ModelProject | null {
  try {
    const value = JSON.parse(localStorage.getItem(remoteBaselineKey(model)) || 'null');
    return value && Array.isArray(value.nodes) && Array.isArray(value.edges) ? value : null;
  } catch { return null; }
}

/** Keep comparison state without duplicating complete XML sources or layouts
 * in localStorage. The live project's originalXml owns the verified bytes.
 */
export function compactModelBaseline(project: ModelProject): ModelProject {
  return {
    aircraft: project.aircraft,
    nodes: project.nodes.map(node => ({ id: node.id, type: node.type,
      data: { label: node.data.label, componentType: node.data.componentType,
        params: Object.fromEntries(Object.entries(node.data.params || {}).filter(([key]) => key !== 'layout')) } })),
    edges: project.edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
    subFiles: project.subFiles || [],
    xmlFiles: (project.xmlFiles || []).map(({ id, path, category }) => ({ id, path, category, originalXml: '', currentXml: '', dirty: false })),
  };
}

/** Restore model content while keeping the user's current canvas arrangement.
 * Compact remote baselines omit XML bytes; originalXml owns the last verified
 * source, whereas currentXml may contain an unsaved source edit.
 */
export function restoreModelBaseline(current: ModelProject, baseline: ModelProject): ModelProject {
  const restored: ModelProject = JSON.parse(JSON.stringify(baseline));
  const liveNodes = new Map(current.nodes.map(node => [node.id, node]));
  restored.nodes = restored.nodes.map((node, index) => {
    const live = liveNodes.get(node.id);
    const params = { ...node.data.params };
    if (live?.data.params?.layout !== undefined) params.layout = live.data.params.layout;
    return { ...node, position: live?.position || node.position || { x: 60 + index % 4 * 240, y: 60 + Math.floor(index / 4) * 160 },
      data: { ...node.data, params } };
  });
  restored.edges = restored.edges.map(edge => ({ type: 'smoothstep', ...edge }));
  restored.xmlFiles = restored.xmlFiles?.map(file => {
    const live = current.xmlFiles?.find(candidate => candidate.path === file.path);
    const source = file.currentXml || file.originalXml || live?.originalXml;
    if (!source) throw new Error(`无法恢复 ${file.path}：缺少原始 XML，请重新加载模型。`);
    return { ...file, originalXml: source, currentXml: source, dirty: false };
  });
  return restored;
}

export function cachedEditBaseline(project: ModelProject, baseline: ModelProject | null): ModelProject | undefined {
  const model = project.xmlFiles?.find(file => file.category === 'main')?.path.match(/^aircraft\/([^/]+)\//)?.[1]
    || localStorage.getItem('jsbsim-remote-model') || project.aircraft.name;
  return baseline && !readRemoteBaseline(model) ? compactModelBaseline(baseline) : undefined;
}
