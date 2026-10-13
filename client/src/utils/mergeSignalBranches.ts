import type { Edge, Node } from '@xyflow/react';
import { signalObstacles, signalRouteIsClear, type SignalPoint as P } from './signalClearance';
import type { SignalRoute } from './signalLayout';

const eps = .05;
const near = (a: number, b: number) => Math.abs(a - b) < eps;
const same = (a: P, b: P) => near(a.x, b.x) && near(a.y, b.y);
const net = (e: Edge) => JSON.stringify([e.source, e.sourceHandle ?? '']);
const segments = (ps: P[]) => ps.slice(1).map((b, i) => ({ a: ps[i], b }));
type Segment = ReturnType<typeof segments>[number];
const length = (s: Segment) => Math.abs(s.a.x - s.b.x) + Math.abs(s.a.y - s.b.y);
function contains(p: P, s: Segment) {
  return (near(s.a.x, s.b.x) && near(p.x, s.a.x) || near(s.a.y, s.b.y) && near(p.y, s.a.y)) &&
    p.x >= Math.min(s.a.x, s.b.x) - eps && p.x <= Math.max(s.a.x, s.b.x) + eps &&
    p.y >= Math.min(s.a.y, s.b.y) - eps && p.y <= Math.max(s.a.y, s.b.y) + eps;
}
function sharedInterval(s: Segment, t: Segment): [number, number] | undefined {
  const v = near(s.a.x, s.b.x) && near(t.a.x, t.b.x) && near(s.a.x, t.a.x);
  const h = near(s.a.y, s.b.y) && near(t.a.y, t.b.y) && near(s.a.y, t.a.y);
  if (!v && !h) return;
  const axis = v ? 'y' : 'x';
  const lo = Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(t.a[axis], t.b[axis]));
  const hi = Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(t.a[axis], t.b[axis]));
  return hi - lo > eps ? [lo, hi] : undefined;
}
function addedLength(ps: P[], tree: Segment[]) {
  return segments(ps).reduce((total, s) => {
    const ranges = tree.map(t => sharedInterval(s, t)).filter((r): r is [number, number] => !!r).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = -Infinity;
    for (const [lo, hi] of ranges) { covered += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
    return total + length(s) - covered;
  }, 0);
}
function compact(ps: P[]) {
  const out: P[] = [];
  for (const p of ps) {
    if (out.length && same(out[out.length - 1], p)) continue;
    const a = out[out.length - 2], b = out[out.length - 1];
    // Remove only forward collinear bends; never hide a reversal.
    if (a && b && contains(b, { a, b: p })) out.pop();
    out.push(p);
  }
  return out;
}

function bridges(s: Segment, t: Segment): [P, P][] {
  const sv = near(s.a.x, s.b.x), tv = near(t.a.x, t.b.x);
  if (sv !== tv) {
    const p = { x: sv ? s.a.x : t.a.x, y: sv ? t.a.y : s.a.y };
    return contains(p, s) && contains(p, t) ? [[p, p]] : [];
  }
  const axis = sv ? 'y' : 'x', fixed = sv ? 'x' : 'y';
  const lo = Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(t.a[axis], t.b[axis]));
  const hi = Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(t.a[axis], t.b[axis]));
  if (lo > hi + eps) return [];
  return [lo, hi].map(along => [{ ...s.a, [axis]: along }, { ...s.a, [axis]: along, [fixed]: t.a[fixed] }]);
}

/** Attach each destination to the existing net, reusing its rooted path.
 * A parallel corridor is joined at its far end instead of drawing another
 * full-length wire. Every candidate retains real port endpoints, keepouts,
 * manual checkpoints and separation from other output signals. */
