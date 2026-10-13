import type { Edge, Node } from '@xyflow/react';
import dagre from 'dagre';

interface ExpressionLayoutOptions {
  nodeSize: (node: Node) => { width: number; height: number };
  nodesep: number;
  ranksep: number;
  marginx: number;
  marginy: number;
}

/** Shared left-to-right layout for newly loaded trees and edited canvases. */
export function layoutExpressionNodes(nodes: Node[], edges: Edge[], options: ExpressionLayoutOptions): Node[] {
  if (!nodes.length) return nodes;
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: options.nodesep, ranksep: options.ranksep,
    marginx: options.marginx, marginy: options.marginy });

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    const size = options.nodeSize(node);
    sizes.set(node.id, size);
    graph.setNode(node.id, size);
  }
  for (const edge of edges) {
    if (sizes.has(edge.source) && sizes.has(edge.target))
      graph.setEdge(edge.source, edge.target, {}, edge.id);
  }

  dagre.layout(graph);
  return nodes.map(node => {
    const point = graph.node(node.id);
    const size = sizes.get(node.id)!;
    return point ? { ...node, position: {
      x: point.x - size.width / 2,
      y: point.y - size.height / 2,
    } } : node;
  });
}
