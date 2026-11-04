import { scanXmlSpans, type XmlSpan } from './sourcePreservingXml';
import { xmlContentEqual, xmlElementsEqual } from './xmlContentEqual';

export function parseXmlDocument(xml: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('无法准备 XML 变更：源码格式错误');
  return doc;
}

const markup = (element: Element) => new XMLSerializer().serializeToString(element);
const equal = xmlElementsEqual;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function key(element: Element): string {
  return element.tagName + ['name', 'file', 'number', 'axis', 'type'].map(attr => `|${attr}=${element.getAttribute(attr) || ''}`).join('');
}

function match(element: Element, candidates: Element[], used: Set<Element>): Element | undefined {
  return candidates.find(candidate => !used.has(candidate) && key(candidate) === key(element));
}

/** Apply only the before/after generator delta to complete original source.
 * Parser omissions and generator defaults are identical in both projections,
 * so they never overwrite comments, vendor fields or file references.
 */
export function applyXmlDelta(sourceXml: string, beforeXml: string, afterXml: string,
  onReference?: (source: Element, before: Element, after: Element) => void): string {
  if (xmlContentEqual(beforeXml, afterXml)) return sourceXml;
  const sourceDoc = parseXmlDocument(sourceXml);
  const before = parseXmlDocument(beforeXml).documentElement;
  const after = parseXmlDocument(afterXml).documentElement;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const newline = sourceXml.includes('\r\n') ? '\r\n' : '\n';
  const visit = (source: Element, old: Element, next: Element, span: XmlSpan, depth: number) => {
    if (equal(old, next)) return;
    if (depth === 1 && source.hasAttribute('file') && !old.hasAttribute('file') && !next.hasAttribute('file') && onReference) {
      onReference(source, old, next);
      return;
    }
    if (old.tagName !== next.tagName) {
      edits.push({ start: span.start, end: span.end, text: markup(next) });
      return;
    }
    let opening = sourceXml.slice(span.start, span.openEnd);
    const attrs = new Set([...Array.from(old.attributes), ...Array.from(next.attributes)].map(attr => attr.name));
    for (const attr of attrs) {
      if (old.getAttribute(attr) === next.getAttribute(attr)) continue;
      const value = next.getAttribute(attr);
      const expression = new RegExp(`(\\s${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)(["'])(.*?)\\2`);
      if (value === null) opening = opening.replace(expression, '');
      else if (expression.test(opening)) opening = opening.replace(expression, (_all, prefix) => `${prefix}"${escape(value)}"`);
      else opening = opening.replace(/\s*\/?>$/, ending => ` ${attr}="${escape(value)}"${ending}`);
    }
    const oldChildren = Array.from(old.children), nextChildren = Array.from(next.children);
    const sourceChildren = Array.from(source.children);
    if (!oldChildren.length && !nextChildren.length) {
      const value = next.textContent?.trim() || '';
      if ((old.textContent?.trim() || '') !== value) {
        if (span.closeStart === span.openEnd) {
          edits.push({ start: span.start, end: span.end, text: opening.replace(/\/>$/, '>') + escape(value) + `</${source.tagName}>` });
          return;
        }
        if (sourceChildren.length) throw new Error(`无法安全修改 ${source.tagName}：原始节点包含未建模的子元素`);
        const original = sourceXml.slice(span.openEnd, span.closeStart);
        if (source.hasAttribute('value')) opening = opening.replace(/(\svalue\s*=\s*)(["'])(.*?)\2/, (_all, prefix) => `${prefix}"${escape(value)}"`);
        else edits.push({ start: span.openEnd, end: span.closeStart,
          text: (original.match(/^\s*/)?.[0] || '') + escape(value) + (original.match(/\s*$/)?.[0] || '') });
      }
    } else {
      const usedNext = new Set<Element>(), usedSource = new Set<Element>();
      const pairs = oldChildren.map(child => {
        const target = match(child, sourceChildren, usedSource);
        if (target) usedSource.add(target);
        const nextChild = match(child, nextChildren, usedNext);
        if (nextChild) usedNext.add(nextChild);
        return { child, target, nextChild };
      });
      // A renamed element retains its unknown children and attributes.
      for (const pair of pairs) {
        if (!pair.nextChild) {
          const remaining = nextChildren.filter(child => !usedNext.has(child) && child.tagName === pair.child.tagName);
          const removed = pairs.filter(item => !item.nextChild && item.child.tagName === pair.child.tagName);
          if (remaining.length === removed.length && remaining.length) {
            pair.nextChild = remaining[0]; usedNext.add(remaining[0]);
          }
        }
        if (!pair.target) {
          const sameTag = sourceChildren.filter(child => !usedSource.has(child) && child.tagName === pair.child.tagName);
          const missing = pairs.filter(item => !item.target && item.child.tagName === pair.child.tagName);
          if (sameTag.length === missing.length && sameTag.length) {
            pair.target = sameTag[0]; usedSource.add(sameTag[0]);
          }
        }
      }
      const additions: Element[] = [];
      for (const { child, target, nextChild } of pairs) {
        if (target) {
          const childSpan = span.children[sourceChildren.indexOf(target)];
          if (nextChild) visit(target, child, nextChild, childSpan, depth + 1);
          else edits.push({ start: childSpan.start, end: childSpan.end, text: '' });
        } else if (source.hasAttribute(child.tagName) && !child.children.length && !nextChild?.children.length) {
          if (!nextChild || !equal(child, nextChild)) {
            const attribute = new RegExp(`(\\s${child.tagName}\\s*=\\s*)(["'])(.*?)\\2`);
            opening = nextChild ? opening.replace(attribute, (_all, prefix) => `${prefix}"${escape(nextChild.textContent?.trim() || '')}"`)
              : opening.replace(attribute, '');
          }
        } else if (nextChild && !equal(child, nextChild)) additions.push(nextChild);
        else if (!nextChild) throw new Error(`无法定位待删除的 XML 节点 ${child.tagName}`);
      }
      additions.push(...nextChildren.filter(child => !usedNext.has(child)));
      const retained = pairs.filter(pair => pair.target && pair.nextChild);
      const slots = [...retained].sort((a, b) => sourceChildren.indexOf(a.target!) - sourceChildren.indexOf(b.target!));
      const ordered = [...retained].sort((a, b) => nextChildren.indexOf(a.nextChild!) - nextChildren.indexOf(b.nextChild!));
      const locations = new Map<Element, XmlSpan>();
      slots.forEach((slot, index) => locations.set(ordered[index].target!, span.children[sourceChildren.indexOf(slot.target!)]));
      if (slots.some((slot, index) => slot !== ordered[index])) {
        const rendered = new Map<Element, string>();
        for (const pair of retained) {
          const originalSpan = span.children[sourceChildren.indexOf(pair.target!)];
          let text = sourceXml.slice(originalSpan.start, originalSpan.end);
          const nested = edits.filter(edit => edit.start >= originalSpan.start && edit.end <= originalSpan.end);
          for (const edit of nested.sort((a, b) => b.start - a.start || b.end - a.end)) {
            text = text.slice(0, edit.start - originalSpan.start) + edit.text + text.slice(edit.end - originalSpan.start);
          }
          rendered.set(pair.target!, text);
          nested.forEach(edit => edits.splice(edits.indexOf(edit), 1));
        }
        for (const pair of ordered) {
          const location = locations.get(pair.target!)!;
          edits.push({ start: location.start, end: location.end, text: rendered.get(pair.target!)! });
        }
      }
      if (additions.length) {
        const indent = sourceXml.slice(sourceXml.lastIndexOf('\n', span.start - 1) + 1, span.start).match(/^[ \t]*$/)?.[0] || '';
        const firstSpan = span.children[0];
        const childIndent = firstSpan
          ? sourceXml.slice(sourceXml.lastIndexOf('\n', firstSpan.start - 1) + 1, firstSpan.start).match(/^[ \t]*$/)?.[0] || `${indent}  `
          : `${indent}  `;
        const formatted = (child: Element) => {
          const originalIndent = child.previousSibling?.nodeValue?.match(/\n([ \t]*)$/)?.[1] || '';
          return markup(child).split(/\r?\n/).map((line, index) => index === 0 ? line
            : childIndent + (line.startsWith(originalIndent) ? line.slice(originalIndent.length) : line.trimStart())).join(newline);
        };
        const text = additions.map(child => `${newline}${childIndent}${formatted(child)}`).join('');
        if (span.closeStart === span.openEnd) {
          edits.push({ start: span.start, end: span.end,
            text: opening.replace(/\/>$/, '>') + text + `${newline}${indent}</${source.tagName}>` });
          return;
        }
        const insertions = new Map<number, string>();
        const trailing = sourceXml.slice(span.openEnd, span.closeStart).match(/(?:\r?\n[ \t]*)$/)?.[0] || '';
        for (const child of additions) {
          const following = nextChildren.slice(nextChildren.indexOf(child) + 1)
            .map(nextChild => pairs.find(pair => pair.nextChild === nextChild)?.target).find(Boolean);
          const position = following ? locations.get(following)!.start : span.closeStart - trailing.length;
          const inserted = following ? `${formatted(child)}${newline}${childIndent}` : `${newline}${childIndent}${formatted(child)}`;
          insertions.set(position, (insertions.get(position) || '') + inserted);
        }
        for (const [position, inserted] of insertions) edits.push({ start: position, end: position,
          text: inserted + (position === span.closeStart && !trailing ? newline + indent : '') });
      }
    }
    if (opening !== sourceXml.slice(span.start, span.openEnd)) edits.push({ start: span.start, end: span.openEnd, text: opening });
  };
  visit(sourceDoc.documentElement, before, after, scanXmlSpans(sourceXml), 0);
  let result = sourceXml, end = sourceXml.length;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > end) throw new Error('XML 变更范围重叠，无法安全保存');
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    end = edit.start;
  }
  parseXmlDocument(result);
  return result;
}
