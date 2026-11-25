import type { InternalNode } from '@xyflow/react';
import type { SignalWorkerRequest } from './signalGraphWorker';
import { computeSignalRoutes } from './signalRoutingEngine';

self.onmessage = async ({ data }: MessageEvent<SignalWorkerRequest>) => {
  try {
    const geometry = new Map(data.geometry.map(({ id, measured, handleBounds }) =>
      [id, { measured, internals: { handleBounds } } as InternalNode]));
    const getInternalNode = (id: string) => geometry.get(id);
    const edges = await computeSignalRoutes(data.nodes, data.edges, getInternalNode, data.wasmUrl);
    self.postMessage({ result: { nodes: data.nodes, edges } });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
