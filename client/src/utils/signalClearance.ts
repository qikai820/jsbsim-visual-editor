import type { Edge, Node } from '@xyflow/react';

/** Flow units, independent of zoom. The rectangle interior is a routing keepout. */
export const SIGNAL_NODE_CLEARANCE = 12;
export type SignalPoint = { x: number; y: number };
export interface SignalObstacle { id: string; x: number; y: number; width: number; height: number }
const epsilon = .05;

export function signalObstacles(nodes: Node[]): SignalObstacle[] {
  return nodes.filter(n => !n.hidden).map(n => ({ id: n.id, x: n.position.x, y: n.position.y,
    width: n.measured?.width || n.width || 64, height: n.measured?.height || n.height || 48 }));
}

export function signalRouteIsClear(points: SignalPoint[], edge: Pick<Edge, 'source' | 'target'>, obstacles: SignalObstacle[]) {
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const horizontal = Math.abs(a.y - b.y) < epsilon;
    if (!horizontal && Math.abs(a.x - b.x) >= epsilon) return false;
    for (const r of obstacles) {
      // Exempt only the outward/approach lead of this exact endpoint, never
      // the whole source/target block and never an unrelated signal's path.
      if (i === 1 && r.id === edge.source && horizontal && a.x >= r.x + r.width - epsilon && b.x >= a.x) continue;
      if (i === points.length - 1 && r.id === edge.target && horizontal && b.x <= r.x + epsilon && a.x <= b.x) continue;
      const left = r.x - SIGNAL_NODE_CLEARANCE + epsilon, right = r.x + r.width + SIGNAL_NODE_CLEARANCE - epsilon;
      const top = r.y - SIGNAL_NODE_CLEARANCE + epsilon, bottom = r.y + r.height + SIGNAL_NODE_CLEARANCE - epsilon;
      if (horizontal ? a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right
        : a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom) return false;
    }
  }
  return true;
}
