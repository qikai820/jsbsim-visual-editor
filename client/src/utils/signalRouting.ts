import type { Edge, InternalNode, Node } from '@xyflow/react';
import { solveSignalGraph } from './signalGraphWorker';

/** Route without moving nodes; synchronous WASM and path refinement stay in a
 * cancellable worker so large graphs cannot freeze the editor. */
export async function routeSignalGraph(
  nodes: Node[], edges: Edge[], getInternalNode: (id: string) => InternalNode | undefined,
  signal?: AbortSignal,
): Promise<Edge[]> {
  const result = await solveSignalGraph(nodes, edges, getInternalNode, { signal });
  const routes = new Map(result.edges.map(edge => [edge.id, edge]));
  return edges.map(edge => {
    const routed = routes.get(edge.id);
    return routed ? { ...edge, type: routed.type || edge.type, data: { ...edge.data, ...routed.data } } : edge;
  });
}
