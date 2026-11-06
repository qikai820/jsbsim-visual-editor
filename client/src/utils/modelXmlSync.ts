import { changedModelPaths, mainXmlPath, nodeXmlFingerprint, nodeXmlPath, subFileXmlPath, type ModelProject } from './modelChanges';
import { applyXmlDelta, parseXmlDocument } from './xmlDelta';
import { patchExistingSubfileXml } from './sourcePreservingXml';
import { xmlContentEqual } from './xmlContentEqual';
import { serializeSerialSensors } from './serialSensorXml';
import { serializePwmCaptures } from './pwmCaptureXml';
import { expandDisabledComments } from './disabledXml';

export interface PreparedXml { path: string; content: string; category?: string; dirty: boolean }
export interface XmlGenerators {
  generateXml: (project: ModelProject) => Promise<string>;
  generateSubfile: (type: string, name: string, params: any) => Promise<string>;
  originalMainSource?: string;
}

function validateOutputs(project: ModelProject): void {
  const outputs = project.nodes.filter(node => node.data.componentType === 'output');
  for (const node of outputs) {
    const p = node.data.params;
    if (!['VIZTRA_UDP_JSON', 'VIZTRA_UDP_QGC'].includes(p.type)) continue;
    const name = String(p.name || '').trim(), host = String(p.host || '').trim();
    if (!name || outputs.some(other => other.id !== node.id && String(other.data.params.name || '').trim() === name)) {
      throw new Error('Viztra UDP 输出名称须与其他输出不同且不能为空。');
    }
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.split('.').some(part => Number(part) > 255)) throw new Error(`${name}：目标 IP 须为有效的 IPv4 地址。`);
    if (!Number.isInteger(Number(p.port)) || Number(p.port) < 1 || Number(p.port) > 65535) throw new Error(`${name}：UDP 端口须为 1～65535。`);
    if (!Number.isFinite(Number(p.rate)) || Number(p.rate) <= 0 || Number(p.rate) > 250) throw new Error(`${name}：频率须大于 0 且不超过 250 Hz。`);
    if (['viztra_north', 'viztra_east', 'viztra_down'].some(key => !String(p[key] || '').trim())) throw new Error(`${name}：位置属性不能为空。`);
  }
}

