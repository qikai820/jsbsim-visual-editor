/** Prepare a source-preserving update for the inertia node, including file-backed mass sections. */
export function prepareInertiaUpdate(current: any, mainSource: string): { path: string; content: string } | null {
  const nodes = (current.nodes || []).filter((node: any) => node.data?.componentType === 'inertia');
  if (!nodes.length) return null;
  if (nodes.length !== 1) throw new Error('存在多个惯量节点，无法确定质量文件，已取消同步。');
  const parse = (xml: string) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('质量 XML 无法解析，已取消同步。');
    return doc;
  };
  if (!mainSource.trim()) throw new Error('主 XML 原始源码缺失，无法确定惯量文件。');
  const mainFile = (current.xmlFiles || []).find((file: any) => file.category === 'main');
  const mainDoc = parse(mainSource);
  const sections = Array.from(mainDoc.documentElement.children).filter(element => element.tagName === 'mass_balance');
  if (sections.length !== 1) throw new Error('主模型中的质量配置不唯一或不存在，无法同步惯量。');
  const reference = sections[0].getAttribute('file')?.trim();
  let path = mainFile?.path || '';
  let source = mainSource;
  if (reference) {
    const name = reference.toLowerCase().endsWith('.xml') ? reference : `${reference}.xml`;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const expected = name.includes('/') ? name : parent + name;
    const matches = (current.xmlFiles || []).filter((file: any) => file.path === expected || file.path === name);
    if (matches.length !== 1) throw new Error(`无法确定惯量关联文件 ${name}，请重新从仿真机加载模型。`);
    path = matches[0].path;
    source = matches[0].originalXml || matches[0].currentXml || '';
    if (!source.trim()) throw new Error(`惯量文件 ${path} 的原始 XML 缺失。`);
  }
  if (!path) throw new Error('无法确定惯量 XML 路径。');
  const doc = reference ? parse(source) : mainDoc;
  const section = reference ? doc.documentElement : sections[0];
  if (section.tagName !== 'mass_balance') throw new Error(`惯量文件 ${path} 不是 mass_balance XML。`);
  const params = nodes[0].data.params || {};
  let changed = false;
  const keys = ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'];
  for (const key of keys) {
    if (!(key in params)) continue;
    const raw = params[key];
    const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
    const unit = typeof raw === 'object' && raw !== null ? raw.unit : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`惯量 ${key} 的值无效，已取消同步。`);
    const existing = Array.from(section.children).filter(element => element.tagName === key);
    if (existing.length > 1 || existing[0]?.children.length) throw new Error(`惯量 ${key} 的 XML 结构不明确，已取消同步。`);
    let element = existing[0];
    if (!element) {
      element = doc.createElement(key);
      const later = Array.from(section.children).find(child => {
        const i = keys.indexOf(child.tagName);
        return i > keys.indexOf(key) || (i < 0 && ['emptywt', 'location', 'pointmass'].includes(child.tagName));
      });
      section.insertBefore(element, later || null);
      changed = true;
    }
    const attr = element.getAttribute('value');
    const oldText = attr ?? element.textContent?.trim() ?? '';
    if (oldText === '' || Number(oldText) !== value) {
      if (attr !== null) element.setAttribute('value', String(value));
      else element.textContent = String(value);
      changed = true;
    }
    if (typeof unit === 'string' && unit && element.getAttribute('unit') !== unit) {
      element.setAttribute('unit', unit);
      changed = true;
    }
  }
  return changed ? { path, content: new XMLSerializer().serializeToString(doc) } : null;
}
