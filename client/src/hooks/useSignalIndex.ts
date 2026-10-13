import { useEffect, useMemo, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { indexGraphSignals, indexSubFileSignals, indexXmlSignals, mergeSignalIndexes, runtimeSignalIndex } from '../utils/signalIndex';
import type { Node } from '@xyflow/react';
import type { AircraftNodeData, ProjectXmlFile, SubFile } from '../types';
import type { SignalEntry } from '../utils/signalIndex';

let sharedIndex: { nodes: Node<AircraftNodeData>[]; files: ProjectXmlFile[]; subFiles: SubFile[]; runtimeKey: string; entries: SignalEntry[] } | null = null;
let xmlCache: { files: ProjectXmlFile[]; entries: SignalEntry[] } | null = null;
let graphCache: { nodes: Node<AircraftNodeData>[]; entries: SignalEntry[] } | null = null;
let subFileCache: { files: SubFile[]; entries: SignalEntry[] } | null = null;
function sameSignalNodes(a: Node<AircraftNodeData>[], b: Node<AircraftNodeData>[]): boolean {
  return a.length === b.length && a.every((node, index) =>
    node.id === b[index].id && node.data.params === b[index].data.params && node.data.label === b[index].data.label);
}
function projectSignalIndex(nodes: Node<AircraftNodeData>[], files: ProjectXmlFile[], subFiles: SubFile[], runtimePaths: string[]): SignalEntry[] {
  const runtimeKey = runtimePaths.join('\n');
  if (sharedIndex?.nodes === nodes && sharedIndex.files === files && sharedIndex.subFiles === subFiles && sharedIndex.runtimeKey === runtimeKey)
    return sharedIndex.entries;
  if (xmlCache?.files !== files) xmlCache = { files, entries: indexXmlSignals(files) };
  if (!graphCache || !sameSignalNodes(graphCache.nodes, nodes)) graphCache = { nodes, entries: indexGraphSignals(nodes) };
  if (subFileCache?.files !== subFiles) subFileCache = { files: subFiles, entries: indexSubFileSignals(subFiles) };
  const entries = mergeSignalIndexes(xmlCache.entries, graphCache.entries,
    subFileCache.entries, runtimeSignalIndex(runtimePaths));
  sharedIndex = { nodes, files, subFiles, runtimeKey, entries };
  return entries;
}

function readRuntimePaths(): string[] {
  if (typeof localStorage === 'undefined') return [];
  const paths = new Set<string>();
  for (const key of ['jsbsim-available-variables', 'jsbsim-global-variables']) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(saved)) saved.forEach(path => { if (typeof path === 'string') paths.add(path); });
    } catch { /* Ignore a corrupt legacy cache. */ }
  }
  return [...paths];
}

/** One project-wide index shared by all signal inputs. Unsaved graph edits are
 * included immediately; runtime paths are labeled as cached observations. */
export function useSignalIndex() {
  const nodes = useFlowStore(state => state.nodes);
  const xmlFiles = useFlowStore(state => state.xmlFiles);
  const subFiles = useFlowStore(state => state.subFiles);
  const [runtimePaths, setRuntimePaths] = useState(readRuntimePaths);

  useEffect(() => {
    const refresh = () => setRuntimePaths(readRuntimePaths());
    window.addEventListener('jsbsim-variables-updated', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('jsbsim-variables-updated', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return useMemo(() => projectSignalIndex(nodes, xmlFiles, subFiles, runtimePaths), [xmlFiles, nodes, subFiles, runtimePaths]);
}
