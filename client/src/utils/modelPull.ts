import type { PreparedXml } from './modelXmlSync';
import { xmlContentEqual } from './xmlContentEqual';

export type PullChange = 'added' | 'modified' | 'removed' | 'text' | 'same';
export interface PulledDocument extends PreparedXml { pullChange: PullChange }

/** Compare the prepared editor contents with a fully downloaded snapshot.
 * Local-only files must remain visible: accepting replaces the whole model.
 */
export function comparePulledModel(local: PreparedXml[], incoming: PreparedXml[]) {
  const before = new Map(local.map(file => [file.path, file]));
  const after = new Map(incoming.map(file => [file.path, file]));
  const localContents: Record<string, string | null> = {};
  const documents: PulledDocument[] = [];
  const counts: Record<PullChange, number> = { added: 0, modified: 0, removed: 0, text: 0, same: 0 };
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path), next = after.get(path);
    const sameContent = old?.content === next?.content;
    const sameModel = old && next && (path.endsWith('.json')
      ? sameContent : xmlContentEqual(old.content, next.content));
    const pullChange: PullChange = !old ? 'added' : !next ? 'removed'
      : sameContent ? 'same' : sameModel ? 'text' : 'modified';
    counts[pullChange]++;
    localContents[path] = old?.content ?? null;
    documents.push({ path, content: next?.content ?? '', category: next?.category || old?.category,
      dirty: pullChange !== 'same', pullChange });
  }
  return { documents, localContents, counts };
}
