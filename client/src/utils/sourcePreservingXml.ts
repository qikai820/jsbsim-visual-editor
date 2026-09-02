const MODELED_SYSTEM_CHILDREN = new Set([
  'property', 'function', 'fcs_function', 'channel',
  'summer', 'pure_gain', 'pid', 'integrator', 'scheduled_gain', 'bias',
  'constant', 'difference', 'product', 'quotient', 'pow', 'atan2', 'switch',
  'actuator', 'aerosurface_scale', 'angle', 'kinematic', 'deadband',
  'lag_filter', 'lead_lag_filter', 'second_order_filter', 'washout_filter',
  'sensor', 'gyro', 'accelerometer', 'magnetometer',
  'waypoint_distance', 'waypoint_heading',
]);

function parseDocument(xml: string, label: string): XMLDocument {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) throw new Error(`${label} XML 无法解析：${error.textContent?.trim() || '格式错误'}`);
  return document;
}

function directElements(parent: Element): Element[] {
  return Array.from(parent.children);
}

function scalarValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object' && value && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    if (typeof nested === 'string' || typeof nested === 'number' || typeof nested === 'boolean') {
      return String(nested);
    }
  }
  return null;
}

function replaceElementText(element: Element, value: string): void {
  // Keep the source file's indentation around scalar text. Unknown children,
  // comments and lookup-table bodies are never routed through this function.
  const textNodes = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
  if (textNodes.length === 1 && element.children.length === 0) {
    const previous = textNodes[0].nodeValue || '';
    const leading = previous.match(/^\s*/)?.[0] || '';
    const trailing = previous.match(/\s*$/)?.[0] || '';
    textNodes[0].nodeValue = `${leading}${value}${trailing}`;
  } else if (element.children.length === 0) {
    element.textContent = value;
  }
}

function patchPropulsionSource(sourceXml: string, params: Record<string, unknown>): string {
  const document = parseDocument(sourceXml, '原始子文件');
  const root = document.documentElement;

  for (const child of directElements(root)) {
    // Tables and any other structured/unknown element remain byte-for-byte
    // equivalent at the DOM level. Only direct scalar fields parsed into the
    // property panel are eligible for updates.
    if (child.children.length > 0 || child.tagName === 'table' || child.tagName === 'tableData') continue;
    const value = scalarValue(params[child.tagName]);
    if (value === null) continue;
    replaceElementText(child, value);

    const param = params[child.tagName];
    const objectUnit = typeof param === 'object' && param && 'unit' in param
      ? scalarValue((param as { unit?: unknown }).unit)
      : null;
    const unit = scalarValue(params[`${child.tagName}_unit`]) ?? objectUnit;
    if (unit !== null && unit.trim()) child.setAttribute('unit', unit);
  }

  return new XMLSerializer().serializeToString(document);
}

function identity(element: Element): string {
  return `${element.tagName}\u0000${element.getAttribute('name') || ''}`;
}

function matchingChild(sourceParent: Element, candidate: Element, used: Set<Element>): Element | null {
  const wanted = identity(candidate);
  return directElements(sourceParent).find(child => !used.has(child) && identity(child) === wanted) || null;
}

function appendWithIndent(parent: Element, child: Element): void {
  const owner = parent.ownerDocument;
  const imported = owner.importNode(child, true);
  const closingIndent = Array.from(parent.childNodes).reverse()
    .find(node => node.nodeType === Node.TEXT_NODE && /\n\s*$/.test(node.nodeValue || ''));
  if (closingIndent) parent.insertBefore(imported, closingIndent);
  else parent.appendChild(imported);
}

function mergeModeledElements(source: Element, candidate: Element): void {
  for (const attr of Array.from(candidate.attributes)) source.setAttribute(attr.name, attr.value);

  const candidateChildren = directElements(candidate);
  if (!candidateChildren.length) {
    if (source.children.length === 0 && source.tagName !== 'table' && source.tagName !== 'tableData') {
      replaceElementText(source, candidate.textContent || '');
    }
    return;
  }

  const used = new Set<Element>();
  for (const candidateChild of candidateChildren) {
    // Lookup tables are intentionally retained from the original source. A
    // reduced visual schema must never rewrite their axes or tableData.
    if (candidateChild.tagName === 'table' || candidateChild.tagName === 'tableData') continue;
    const sourceChild = matchingChild(source, candidateChild, used);
    if (sourceChild) {
      used.add(sourceChild);
      mergeModeledElements(sourceChild, candidateChild);
    } else {
      appendWithIndent(source, candidateChild);
    }
  }

  // Deleting a graph block should remove that modeled block, but arbitrary
  // vendor extensions and comments are retained because they are not in this
  // explicit allow-list.
  if (source.tagName === 'system' || source.tagName === 'channel') {
    const wanted = new Map<string, number>();
    for (const child of candidateChildren) {
      const key = identity(child);
      wanted.set(key, (wanted.get(key) || 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const child of directElements(source)) {
      if (!MODELED_SYSTEM_CHILDREN.has(child.tagName)) continue;
      const key = identity(child);
      const index = seen.get(key) || 0;
      seen.set(key, index + 1);
      if (index >= (wanted.get(key) || 0)) child.remove();
    }
  }
}

function patchSystemSource(sourceXml: string, generatedXml: string): string {
  const source = parseDocument(sourceXml, '原始 System 子文件');
  const candidate = parseDocument(generatedXml, '界面生成的 System 补丁');
  mergeModeledElements(source.documentElement, candidate.documentElement);
  return new XMLSerializer().serializeToString(source);
}

/**
 * Update an existing child XML without rebuilding it from the reduced visual
 * model. Engine/propeller edits touch direct scalar fields only. System edits
 * merge generated modeled elements into the original DOM while retaining
 * unknown fields, lookup tables and comments.
 */
export function patchExistingSubfileXml(
  sourceXml: string,
  fileType: 'engine' | 'thruster' | 'system',
  params: Record<string, unknown>,
  generatedSystemXml?: string,
): string {
  if (!sourceXml.trim()) throw new Error('子文件原始 XML 为空');
  if (fileType === 'system') {
    if (!generatedSystemXml?.trim()) throw new Error('System XML 补丁内容为空');
    return patchSystemSource(sourceXml, generatedSystemXml);
  }
  return patchPropulsionSource(sourceXml, params);
}

