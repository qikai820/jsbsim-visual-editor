import { xmlContentEqual } from './xmlContentEqual';

const MODELED_SYSTEM_CHILDREN = new Set([
  'property', 'function', 'fcs_function', 'channel',
  'summer', 'pure_gain', 'pid', 'integrator', 'scheduled_gain', 'bias',
  'constant', 'difference', 'product', 'quotient', 'pow', 'atan2', 'switch',
  'actuator', 'aerosurface_scale', 'angle', 'kinematic', 'deadband',
  'lag_filter', 'lead_lag_filter', 'second_order_filter', 'washout_filter',
  'sensor', 'gyro', 'accelerometer', 'magnetometer',
  'waypoint_distance', 'waypoint_heading',
]);
const FUNCTION_EXPRESSION_CHILDREN = new Set([
  'value', 'property', 'product', 'sum', 'difference', 'quotient', 'pow',
  'atan2', 'mod', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sqrt', 'exp', 'log', 'fraction', 'integer', 'toradians', 'todegrees',
  'not', 'min', 'max', 'avg', 'and', 'or', 'roundmultiple', 'gt', 'lt',
  'ge', 'le', 'eq', 'nq', 'ifthen', 'switch', 'table', 'pi', 'random', 'urandom',
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

type XmlSpan = {
  tag: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  children: XmlSpan[];
};
type TextEdit = { start: number; end: number; text: string };

function scanXmlSpans(xml: string): XmlSpan {
  const roots: XmlSpan[] = [];
  const stack: XmlSpan[] = [];
  const tagEnd = (from: number): number => {
    let quote = '';
    for (let index = from; index < xml.length; index++) {
      const char = xml[index];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') return index + 1;
    }
    throw new Error('XML 标签未闭合');
  };
  for (let index = 0; index < xml.length;) {
    const start = xml.indexOf('<', index);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) throw new Error('XML 注释未闭合');
      index = end + 3;
    } else if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) throw new Error('XML CDATA 未闭合');
      index = end + 3;
    } else if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) throw new Error('XML 处理指令未闭合');
      index = end + 2;
    } else if (xml.startsWith('<!', start)) {
      // DTD internal subsets need a full XML tokenizer; the caller uses the
      // DOM fallback for these uncommon files.
      throw new Error('XML 文档类型需要 DOM 合并');
    } else if (xml.startsWith('</', start)) {
      const end = tagEnd(start + 2);
      const tag = xml.slice(start + 2, end - 1).trim();
      const span = stack.pop();
      if (!span || span.tag !== tag) throw new Error('XML 标签范围不匹配');
      span.closeStart = start;
      span.end = end;
      index = end;
    } else {
      const end = tagEnd(start + 1);
      const tag = /^<([^\s/>]+)/.exec(xml.slice(start, end))?.[1];
      if (!tag) throw new Error('XML 标签名缺失');
      const selfClosing = /\/\s*>$/.test(xml.slice(start, end));
      const span: XmlSpan = { tag, start, openEnd: end, closeStart: end, end, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(span);
      else roots.push(span);
      if (!selfClosing) stack.push(span);
      index = end;
    }
  }
  if (stack.length || roots.length !== 1) throw new Error('XML 根节点范围不完整');
  return roots[0];
}

