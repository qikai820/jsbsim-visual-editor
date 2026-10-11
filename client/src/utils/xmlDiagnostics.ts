import { XMLValidator } from 'fast-xml-parser';

export function validateXmlSource(xml: string, path: string): void {
  // The validator counts UTF-16 code units and LF lines. Normalize XML line
  // endings, then expose character columns consistently with the native loader.
  const normalized = xml.replace(/\r\n?/g, '\n');
  const result = XMLValidator.validate(normalized);
  if (result === true) return;
  const { line = 1, col: rawCol = 1, msg } = result.err;
  const source = normalized.split('\n')[line - 1] || '';
  const col = Array.from(source.slice(0, rawCol - 1)).length + 1;
  const skip = Math.max(0, col - 61);
  const prefix = `${line} | ${skip ? '...' : ''}`;
  const excerpt = Array.from(source).slice(skip, skip + 160).join('').replace(/\t/g, ' ');
  throw new Error(`${path}:${line}:${col}:\n${prefix}${excerpt}\n${' '.repeat(prefix.length + Math.max(0, col - 1 - skip))}^\nXML: ${msg}`);
}

export function showXmlDiagnostic(error: unknown, title = 'XML 加载诊断'): void {
  const message = error instanceof Error ? error.message : String(error || '加载失败');
  window.dispatchEvent(new CustomEvent('jsbsim-xml-diagnostic', { detail: { title, message } }));
}
