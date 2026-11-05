import { useLayoutEffect, useRef } from 'react';
import { useStoreApi, useUpdateNodeInternals } from '@xyflow/react';

const pending = new WeakMap<object, { ids: Set<string>; frame: number }>();

/** Opening N operators must publish one measurement batch, not N independent
 * store updates that each notify every node, toolbar and wire subscriber. */
export function useDiagramNodeInternals(id: string, geometryKey: string) {
  const store = useStoreApi();
  const update = useUpdateNodeInternals();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    // React Flow's shared ResizeObserver measures new nodes in one batch.
    if (!mounted.current) { mounted.current = true; return; }
    let batch = pending.get(store);
    if (!batch) {
      batch = { ids: new Set(), frame: 0 };
      pending.set(store, batch);
      batch.frame = requestAnimationFrame(() => {
        pending.delete(store);
        if (batch!.ids.size) update([...batch!.ids]);
      });
    }
    batch.ids.add(id);
    return () => {
      batch!.ids.delete(id);
      if (!batch!.ids.size && pending.get(store) === batch) { cancelAnimationFrame(batch!.frame); pending.delete(store); }
    };
  }, [id, geometryKey, store, update]);
}