function patchSystemText(sourceXml: string, source: Element, candidate: Element): string {
  const root = scanXmlSpans(sourceXml);
  const edits: TextEdit[] = [];
  const serializer = new XMLSerializer();
  const lineEnding = sourceXml.includes('\r\n') ? '\r\n' : '\n';
  const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const indentation = (parent: XmlSpan, children: XmlSpan[]): string => {
    if (children.length) {
      const before = sourceXml.slice(parent.openEnd, children[0].start);
      const existing = before.match(/\n([ \t]*)$/)?.[1];
      if (existing !== undefined) return existing;
    }
    const lineStart = sourceXml.lastIndexOf('\n', parent.start - 1) + 1;
    const parentIndent = sourceXml.slice(lineStart, parent.start).match(/^[ \t]*$/)?.[0] || '';
    return `${parentIndent}  `;
  };
  const newMarkup = (element: Element, targetIndent: string): string => {
    const originalIndent = element.previousSibling?.nodeType === Node.TEXT_NODE
      ? element.previousSibling.nodeValue?.match(/\n([ \t]*)$/)?.[1] || '' : '';
    const lines = serializer.serializeToString(element).replace(/\r\n?/g, '\n').split('\n');
    return lines.map((line, index) => index === 0 ? line
      : targetIndent + (line.startsWith(originalIndent) ? line.slice(originalIndent.length) : line.trimStart()))
      .join(lineEnding);
  };
  const visit = (original: Element, wanted: Element, span: XmlSpan): void => {
    if (original.tagName !== span.tag) throw new Error('XML 节点位置不匹配');
    if (xmlContentEqual(serializer.serializeToString(original), serializer.serializeToString(wanted))) return;

    const sourceChildren = directElements(original);
    const candidateChildren = directElements(wanted);
    // The visual graph cannot represent a JSBSim lookup table. Its generated
    // <function/> is an absence of a patch, not an instruction to delete the
    // source table. A replacement expression needs an explicit source edit.
    if (original.tagName === 'function' && sourceChildren.some(child => child.tagName === 'table')) {
      if (candidateChildren.length === 0) return;
      throw new Error('查表函数不能通过图形模块替换，请直接编辑原始 XML');
    }
    if (sourceChildren.length !== span.children.length) throw new Error('XML 子节点位置不匹配');
    for (let index = 0; index < sourceChildren.length; index++) {
      if (sourceChildren[index].tagName !== span.children[index].tag) throw new Error('XML 子节点顺序不匹配');
    }

    const changedAttrs = Array.from(wanted.attributes).some(attr => original.getAttribute(attr.name) !== attr.value);
    if (changedAttrs) {
      const shallow = original.cloneNode(false) as Element;
      for (const attr of Array.from(wanted.attributes)) shallow.setAttribute(attr.name, attr.value);
      const opening = serializer.serializeToString(shallow).replace(/\/>$/, span.closeStart === span.openEnd ? '/>' : '>');
      edits.push({ start: span.start, end: span.openEnd, text: opening });
    }

    if (!sourceChildren.length && !candidateChildren.length) {
      if (original.textContent !== wanted.textContent) {
        if (span.closeStart === span.openEnd) throw new Error('自闭合元素的文本修改需要重新建模');
        const current = sourceXml.slice(span.openEnd, span.closeStart);
        if (original.childNodes.length > 1 || original.firstChild?.nodeType !== Node.TEXT_NODE) throw new Error('复杂文本节点需要 DOM 合并');
        const leading = current.match(/^\s*/)?.[0] || '';
        const trailing = current.match(/\s*$/)?.[0] || '';
        edits.push({ start: span.openEnd, end: span.closeStart,
          text: leading + escapeText((wanted.textContent || '').trim()) + trailing });
      }
      return;
    }

    const used = new Set<Element>();
    const additions: Element[] = [];
    for (const child of candidateChildren) {
      if (child.tagName === 'table' || child.tagName === 'tableData') continue;
      const match = matchingChild(original, child, used);
      if (match) {
        used.add(match);
        visit(match, child, span.children[sourceChildren.indexOf(match)]);
      } else additions.push(child);
    }
    for (let index = 0; index < sourceChildren.length; index++) {
      const child = sourceChildren[index];
      if (used.has(child)) continue;
      const remove = (original.tagName === 'system' || original.tagName === 'channel')
        ? MODELED_SYSTEM_CHILDREN.has(child.tagName)
        : original.tagName === 'function' && FUNCTION_EXPRESSION_CHILDREN.has(child.tagName);
      if (remove) {
        const childSpan = span.children[index];
        const previousEnd = index ? span.children[index - 1].end : span.openEnd;
        const leading = sourceXml.slice(previousEnd, childSpan.start).match(/(?:\r?\n[ \t]*)$/)?.[0] || '';
        edits.push({ start: childSpan.start - leading.length, end: childSpan.end, text: '' });
      }
    }
    if (additions.length) {
      if (span.closeStart === span.openEnd) throw new Error('自闭合元素需要 DOM 合并');
      const inner = sourceXml.slice(span.openEnd, span.closeStart);
      const trailing = inner.match(/(?:\r?\n[ \t]*)$/)?.[0] || '';
      const insertAt = span.closeStart - trailing.length;
      const childIndent = indentation(span, span.children);
      const inserted = additions.map(child => `${lineEnding}${childIndent}${newMarkup(child, childIndent)}`).join('');
      edits.push({ start: insertAt, end: insertAt, text: inserted + (trailing ? '' : `${lineEnding}${childIndent.slice(0, -2)}`) });
    }
  };
  visit(source, candidate, root);
  let result = sourceXml;
  let nextStart = sourceXml.length;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end > nextStart) throw new Error('XML 修改范围重叠');
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    nextStart = edit.start;
  }
  parseDocument(result, '修改后的 System XML');
  return result;
}

function patchSystemSource(sourceXml: string, generatedXml: string): string {
  const source = parseDocument(sourceXml, '原始 System 子文件');
  const candidate = parseDocument(generatedXml, '界面生成的 System 补丁');
  try {
    return patchSystemText(sourceXml, source.documentElement, candidate.documentElement);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const blocked = new Error(`无法安全定位 System XML 的最小修改，已取消保存：${reason}`);
    blocked.name = 'XmlPatchUnsafeError';
    throw blocked;
  }
}

/**
 * Update an existing child XML without rebuilding it from the reduced visual
 * model. Engine/propeller edits touch direct scalar fields only. System edits
 * apply byte-range patches to the original source, preserving unrelated
 * whitespace, comments, lookup tables and vendor fields.
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
