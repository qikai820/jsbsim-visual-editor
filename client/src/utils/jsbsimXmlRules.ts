import schema from './jsbsimXmlSchema.generated.json';

export type XmlValueKind = 'string' | 'number' | 'parameter' | 'numbers' | 'condition' | 'table' | 'atoi' | 'hex' | 'axis' | 'upper';
export interface XmlElementRule {
  text: XmlValueKind;
  children: Record<string, string>;
  attributes: Record<string, XmlValueKind>;
  defaults?: Record<string, string>;
  defaultsWhenEmpty?: boolean;
}
const types = schema.types as Record<string, XmlElementRule>;
const roots = schema.roots as Record<string, string>;

export function rootXmlRule(tag: string): XmlElementRule | undefined { return types[roots[tag]]; }
export function childXmlRule(parent: XmlElementRule | undefined, tag: string): XmlElementRule | undefined {
  return parent ? types[parent.children[tag]] : undefined;
}

/** Resolve the actual ancestry. An unknown extension starts an opaque subtree;
 * a known tag inside it never inherits an unrelated global numeric meaning.
 */
export function xmlElementRule(element: Element): XmlElementRule | undefined {
  const ancestors: Element[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
  let rule = rootXmlRule(ancestors[0].tagName);
  for (const node of ancestors.slice(1)) rule = childXmlRule(rule, node.tagName);
  return rule;
}

export function xmlAttributeKind(rule: XmlElementRule | undefined, element: Element, name: string): XmlValueKind {
  if (!rule) return 'string';
  // FGHIL/Viztra use floating-point readers, while the desktop socket parser
  // uses atoi. In particular socket port="5e3" means 5, never 5000.
  if (name === 'port' && rule === rootXmlRule(element.tagName) && ['input', 'output'].includes(element.tagName)) {
    if (/^(HIL(?:_SENSOR|_GPS)?|VIZTRA_UDP_(?:JSON|QGC))$/.test(element.getAttribute('type')?.toUpperCase() || '')) return 'number';
  }
  return rule.attributes[name] || 'string';
}
