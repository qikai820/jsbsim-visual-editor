// Pure geometry helpers for draggable bendpoint (waypoint) edges.
// Shared by the main canvas (BendableEdge) and the signal-flow canvas (SignalEdge).

export interface Bendpoint { x: number; y: number }
type Pt = { x: number; y: number };

function dist(a: Pt, b: Pt): number { return Math.hypot(b.x - a.x, b.y - a.y); }
function round2(n: number): number { return Math.round(n * 100) / 100; }

// Full polyline: source anchor + bendpoints + target anchor.
export function edgePoints(src: Pt, tgt: Pt, bps: Bendpoint[] = []): Pt[] {
  return [src, ...bps.map(b => ({ x: b.x, y: b.y })), tgt];
}

// Rounded polyline path through all points. radius=0 → sharp corners.
export function polylinePath(points: Pt[], radius = 10): string {
  if (points.length < 2) return '';
  const pt = (p: Pt) => `${round2(p.x)} ${round2(p.y)}`;
  if (points.length === 2 || radius <= 0) {
    return `M ${pt(points[0])} ` + points.slice(1).map(p => `L ${pt(p)}`).join(' ');
  }
  let d = `M ${pt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], curr = points[i], next = points[i + 1];
    const l1 = dist(prev, curr), l2 = dist(curr, next);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r <= 0.01 || l1 === 0 || l2 === 0) { d += ` L ${pt(curr)}`; continue; }
    const u1 = { x: (curr.x - prev.x) / l1, y: (curr.y - prev.y) / l1 };
    const u2 = { x: (next.x - curr.x) / l2, y: (next.y - curr.y) / l2 };
    const p1 = { x: curr.x - u1.x * r, y: curr.y - u1.y * r };
    const p2 = { x: curr.x + u2.x * r, y: curr.y + u2.y * r };
    d += ` L ${pt(p1)} Q ${pt(curr)} ${pt(p2)}`;
  }
  d += ` L ${pt(points[points.length - 1])}`;
  return d;
}

// Point at fraction t (by arc length) along the polyline — used to place the label.
export function polylinePointAt(points: Pt[], t = 0.5): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const l = dist(points[i], points[i + 1]);
    segs.push(l); total += l;
  }
  let target = total * t;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const a = points[i], b = points[i + 1];
      const f = segs[i] === 0 ? 0 : target / segs[i];
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    target -= segs[i];
  }
  return points[points.length - 1];
}

// Index of the polyline segment nearest to point p (for double-click waypoint insert).
// Insert the new bendpoint at position segIndex in the bendpoints array.
export function nearestSegment(points: Pt[], p: Pt): { segIndex: number; point: Pt } {
  let best = { segIndex: 0, point: points[0] || { x: 0, y: 0 } };
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const proj = projectOnSegment(points[i], points[i + 1], p);
    const d = dist(proj, p);
    if (d < bestD) { bestD = d; best = { segIndex: i, point: proj }; }
  }
  return best;
}

function projectOnSegment(a: Pt, b: Pt, p: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return a;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}
