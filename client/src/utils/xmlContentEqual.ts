import { childXmlRule, xmlAttributeKind, xmlElementRule, type XmlElementRule, type XmlValueKind } from './jsbsimXmlRules';

/** Exact decimal normalization; never round through Number or use an epsilon.
 * Keep arbitrarily large integers/exponents and subnormal decimal differences.
 */
export function normalizeXmlNumber(value: string): string | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  let digits = ((match[2] || '') + fraction).replace(/^0+/, '');
  // IEEE-754 signed zero can affect quotient/atan2 operations. Only spelling
  // changes of the same signed zero are equivalent.
  if (!digits) return match[1] === '-' ? '-0' : '0';
  let exponent = BigInt(match[5] || '0') - BigInt(fraction.length);
  const trailing = digits.match(/0+$/)?.[0].length || 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += BigInt(trailing);
  const sign = match[1] === '-' ? '-' : '';
  const point = BigInt(digits.length) + exponent;
  // Readable ordinary decimals for the usual range; huge exponents never
  // allocate an enormous expanded string.
  if (point > -6n && point <= 21n) {
    const index = Number(point);
    if (index <= 0) return `${sign}0.${'0'.repeat(-index)}${digits}`;
    if (index >= digits.length) return sign + digits + '0'.repeat(index - digits.length);
    return `${sign}${digits.slice(0, index)}.${digits.slice(index)}`;
  }
  return `${sign}${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${point - 1n}`;
}

type SemanticNode =
  | { kind: 'element'; name: string; attributes: [string, string][]; children: SemanticNode[] }
  | { kind: 'text' | 'markup'; value: string };

export interface XmlSemanticDocument {
  key: string;
  xml: string;
  comments: string;
}
export interface XmlContentComparison {
  equal: boolean;
  left: XmlSemanticDocument | null;
  right: XmlSemanticDocument | null;
  error?: string;
  commentsDiffer: boolean;
}

const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;')
  .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

export function normalizeXmlField(kind: XmlValueKind, value: string): string {
  if (kind === 'string') return value;
  if (kind === 'number' || kind === 'parameter') return normalizeXmlNumber(value) ?? value;
  if (kind === 'atoi') {
    // Only normalize representations that atoi also reads identically. Keep
    // exponents, nonzero fractional suffixes and invalid text conservative.
    return /^[+-]?\d+(?:\.0*)?$/.test(value.trim()) ? normalizeXmlNumber(value)! : value;
  }
  if (kind === 'hex') {
    const bytes = value.replace(/[ \t,:-]/g, '');
    return /^(?:[0-9a-f]{2})*$/i.test(bytes) ? bytes.toUpperCase() : value;
  }
  if (kind === 'upper') return value.toUpperCase();
  if (kind === 'axis') {
    if (value === '' || value === 'row' || value === 'axis1') return 'row';
    if (value === 'column' || value === 'axis2') return 'column';
    if (value === 'table' || value === 'axis3') return 'table';
    if (/^axis\d+$/.test(value) && BigInt(value.slice(4)) >= 1n) {
      const axis = BigInt(value.slice(4));
      return axis === 1n ? 'row' : axis === 2n ? 'column' : axis === 3n ? 'table' : `axis${axis}`;
    }
    return value;
  }
  if (kind === 'condition') {
    const operators: Record<string, string> = { '==': 'eq', EQ: 'eq', eq: 'eq', '!=': 'ne', NE: 'ne', ne: 'ne',
      '<': 'lt', LT: 'lt', lt: 'lt', '<=': 'le', LE: 'le', le: 'le', '>': 'gt', GT: 'gt', gt: 'gt', '>=': 'ge', GE: 'ge', ge: 'ge' };
    return value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split(/ +/);
      return parts.length === 3 && operators[parts[1]] ? `${parts[0]} ${operators[parts[1]]} ${normalizeXmlNumber(parts[2]) ?? parts[2]}` : line;
    }).join('\n');
  }
  if (kind === 'table' || kind === 'numbers') {
    const rows = value.split(/\r?\n/).map(row => row.trim()).filter(Boolean)
      .map(row => row.split(/\s+/).map(normalizeXmlNumber));
    // Retain row boundaries and column counts, including the header of 2D
    // tables. Invalid/unsupported data falls back to exact text comparison.
    if (rows.length && rows.every(row => row.every(cell => cell !== null))) {
      return rows.map(row => row.join(' ')).join(kind === 'table' ? '\n' : ' ');
    }
  }
  // FGXMLParse::dumpDataLines uses split(...,'\n'), which trims each line.
  return value.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

/** Full XML projection, independent of the reduced visual-editor parser.
 * Comments are tracked separately; unknown nodes, attributes and order survive.
 */
