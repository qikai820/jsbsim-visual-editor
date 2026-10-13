import { SIGNAL_NODE_CLEARANCE } from './signalClearance';
import type { Node, Edge, InternalNode } from '@xyflow/react';
import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';

export interface SignalRoute {
  points: { x: number; y: number }[];
  junctions: { x: number; y: number }[];
}

/** Use the rendered bounds, including the exact connection point on each
 * handle. Fixed ports preserve JSBSim input order while ELK routes around
 * blocks and shares the trunk of wires leaving the same output. */
export async function layoutSignalGraph(
  nodes: Node[], edges: Edge[], getInternalNode: (id: string) => InternalNode | undefined,
  aspectRatio = 1.6,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const visible = nodes.filter(n => !n.hidden);
  const nodeIds = new Set(visible.map(n => n.id));
  const links = edges.filter(e => !e.hidden && nodeIds.has(e.source) && nodeIds.has(e.target));
  const portId = (id: string, side: string, handle?: string | null) => JSON.stringify([id, side, handle ?? '']);
  const children: ElkNode[] = visible.map(node => {
    const internal = getInternalNode(node.id);
    const width = internal?.measured?.width ?? node.measured?.width ?? 94;
    const height = internal?.measured?.height ?? node.measured?.height ?? 58;
    const ports = new Map<string, ElkPort>();
    for (const edge of links) {
      for (const side of ['source', 'target'] as const) {
        if (edge[side] !== node.id) continue;
        const handleId = side === 'source' ? edge.sourceHandle : edge.targetHandle;
        const id = portId(node.id, side, handleId);
        if (ports.has(id)) continue;
        const handle = internal?.internals.handleBounds?.[side]?.find(h => h.id === handleId);
        // React Flow attaches at the outer right/left edge of the handle.
        const x = handle ? handle.x + (side === 'source' ? handle.width : 0) : side === 'source' ? width : 0;
        const y = handle ? handle.y + handle.height / 2 : height / 2;
        ports.set(id, { id, x, y, width: 0, height: 0,
          layoutOptions: {
            'elk.port.side': side === 'source' ? 'EAST' : 'WEST',
            // FIXED_POS fixes the along-border coordinate only; ELK otherwise
            // snaps x to the node border, losing the arrow's protrusion.
            'elk.port.borderOffset': String(side === 'source' ? x - width : -x),
          } });
      }
    }
    return { id: node.id, width, height, ports: [...ports.values()],
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } };
  });
  if (!children.length) return { nodes, edges };
  const elk = new ELK();
  const graph = await elk.layout<ElkNode>({
    id: 'signal-root', children,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      'elk.spacing.nodeNode': String(SIGNAL_NODE_CLEARANCE * 2 + 16),
      'elk.spacing.edgeNode': String(SIGNAL_NODE_CLEARANCE + 6),
      'elk.spacing.edgeEdge': '10',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.spacing.edgeNodeBetweenLayers': String(SIGNAL_NODE_CLEARANCE + 6),
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.layered.compaction.connectedComponents': 'true',
      'elk.separateConnectedComponents': 'true',
      'elk.aspectRatio': String(aspectRatio),
      'elk.randomSeed': '1',
    },
    edges: links.map(e => ({ id: e.id,
      sources: [portId(e.source, 'source', e.sourceHandle)],
      targets: [portId(e.target, 'target', e.targetHandle)] })),
  });
  const positions = new Map(graph.children?.map(n => [n.id, n]));
  const routes = new Map(graph.edges?.map(e => [e.id, e]));
  return {
    nodes: nodes.map(node => {
      const p = positions.get(node.id);
      return p ? { ...node, position: { x: p.x!, y: p.y! } } : node;
    }),
    edges: edges.map(edge => {
      const route = routes.get(edge.id);
      const section = route?.sections?.[0];
      if (!section) return edge;
      const { bendpoints, routeX, routeLocked, ...data } = edge.data || {};
      return { ...edge, type: 'signal', data: { ...data, srcOffset: 0, tgtOffset: 0,
        elkRoute: { points: [section.startPoint, ...(section.bendPoints || []), section.endPoint],
          junctions: route?.junctionPoints || [] } satisfies SignalRoute } };
    }),
  };
}
