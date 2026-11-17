import type { ModelProject } from './modelChanges';

// Older editor backends omitted AUTO and its USB settings while retaining
// the source XML. Recover only missing settings; explicit graph edits win.
export function restoreHilTransport<T extends ModelProject>(project: T): T {
  const sources = new Map<string, Element[]>();
  for (const file of project.xmlFiles || []) {
    if (file.category !== 'main') continue;
    const document = new DOMParser().parseFromString(file.currentXml || file.originalXml, 'application/xml');
    if (document.querySelector('parsererror') || document.documentElement.tagName !== 'fdm_config') continue;
    sources.set(file.path, Array.from(document.documentElement.children));
  }
  if (!sources.size) return project;
  const restore = (nodes: T['nodes']) => nodes.map(node => {
    const { componentType, params = {} } = node.data;
    if (!['input', 'output'].includes(componentType) || params.transport != null ||
        !['HIL_ACTUATOR_CONTROLS', 'HIL_SENSOR', 'HIL_GPS'].includes(params.type)) return node;
    const path = params.source?.path;
    const elements = path ? sources.get(path) : sources.size === 1 ? [...sources.values()][0] : undefined;
    const matches = elements?.filter(element => element.tagName === componentType &&
      element.getAttribute('type') === params.type &&
      (element.getAttribute('name') || (componentType === 'input' ? '0.0.0.0' : 'localhost')) === params.name);
    if (matches?.length !== 1) return node;
    const element = matches[0];
    if (!['AUTO', 'SERIAL'].includes(element.getAttribute('transport') || '')) return node;
    const recovered = { ...params };
    for (const key of ['transport', 'device', 'baud', 'host']) {
      if (recovered[key] == null && element.hasAttribute(key)) recovered[key] = element.getAttribute(key);
    }
    return { ...node, data: { ...node.data, params: recovered } };
  });
  const baseline = (project as T & { xmlEditBaseline?: ModelProject }).xmlEditBaseline;
  return { ...project, nodes: restore(project.nodes),
    ...(baseline ? { xmlEditBaseline: { ...baseline, nodes: restore(baseline.nodes) } } : {}) };
}