export function parseXmlSemantics(xml: string, context?: Element): XmlSemanticDocument {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error || !document.documentElement) throw new Error('XML 格式错误，无法进行语义比较');
  const comments: string[] = [];
  const serializer = new XMLSerializer();
  const children = (parent: Node, preserve = false, parentRule?: XmlElementRule): SemanticNode[] => {
    const result: SemanticNode[] = [];
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) { comments.push(node.nodeValue || ''); continue; }
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        const value = node.nodeValue || '';
        const previous = result[result.length - 1];
        if (previous?.kind === 'text') previous.value += value;
        else result.push({ kind: 'text', value });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        const space = element.getAttribute('xml:space');
        const keepSpace = space === 'preserve' || space !== 'default' && preserve;
        const rule = parent.nodeType === Node.DOCUMENT_NODE ? xmlElementRule(context || element) : childXmlRule(parentRule, element.tagName);
        const attributes: [string, string][] = Array.from(element.attributes).map(attr => [attr.name,
          normalizeXmlField(xmlAttributeKind(rule, element, attr.name), attr.value)]);
        for (const [name, value] of Object.entries(rule?.defaults || {})) {
          if (!element.hasAttribute(name)) attributes.push([name, value]);
          else if (rule?.defaultsWhenEmpty && element.getAttribute(name) === '') attributes.find(attr => attr[0] === name)![1] = value;
        }
        // ParseLookupAxis treats omitted/empty lookup as row. Axis aliases are
        // normalized without reordering variables, layers or table rows.
        if (rule?.attributes.lookup === 'axis' && !element.hasAttribute('lookup')) {
          attributes.push(['lookup', 'row']);
        }
        attributes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const name = rule && element.tagName === 'v' ? 'value'
          : rule && element.tagName === 'p' ? 'property' : rule && element.tagName === 't' ? 'table' : element.tagName;
        result.push({ kind: 'element', name, attributes, children: children(element, keepSpace, rule) });
      } else {
        // DTDs and processing instructions can carry meaning; keep them.
        result.push({ kind: 'markup', value: serializer.serializeToString(node) });
      }
    }
    const hasElements = result.some(node => node.kind === 'element');
    const mixed = hasElements && result.some(node => node.kind === 'text' && !!node.value.trim());
    const filtered = !preserve && !mixed
      ? result.filter(node => node.kind !== 'text' || !!node.value.trim()) : result;
    if (parent.nodeType === Node.ELEMENT_NODE && !hasElements && filtered.every(node => node.kind === 'text')) {
      const raw = filtered.map(node => (node as { value: string }).value).join('');
      const value = !preserve && parentRule ? parentRule.text === 'string'
        ? raw.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
        : normalizeXmlField(parentRule.text, raw) : raw;
      return value ? [{ kind: 'text', value }] : [];
    }
    if (!preserve && parentRule?.text === 'condition') {
      for (const node of filtered) if (node.kind === 'text') node.value = normalizeXmlField('condition', node.value);
    }
    return filtered;
  };
  let inheritedSpace = false;
  for (let parent = context?.parentElement; parent; parent = parent.parentElement) {
    if (parent.hasAttribute('xml:space')) { inheritedSpace = parent.getAttribute('xml:space') === 'preserve'; break; }
  }
  const nodes = children(document, inheritedSpace);
  const render = (node: SemanticNode, depth = 0, inline = false): string => {
    if (node.kind !== 'element') return node.kind === 'text' ? escapeText(node.value) : node.value;
    const indent = inline ? '' : '  '.repeat(depth);
    const opening = `<${node.name}${node.attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')}`;
    if (!node.children.length) return `${indent}${opening}/>`;
    const closing = `</${node.name}>`;
    const text = node.children.length === 1 && node.children[0].kind === 'text' ? node.children[0].value : null;
    if (node.name === 'tableData' && text !== null && !inline) {
      return `${indent}${opening}>\n${text.split('\n').map(row => `${indent}  ${escapeText(row)}`).join('\n')}\n${indent}${closing}`;
    }
    if (inline || node.children.some(child => child.kind === 'text')) {
      return `${indent}${opening}>${node.children.map(child => render(child, 0, true)).join('')}${closing}`;
    }
    return `${indent}${opening}>\n${node.children.map(child => render(child, depth + 1)).join('\n')}\n${indent}${closing}`;
  };
  return { key: JSON.stringify(nodes), xml: nodes.map(node => render(node)).join('\n'), comments: JSON.stringify(comments) };
}

export function compareXmlContent(left: string, right: string): XmlContentComparison {
  let first: XmlSemanticDocument | null = null, second: XmlSemanticDocument | null = null;
  const errors: string[] = [];
  try { first = parseXmlSemantics(left); } catch { errors.push('左侧 XML 格式错误'); }
  try { second = left === right && first ? first : parseXmlSemantics(right); } catch { errors.push('右侧 XML 格式错误'); }
  return { equal: !!first && !!second && first.key === second.key, left: first, right: second,
    error: errors.length ? `${errors.join('；')}，无法进行语义比较` : undefined,
    commentsDiffer: !!first && !!second && first.comments !== second.comments };
}

/** Shared by preparation, source patches, dirty state, upload and review UI. */
export function xmlContentEqual(left: string, right: string): boolean {
  return compareXmlContent(left, right).equal;
}

/** Patch comparisons retain ancestry, including overloaded FCS/math tags. */
export function xmlElementsEqual(left: Element, right: Element): boolean {
  const serializer = new XMLSerializer();
  return parseXmlSemantics(serializer.serializeToString(left), left).key ===
    parseXmlSemantics(serializer.serializeToString(right), right).key;
}
