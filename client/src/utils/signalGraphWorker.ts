import type { Edge, InternalNode, Node } from '@xyflow/react';

export interface SignalWorkerRequest {
  nodes: Node[];
  edges: Edge[];
  geometry: { id: string; measured: InternalNode['measured']; handleBounds: InternalNode['internals']['handleBounds'] }[];
}
export interface SignalWorkerResult { nodes: Node[]; edges: Edge[] }

/** Each job owns its worker: cancelling also stops synchronous WASM/ELK work,
 * rather than leaving obsolete jobs queued when a canvas is closed or edited. */
export function solveSignalGraph(
  nodes: Node[], edges: Edge[],
  getInternalNode: (id: string) => InternalNode | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<SignalWorkerResult> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Signal graph job cancelled', 'AbortError');
    if (options.signal?.aborted) { reject(aborted()); return; }
    const worker = new Worker(new URL('./signalGraph.worker.ts', import.meta.url), { type: 'module' });
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const fail = (error: Error) => { dispose(); reject(error); };
    const cancel = () => fail(aborted());
    const timer = setTimeout(() => fail(new Error('Signal graph solver timed out')), 60000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ result?: SignalWorkerResult; error?: string }>) => {
      dispose();
      if (data.result) resolve(data.result);
      else reject(new Error(data.error || 'Signal graph solver failed'));
    };
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Signal graph worker failed')); };
    worker.onmessageerror = () => fail(new Error('Invalid signal graph worker result'));
    try {
      // Send geometry only. Node data and edge labels may contain React values
      // or functions, and copying entire expression trees is unnecessary.
      const request: SignalWorkerRequest = {
        nodes: nodes.map(({ id, type, position, hidden, width, height, measured }) =>
          ({ id, type, position, hidden, width, height, measured, data: {} })),
        edges: edges.map(({ id, source, sourceHandle, target, targetHandle, hidden, data }) =>
          ({ id, source, sourceHandle, target, targetHandle, hidden,
            data: { bendpoints: data?.bendpoints, elkRoute: data?.elkRoute } })),
        geometry: nodes.flatMap(node => {
          const internal = getInternalNode(node.id);
          return internal ? [{ id: node.id, measured: internal.measured, handleBounds: internal.internals.handleBounds }] : [];
        }),
      };
      worker.postMessage(request);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