/** One immutable local preparation is shared by preview, explicit save and run. */
export async function prepareModelXml(current: ModelProject, baseline: ModelProject, model: string,
  generators: XmlGenerators): Promise<PreparedXml[]> {
  validateOutputs(current);
  const paths = changedModelPaths(current, baseline, model);
  const documents = new Map<string, PreparedXml>();
  for (const file of current.xmlFiles || []) {
    const content = file.originalXml || file.currentXml;
    if (content?.trim()) documents.set(file.path, { path: file.path, content, category: file.category, dirty: false });
  }
  const originals = new Map([...documents].map(([path, file]) => [path, file.content]));
  const put = (path: string, content: string, category?: string) => {
    const original = originals.get(path);
    const dirty = original === undefined || !xmlContentEqual(original, content);
    documents.set(path, { path, content: !dirty ? original! : content,
      category: category || documents.get(path)?.category, dirty });
  };
  const main = mainXmlPath(current, model);
  const source = documents.get(main)?.content || generators.originalMainSource;
  if (source?.trim() && !documents.has(main)) {
    documents.set(main, { path: main, content: source, category: 'main', dirty: false });
    originals.set(main, source);
  }
  if (paths.length || !source) {
    const [before, after] = await Promise.all([generators.generateXml(baseline), generators.generateXml(current)]);
    if (!after?.trim()) throw new Error('模型 XML 生成结果为空');
    if (!source) put(main, after, 'main');
    else {
      const mainContent = applyXmlDelta(source, before, after, (reference, old, next) => {
        const raw = reference.getAttribute('file')!;
        const name = /\.xml$/i.test(raw) ? raw : `${raw}.xml`;
        const parent = main.slice(0, main.lastIndexOf('/') + 1);
        const exact = [parent + name, name, `systems/${name}`, `engine/${name}`];
        let matches = exact.filter(path => documents.has(path));
        if (!matches.length) matches = [...documents.keys()].filter(path => path.split('/').pop() === name.split('/').pop());
        matches = [...new Set(matches)];
        if (matches.length !== 1) throw new Error(`无法唯一确定 ${reference.tagName} 引用的 XML：${raw}，请重新加载完整模型`);
        const path = matches[0], document = documents.get(path)!;
        const serializer = new XMLSerializer();
        put(path, applyXmlDelta(document.content, serializer.serializeToString(old), serializer.serializeToString(next)));
      });
      put(main, mainContent, 'main');
    }
  }

  for (const path of paths) {
    if (path === main || path.startsWith('config/models/')) continue;
    const owners = current.nodes.filter(node => ['engine', 'propeller', 'system', 'flight_control'].includes(node.data.componentType) &&
      nodeXmlPath(node, current, model) === path);
    const subFile = current.subFiles?.find(file => subFileXmlPath(file) === path);
    const oldSubFile = baseline.subFiles?.find(file => subFileXmlPath(file) === path);
    const original = documents.get(path)?.content;
    if (!owners.length && !subFile) continue; // Removing a reference leaves the shared library file intact.
    const updates: string[] = [];
    const patches = owners.length ? owners.map(node => ({ node, params: node.data.params })) : [{ node: null, params: subFile.data }];
    for (const { node, params } of patches) {
      const old = node ? baseline.nodes.find(item => item.id === node.id) : null;
      if (old && nodeXmlFingerprint(old) === nodeXmlFingerprint(node)) continue;
      const type = node ? ['system', 'flight_control'].includes(node.data.componentType) ? 'system'
        : node.data.componentType === 'propeller' ? 'thruster' : 'engine' : subFile.fileType;
      const name = path.split('/').pop()!.replace(/\.xml$/i, '');
      if (!original) {
        if (!subFile) throw new Error(`${path} 缺少原始 XML，请重新加载完整模型`);
        updates.push(await generators.generateSubfile(type, name, params));
      } else if (type === 'system') {
        const oldParams = old?.data.params || oldSubFile?.data;
        if (!oldParams) throw new Error(`${path} 缺少编辑基线，无法安全合并系统变更`);
        // Whole-module disabling belongs to the reference in the main XML,
        // never to the root of a shared external system file.
        const [before, after] = await Promise.all([oldParams, params].map(p =>
          generators.generateSubfile(type, String(p.name || name), { ...p, disabled: false })));
        updates.push(applyXmlDelta(original, before, after));
      } else {
        const previous = old?.data.params || oldSubFile?.data || {};
        const patch = Object.fromEntries(Object.entries(params).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value)));
        for (const key of Object.keys(patch)) if (key.endsWith('_unit')) patch[key.slice(0, -5)] = params[key.slice(0, -5)];
        updates.push(patchExistingSubfileXml(original, type, patch));
      }
    }
    if (updates.some(content => !xmlContentEqual(content, updates[0]))) throw new Error(`${path} 的多个模块修改了同一共享文件且内容冲突，请统一参数后保存`);
    if (updates.length) put(path, updates[0]);
  }
  const sidecars = [
    { suffix: 'serial', type: 'serial_sensor', root: 'serial_outputs', content: serializeSerialSensors(current.nodes, current.edges) },
    { suffix: 'pwm', type: 'pwm_capture', root: 'pwm_inputs', content: serializePwmCaptures(current.nodes) },
  ];
  for (const sidecar of sidecars) {
    const path = `config/models/${model}.${sidecar.suffix}.xml`;
    if (sidecar.content !== null || baseline.nodes.some(node => node.data.componentType === sidecar.type)) {
      const content = sidecar.content || `<?xml version="1.0"?>\n<${sidecar.root} version="1"/>\n`;
      if (documents.has(path)) put(path, content, 'hardware');
      else documents.set(path, { path, content, category: 'hardware', dirty: paths.includes(path) });
    }
  }
  for (const file of current.xmlFiles || []) {
    const old = baseline.xmlFiles?.find(item => item.path === file.path);
    if (file.currentXml && file.currentXml !== (old?.currentXml || old?.originalXml || file.originalXml)) {
      if (documents.get(file.path)?.dirty) throw new Error(`${file.path} 同时有源码与图形修改，请先完成一种编辑后再保存`);
      put(file.path, file.currentXml, file.category);
    }
  }
  for (const document of documents.values()) expandDisabledComments(parseXmlDocument(document.content));
  return [...documents.values()];
}

export interface RemoteXmlChange extends PreparedXml { remote: string | null }

export async function compareModelXml(documents: PreparedXml[], read: (path: string) => Promise<string | null>): Promise<RemoteXmlChange[]> {
  const changes: RemoteXmlChange[] = [];
  for (const document of documents) {
    const remote = await read(document.path);
    expandDisabledComments(parseXmlDocument(document.content));
    if (remote !== null) parseXmlDocument(remote);
    if (remote === null || !xmlContentEqual(document.content, remote)) changes.push({ ...document, remote, dirty: true });
  }
  return changes;
}
