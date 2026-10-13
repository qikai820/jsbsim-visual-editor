// JSBSim parses these element bodies as numbers. Its serializer can change
// their spelling (for example 1000000.0 -> 1000000) without changing a value.
const NUMERIC_ELEMENTS = new Set([
  'value', 'lag', 'noise', 'drift_rate', 'gain', 'bias', 'delay',
]);
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function sameNumericValue(a: Node, b: Node): boolean {
  const tag = a.parentElement?.tagName;
  if (!tag || tag !== b.parentElement?.tagName || !NUMERIC_ELEMENTS.has(tag)) return false;
  const first = (a.nodeValue || '').trim();
  const second = (b.nodeValue || '').trim();
  if (!DECIMAL_NUMBER.test(first) || !DECIMAL_NUMBER.test(second)) return false;
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  if (!Number.isFinite(firstNumber) || firstNumber !== secondNumber) return false;
  // Avoid conflating distinct integers beyond JavaScript's exact range.
  return !Number.isInteger(firstNumber) || Number.isSafeInteger(firstNumber);
}

/** Compare XML structure and JSBSim values without treating formatting as an edit. */
export function xmlContentEqual(left: string, right: string): boolean {
  if (left === right) return true;

  const parser = new DOMParser();
  const first = parser.parseFromString(left, 'application/xml');
  const second = parser.parseFromString(right, 'application/xml');
  if (first.querySelector('parsererror') || second.querySelector('parsererror')) return false;

  const meaningfulChildren = (node: Node): Node[] => Array.from(node.childNodes).filter(child =>
    child.nodeType !== Node.TEXT_NODE || !!child.nodeValue?.trim()
  );
  const equalNodes = (a: Node, b: Node): boolean => {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (a.nodeType === Node.ELEMENT_NODE) {
      const firstElement = a as Element;
      const secondElement = b as Element;
      if (firstElement.attributes.length !== secondElement.attributes.length) return false;
      for (const attribute of Array.from(firstElement.attributes)) {
        if (secondElement.getAttribute(attribute.name) !== attribute.value) return false;
      }
    } else if (a.nodeType === Node.DOCUMENT_TYPE_NODE) {
      if (new XMLSerializer().serializeToString(a) !== new XMLSerializer().serializeToString(b)) return false;
    } else if (a.nodeType !== Node.DOCUMENT_NODE && a.nodeValue !== b.nodeValue &&
               !(a.nodeType === Node.TEXT_NODE && sameNumericValue(a, b))) {
      return false;
    }
    const firstChildren = meaningfulChildren(a);
    const secondChildren = meaningfulChildren(b);
    return firstChildren.length === secondChildren.length &&
      firstChildren.every((child, index) => equalNodes(child, secondChildren[index]));
  };

  return equalNodes(first, second);
}
