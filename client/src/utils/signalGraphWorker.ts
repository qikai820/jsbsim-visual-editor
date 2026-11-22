import type { Edge, InternalNode, Node } from '@xyflow/react';
import SignalGraphWorker from './signalGraph.worker?worker';

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
    // Vite selects a module worker in dev and a self-contained classic worker
    // in production. Desktop WebViews need not load a chain of worker modules.
    let worker: Worker;
    try { worker = new SignalGraphWorker(); }
    catch (error) {
      reject(new Error(`无法启动连线计算线程：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const fail = (error: Error) => { dispose(); reject(error); };
    const cancel = () => fail(aborted());
    const timer = setTimeout(() => fail(new Error('连线计算超时（60 秒）')), 60000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ result?: SignalWorkerResult; error?: string }>) => {
      dispose();
      if (data.result) resolve(data.result);
      else reject(new Error(data.error || 'Signal graph solver failed'));
    };
    worker.onerror = event => {
      event.preventDefault();
      fail(new Error(`连线计算线程加载或执行失败${event.message ? `：${event.message}` : ''}`));
    };
    worker.onmessageerror = () => fail(new Error('无法读取连线计算线程的结果'));
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
