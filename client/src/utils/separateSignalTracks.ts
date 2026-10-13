import type { Edge, Node } from '@xyflow/react';
import { signalObstacles, signalRouteIsClear } from './signalClearance';
import type { SignalRoute } from './signalLayout';
type P = { x: number; y: number };
const eps = .05;
const near = (a: number, b: number) => Math.abs(a - b) < eps;
const net = (e: Edge) => JSON.stringify([e.source, e.sourceHandle]);
function segments(points: P[]) { return points.slice(1).map((b, i) => ({ a: points[i], b })); }
function overlap(a: P, b: P, c: P, d: P) {
  const v = near(a.x, b.x) && near(c.x, d.x) && near(a.x, c.x);
  const h = near(a.y, b.y) && near(c.y, d.y) && near(a.y, c.y);
  const axis = v ? 'y' : 'x';
  return (v || h) && Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
    Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > eps;
}
function compact(points: P[]) {
  const out: P[] = [];
  for (const p of points) {
    if (out.length && near(p.x, out[out.length - 1].x) && near(p.y, out[out.length - 1].y)) continue;
    const a = out[out.length - 2], b = out[out.length - 1];
    if (a && b && (near(a.x, b.x) && near(b.x, p.x) || near(a.y, b.y) && near(b.y, p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/** Fixed port leads are deliberately excluded from libavoid's nudging. Split
 * residual coincident tracks here, moving only bends through obstacle-free
 * space and keeping every source/target coordinate unchanged. */
export function separateSignalTracks(edges: Edge[], nodes: Node[]): Edge[] {
  const obstacles = signalObstacles(nodes);
  const occupied: { a: P; b: P; net: string }[] = [];
  for (const edge of edges) {
    const route = edge.data?.elkRoute as SignalRoute | undefined;
    if (!route) continue;
    const signal = net(edge);
    const others = occupied.filter(s => s.net !== signal);
    const conflicts = (points: P[]) => segments(points).reduce((n, s) =>
      n + others.filter(o => overlap(s.a, s.b, o.a, o.b)).length, 0);
    const clear = (points: P[]) => signalRouteIsClear(points, edge, obstacles);
    let points = compact(route.points), count = conflicts(points);
    for (let pass = 0; count && pass < 40; pass++) {
      let best: P[] | undefined;
      let bestCount = count;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        if (!others.some(o => overlap(a, b, o.a, o.b))) continue;
        const horizontal = near(a.y, b.y), axis = horizontal ? 'y' : 'x';
        for (const distance of [8, -8, 16, -16, 24, -24, 32, -32, 48, -48, 64, -64, 96, -96]) {
          let candidate = points.map(p => ({ ...p }));
          if (i > 0 && i + 1 < points.length - 1) {
            candidate[i][axis] += distance; candidate[i + 1][axis] += distance;
          } else {
            const along = horizontal ? 'x' : 'y';
            const sign = Math.sign(b[along] - a[along]);
            const lead = Math.min(8, Math.abs(b[along] - a[along]) / 3);
            const p = { ...a, [along]: a[along] + (i === 0 ? sign * lead : 0) };
            const q = { ...b, [along]: b[along] - (i + 1 === points.length - 1 ? sign * lead : 0) };
            candidate.splice(i, 2, ...(i === 0 ? [a, p] : []),
              { ...p, [axis]: p[axis] + distance }, { ...q, [axis]: q[axis] + distance },
              ...(i + 1 === points.length - 1 ? [q, b] : []));
          }
          candidate = compact(candidate);
          const n = conflicts(candidate);
          if (n < bestCount && clear(candidate)) { best = candidate; bestCount = n; }
          if (bestCount === 0) break;
        }
        if (bestCount === 0) break;
      }
      if (!best) break;
      points = best; count = bestCount;
    }
    route.points = points;
    occupied.push(...segments(points).map(s => ({ ...s, net: signal })));
  }
  return edges;
}
