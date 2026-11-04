type Point = { x: number; y: number };

/** Find the nearest point in the path's flow coordinates. */
export function closestWirePoint(path: SVGPathElement, target: Point): Point | undefined {
  // Signal diagrams mostly use straight M/L segments. Projecting onto each
  // segment is exact and avoids sampling long wires during node dragging.
  const data = path.getAttribute('d') || '';
  if (/^[\d\s.,+\-eEML]+$/.test(data)) {
    const tokens = data.match(/[ML]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    if (tokens.length >= 6 && tokens.length % 3 === 0 && tokens.every((token, index) => index % 3 === 0 ? token === (index ? 'L' : 'M') : Number.isFinite(Number(token)))) {
      const points: Point[] = [];
      for (let index = 0; index < tokens.length; index += 3) {
        const x = Number(tokens[index + 1]), y = Number(tokens[index + 2]);
        points.push({ x, y });
      }
      let best: Point | undefined, distance = Infinity;
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1], b = points[index], dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
        const t = square ? Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / square)) : 0;
        const candidate = { x: a.x + t * dx, y: a.y + t * dy };
        const next = (candidate.x - target.x) ** 2 + (candidate.y - target.y) ** 2;
        if (next < distance) { best = candidate; distance = next; }
      }
      return best;
    }
  }
  let length: number;
  try { length = path.getTotalLength(); } catch { return undefined; }
  if (!Number.isFinite(length) || length < 0) return undefined;
  const pointAt = (distance: number) => {
    const point = path.getPointAtLength(distance);
    const { x, y } = point;
    return { x, y, distance: (x - target.x) ** 2 + (y - target.y) ** 2 };
  };
  if (length === 0) return pointAt(0);
  const steps = Math.max(1, Math.min(8192, Math.ceil(length / 3)));
  const step = length / steps;
  let bestIndex = 0, best = pointAt(0);
  for (let index = 1; index <= steps; index++) {
    const candidate = pointAt(index * step);
    if (candidate.distance < best.distance) { best = candidate; bestIndex = index; }
  }
  // Refine around the nearest sample rather than leaving a visible 1–3 px offset.
  let left = Math.max(0, (bestIndex - 1) * step), right = Math.min(length, (bestIndex + 1) * step);
  for (let iteration = 0; iteration < 18; iteration++) {
    const first = left + (right - left) / 3, second = right - (right - left) / 3;
    if (pointAt(first).distance <= pointAt(second).distance) right = second; else left = first;
  }
  const refined = pointAt((left + right) / 2);
  return refined.distance < best.distance ? refined : best;
}

export function wirePath(group: SVGGElement | null): SVGPathElement | null {
  return group?.querySelector<SVGPathElement>('path.react-flow__edge-path, path.bp-add-hit, path.react-flow__edge-interaction') || null;
}
