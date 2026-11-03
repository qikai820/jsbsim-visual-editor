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

// A generated 1D table may differ only in indentation and numeric spelling.
// Require the same variables, row shapes and exact numeric values before
// keeping the source bytes. Unknown table shapes remain protected.
function equivalentLookupTable(source: Element, candidate: Element): boolean {
  if (source.tagName !== 'table' || candidate.tagName !== 'table') return false;
  const src = directElements(source), dst = directElements(candidate);
  if (src.length !== 2 || dst.length !== 2 ||
      src[0].tagName !== 'independentVar' || dst[0].tagName !== 'independentVar' ||
      src[1].tagName !== 'tableData' || dst[1].tagName !== 'tableData') return false;
  const attrsMatch = (a: Element, b: Element) => Array.from(b.attributes).every(attr =>
    a.getAttribute(attr.name) === attr.value ||
    (a.tagName === 'independentVar' && attr.name === 'lookup' && attr.value === 'row' && !a.hasAttribute('lookup')));
  if (!attrsMatch(source, candidate) || !attrsMatch(src[0], dst[0]) || !attrsMatch(src[1], dst[1])) return false;
  if (src[0].getAttribute('lookup') && src[0].getAttribute('lookup') !== 'row') return false;
  if (src[0].textContent?.trim() !== dst[0].textContent?.trim()) return false;
  if (src[1].children.length || dst[1].children.length || src[1].getAttribute('breakPoint')) return false;
  const rows = (element: Element) => (element.textContent || '').trim().split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).map(line => line.split(/\s+/));
  const a = rows(src[1]), b = rows(dst[1]);
  const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  return a.length === b.length && a.every((row, i) => row.length === 2 && b[i].length === 2 &&
    row.every((value, j) => number.test(value) && number.test(b[i][j]) &&
      Number.isFinite(Number(value)) && Number(value) === Number(b[i][j]) &&
      (!Number.isInteger(Number(value)) || Number.isSafeInteger(Number(value)))));
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
    // Keep the original table bytes when generation only changes formatting.
    // Do not silently discard a real table edit or replace an unsupported table.
    if (original.tagName === 'function' && sourceChildren.some(child => child.tagName === 'table')) {
      if (candidateChildren.length === 0) return;
      if (sourceChildren.length === 1 && candidateChildren.length === 1 &&
          equivalentLookupTable(sourceChildren[0], candidateChildren[0]) &&
          Array.from(wanted.attributes).every(attr => original.getAttribute(attr.name) === attr.value)) return;
      throw new Error('查表函数存在无法安全合并的修改，请直接编辑原始 XML');
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
