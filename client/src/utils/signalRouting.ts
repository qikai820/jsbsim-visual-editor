import type { Edge, InternalNode, Node } from '@xyflow/react';
import { SIGNAL_NODE_CLEARANCE, signalObstacles, signalRouteIsClear } from './signalClearance';
import { separateSignalTracks } from './separateSignalTracks';
import { mergeSignalBranches } from './mergeSignalBranches';
import type { SignalRoute } from './signalLayout';
import wasmUrl from '../../../node_modules/libavoid-js/dist/libavoid.wasm?url';

let library: Promise<any> | undefined;
function loadRouter() {
  return library ??= import('../../../node_modules/libavoid-js/dist/index.js').then(async ({ AvoidLib }) => {
    await AvoidLib.load(wasmUrl);
    return AvoidLib.getInstance();
  }).catch(error => { library = undefined; throw error; });
}

type Point = { x: number; y: number };
const near = (a: number, b: number) => Math.abs(a - b) < .01;
function onSegment(p: Point, a: Point, b: Point) {
  return (near(a.x, b.x) && near(p.x, a.x) || near(a.y, b.y) && near(p.y, a.y)) &&
    p.x >= Math.min(a.x, b.x) - .01 && p.x <= Math.max(a.x, b.x) + .01 &&
    p.y >= Math.min(a.y, b.y) - .01 && p.y <= Math.max(a.y, b.y) + .01;
}

/** Only draw a junction when three directions of the SAME signal meet. */
function addJunctions(edges: Edge[]) {
  const groups = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!e.data?.elkRoute) continue;
    const key = JSON.stringify([e.source, e.sourceHandle]);
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const routes = group.map(e => e.data!.elkRoute as SignalRoute);
    const points = new Map<string, Point>();
    for (const r of routes) for (const p of r.points.slice(1, -1)) points.set(`${p.x},${p.y}`, p);
    for (const p of points.values()) {
      const dirs = new Set<string>();
      for (const r of routes) for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1], b = r.points[i];
        if (!onSegment(p, a, b)) continue;
        for (const q of [a, b]) {
          if (q.x < p.x - .01) dirs.add('W'); if (q.x > p.x + .01) dirs.add('E');
          if (q.y < p.y - .01) dirs.add('N'); if (q.y > p.y + .01) dirs.add('S');
        }
      }
      if (dirs.size < 3) continue;
      for (const r of routes) if (r.points.some((b, i) => i > 0 && onSegment(p, r.points[i - 1], b))) r.junctions.push(p);
    }
  }
}

/** Route without moving any node. libavoid separates parallel paths globally;
 * shared output pins remain non-exclusive so a signal can branch naturally. */
export async function routeSignalGraph(nodes: Node[], edges: Edge[], getInternalNode: (id: string) => InternalNode | undefined): Promise<Edge[]> {
  const a = await loadRouter();
  const router = new a.Router(2); // Avoid::OrthogonalRouting bit flag
  const temporaries: any[] = [];
  const keep = <T,>(object: T): T => { temporaries.push(object); return object; };
  try {
    for (const [name, value] of Object.entries({ segmentPenalty: 30, crossingPenalty: 100,
      fixedSharedPathPenalty: 10000, shapeBufferDistance: SIGNAL_NODE_CLEARANCE, idealNudgingDistance: 12 })) {
      router.setRoutingParameter(a.RoutingParameter[name], value);
    }
    router.setRoutingOption(a.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, false);
    router.setRoutingOption(a.RoutingOption.nudgeOrthogonalTouchingColinearSegments, true);
    // Different pins on the same block must also get separate tracks.
    router.setRoutingOption(a.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
    router.setRoutingOption(a.RoutingOption.penaliseOrthogonalSharedPathsAtConnEnds, true);
    const ends = new Map<string, any>();
    const endpointId = (e: Edge, side: 'source' | 'target') => JSON.stringify([e[side], side, e[`${side}Handle`] ?? '']);
    for (const n of nodes) {
      if (n.hidden) continue;
      const internal = getInternalNode(n.id);
      const width = internal?.measured.width ?? n.measured?.width ?? 64;
      const height = internal?.measured.height ?? n.measured?.height ?? 48;
      const ports = new Map<string, { x: number; y: number; side: 'source' | 'target' }>();
      for (const e of edges) for (const side of ['source', 'target'] as const) {
        if (e[side] !== n.id || e.hidden) continue;
        const handleId = e[`${side}Handle`];
        const handle = internal?.internals.handleBounds?.[side]?.find(h => handleId ? h.id === handleId : true);
        if (!handle) continue;
        ports.set(endpointId(e, side), { side,
          x: handle.x + (side === 'source' ? handle.width : 0), y: handle.y + handle.height / 2 });
      }
      const left = Math.min(0, ...[...ports.values()].map(p => p.x));
      const right = Math.max(width, ...[...ports.values()].map(p => p.x));
      const p = keep(new a.Point(n.position.x + left, n.position.y));
      const q = keep(new a.Point(n.position.x + right, n.position.y + height));
      const rect = keep(new a.Rectangle(p, q));
      const shape = new a.ShapeRef(router, rect);
      let pinId = 1;
      for (const [key, port] of ports) {
        const pin = new a.ShapeConnectionPin(shape, pinId,
          Math.max(0, Math.min(1, (port.x - left) / (right - left))), port.y / height,
          true, 0, port.side === 'source' ? 8 : 4);
        pin.setExclusive(false);
        ends.set(key, keep(new a.ConnEnd(shape, pinId++)));
      }
    }
    const connections = new Map<string, any>();
    for (const e of edges) {
      const src = ends.get(endpointId(e, 'source')), dst = ends.get(endpointId(e, 'target'));
      if (!src || !dst || e.hidden) continue;
      const conn = new a.ConnRef(router, src, dst); // owned by router
      const bps = e.data?.bendpoints as Point[] | undefined;
      if (bps?.length) {
        const checkpoints = keep(new a.CheckpointVector());
        for (const p of bps) checkpoints.push_back(keep(new a.Checkpoint(keep(new a.Point(p.x, p.y)))));
        conn.setRoutingCheckpoints(checkpoints);
      }
      connections.set(e.id, conn);
    }
    router.processTransaction();
    const result = edges.map(e => {
      const conn = connections.get(e.id);
      if (!conn) return e;
      // displayRoute()/at() return references owned by the connector. Deleting
      // these borrowed objects corrupts libavoid's heap on the next route.
      const line = conn.displayRoute();
      const points: Point[] = [];
      for (let i = 0; i < line.size(); i++) {
        const p = line.at(i);
        points.push({ x: p.x, y: p.y });
      }
      if (points.length < 2) throw new Error(`No route for ${e.id}`);
      return { ...e, type: 'signal', data: { ...e.data, srcOffset: 0, tgtOffset: 0,
        elkRoute: { points, junctions: [] } satisfies SignalRoute } };
    });
    separateSignalTracks(result, nodes);
    mergeSignalBranches(result, nodes);
    const obstacles = signalObstacles(nodes);
    for (const edge of result) {
      const route = edge.data?.elkRoute as SignalRoute | undefined;
      edge.data = { ...edge.data, routingBlocked: !edge.hidden && (!route || !signalRouteIsClear(route.points, edge, obstacles)) };
    }
    addJunctions(result);
    return result;
  } finally {
    router.delete();
    for (const object of temporaries.reverse()) object.delete();
  }
}
