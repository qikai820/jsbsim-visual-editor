// Only our versioned comments represent disabled modules. Ordinary comments
// remain documentation and must never be interpreted as executable XML.
export const DISABLED_ATTRIBUTE = 'data-jsbve-disabled';
const HEADER = 'jsbve-disabled:v1';

export function decodeDisabledComment(text: string): string | null {
  if (!text.trimStart().startsWith(HEADER)) return null;
  const match = /^\s*jsbve-disabled:v1 encoding="(plain|base64)"\r?\n([\s\S]*)\r?\n$/.exec(text);
  if (!match) throw new Error('已注释模块的封装格式错误，无法无损恢复');
  const body = match[2].replace(/\r$/, '');
  if (match[1] === 'plain') return body;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(body.replace(/\s/g, '')), char => char.charCodeAt(0)));
  } catch { throw new Error('已注释模块的编码错误，无法无损恢复'); }
}

export function commentOutXml(xml: string): string {
  if (!xml.includes('--')) return `<!-- ${HEADER} encoding="plain"\n${xml}\n-->`;
  const bytes = new TextEncoder().encode(xml);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `<!-- ${HEADER} encoding="base64"\n${btoa(binary)}\n-->`;
}

/** Virtual elements keep comment slots aligned with the source-span scanner.
 * The reserved attribute exists only in memory and is never exported to JSBSim.
 */
export function expandDisabledComments(document: XMLDocument): XMLDocument {
  const visit = (parent: Node, depth: number) => {
    if (depth > 64) throw new Error('已注释模块嵌套层数过多');
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        const xml = decodeDisabledComment(node.nodeValue || '');
        if (xml === null) continue;
        const decoded = new DOMParser().parseFromString(xml, 'application/xml');
        if (decoded.querySelector('parsererror') || !decoded.documentElement) throw new Error('已注释模块内的 XML 无法解析');
        const element = document.importNode(decoded.documentElement, true);
        element.setAttribute(DISABLED_ATTRIBUTE, 'true');
        parent.replaceChild(element, node);
        visit(element, depth + 1);
      } else if (node.nodeType === Node.ELEMENT_NODE) visit(node, depth);
    }
  };
  visit(document, 0);
  return document;
}

export function serializeDisabledElements(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  const serialize = (node: Element): string => {
    for (const child of Array.from(node.children)) {
      const disabled = child.hasAttribute(DISABLED_ATTRIBUTE);
      const xml = serialize(child);
      if (disabled) child.replaceWith(node.ownerDocument.createComment(xml.slice(4, -3)));
    }
    const disabled = node.hasAttribute(DISABLED_ATTRIBUTE);
    node.removeAttribute(DISABLED_ATTRIBUTE);
    const xml = new XMLSerializer().serializeToString(node);
    return disabled ? commentOutXml(xml) : xml;
  };
  return serialize(clone);
}

export const moduleIsDisabled = (data: any): boolean => !!(data?.disabled || data?.channelDisabled || data?.moduleDisabled);