export function mergeSignalBranches(edges: Edge[], nodes: Node[]) {
  const obstacles = signalObstacles(nodes);
  const groups = new Map<string, Edge[]>();
  for (const e of edges) if (!e.hidden && e.data?.elkRoute) {
    const key = net(e);
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const route = (e: Edge) => (e.data!.elkRoute as SignalRoute).points;
    // Start with the longest destination path as the trunk. Stable tie order
    // keeps restored layouts deterministic.
    const ordered = [...group].sort((a, b) => addedLength(route(b), []) - addedLength(route(a), []) || a.id.localeCompare(b.id));
    const foreign = edges.filter(e => !e.hidden && net(e) !== key && e.data?.elkRoute).flatMap(e => segments(route(e)));
    const tree: P[][] = [];
    for (const edge of ordered) {
      const original = compact(route(edge));
      if (!tree.length) { tree.push(original); continue; }
      const occupied = tree.flatMap(segments);
      let best = original;
      const score = (ps: P[]) => addedLength(ps, occupied) + segments(ps).reduce((n, s) => n + length(s), 0) * .0001;
      let bestScore = score(best);
      const tryPath = (ps: P[]) => {
        const candidate = compact(ps), cost = score(candidate);
        if (cost >= bestScore - eps || !signalRouteIsClear(candidate, edge, obstacles)) return;
        const segs = segments(candidate);
        if (segs.some(s => foreign.some(t => sharedInterval(s, t)))) return;
        const checkpoints = edge.data?.bendpoints as P[] | undefined;
        if (checkpoints?.some(p => !segs.some(s => contains(p, s)))) return;
        // A branch must not split and then rejoin an existing trunk. That
        // would create a loop and recreate the parallel-wire ambiguity.
        let leftTree = false;
        for (const s of segs) {
          const covered = addedLength([s.a, s.b], occupied) < eps;
          if (covered && leftTree) return;
          if (!covered) leftTree = true;
        }
        best = candidate; bestScore = cost;
      };
      for (const trunk of tree) for (let i = 1; i < trunk.length; i++) {
        const s = { a: trunk[i - 1], b: trunk[i] };
        for (let j = 1; j < original.length; j++) {
          const t = { a: original[j - 1], b: original[j] };
          const sv = near(s.a.x, s.b.x), tv = near(t.a.x, t.b.x);
          if (sv !== tv) {
            const p = { x: sv ? s.a.x : t.a.x, y: sv ? t.a.y : s.a.y };
            if (contains(p, s) && contains(p, t)) tryPath([...trunk.slice(0, i), p, ...original.slice(j)]);
          } else {
            const axis = sv ? 'y' : 'x', fixed = sv ? 'x' : 'y';
            const lo = Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(t.a[axis], t.b[axis]));
            const hi = Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(t.a[axis], t.b[axis]));
            if (lo > hi + eps) continue;
            for (const along of [lo, hi]) {
              const p = { ...s.a, [axis]: along }, q = { ...p, [fixed]: t.a[fixed] };
              tryPath([...trunk.slice(0, i), p, q, ...original.slice(j)]);
            }
          }
        }
      }
      (edge.data!.elkRoute as SignalRoute).points = best;
      tree.push(best);
    }
    // Sharing a far-away trunk must not send a nearby destination past its
    // branch and then back along a parallel return wire. Remove such hairpins
    // only when the direct orthogonal shortcut is clear and keeps checkpoints.
    for (const edge of group) {
      let points = route(edge);
      for (;;) {
        let best = points, bestLength = addedLength(points, []);
        for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
          for (const [p, q] of bridges({ a: points[i - 1], b: points[i] }, { a: points[j - 1], b: points[j] })) {
            const candidate = compact([...points.slice(0, i), p, q, ...points.slice(j)]);
            const distance = addedLength(candidate, []);
            if (distance >= bestLength - eps || !signalRouteIsClear(candidate, edge, obstacles)) continue;
            const segs = segments(candidate);
            if (segs.some(s => foreign.some(t => sharedInterval(s, t)))) continue;
            const checkpoints = edge.data?.bendpoints as P[] | undefined;
            if (checkpoints?.some(point => !segs.some(s => contains(point, s)))) continue;
            best = candidate; bestLength = distance;
          }
        }
        if (best === points) break;
        points = best;
      }
      (edge.data!.elkRoute as SignalRoute).points = points;
    }
  }
}
