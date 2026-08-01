// layoutUtils.ts
// Generic layered-graph (Sugiyama-lite) helpers used to tidy module diagrams:
// order nodes within each rank by the median position of their neighbours in
// adjacent ranks, iterated up/down a few times. This dramatically reduces edge
// crossings without a full constraint solver. No imports -> safe to use from
// both signalGraph.ts and expressionConverter.ts without cycles.

export interface RankAdjacency {
  // For a node id, the ids of nodes it connects to in the previous / next rank.
  prev: Map<string, string[]>;
  next: Map<string, string[]>;
}

/**
 * Reorder each rank in-place to minimise crossings. `byRank` maps rank -> node
 * id list (already in some initial order, e.g. document order). Mutates and
 * returns the same map.
 */
export function orderRanksByBarycenter(
  byRank: Map<number, string[]>,
  adj: RankAdjacency,
  iterations = 6,
): Map<number, string[]> {
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const indexInRank = new Map<string, number>();
  for (const r of ranks) byRank.get(r)!.forEach((id, i) => indexInRank.set(id, i));

  const median = (ids: string[]): number | null => {
    const ps = ids
      .map((id) => indexInRank.get(id))
      .filter((v): v is number => v !== undefined);
    if (ps.length === 0) return null;
    ps.sort((a, b) => a - b);
    const n = ps.length;
    if (n % 2 === 1) return ps[(n - 1) / 2];
    return (ps[n / 2 - 1] + ps[n / 2]) / 2;
  };

  for (let it = 0; it < iterations; it++) {
    const downward = it % 2 === 0;
    const ordered = [...ranks];
    if (!downward) ordered.reverse();
    for (const r of ordered) {
      const ids = byRank.get(r)!;
      if (ids.length <= 1) continue;
      const withPos = ids.map((id) => {
        const m = downward
          ? median(adj.prev.get(id) || [])
          : median(adj.next.get(id) || []);
        return { id, key: m === null ? indexInRank.get(id)! : m };
      });
      withPos.sort((a, b) => a.key - b.key || a.id.localeCompare(b.id));
      withPos.forEach((w, i) => {
        byRank.get(r)![i] = w.id;
        indexInRank.set(w.id, i);
      });
    }
  }
  return byRank;
}

/**
 * Assign x by rank (column) and y by in-rank index, with even spacing.
 * `rankX(r)` gives the column x for rank r. Returns the position for each id.
 */
export function assignGridPositions(
  byRank: Map<number, string[]>,
  rankX: (r: number) => number,
  startY = 80,
  rowH = 140,
): Map<string, { x: number; y: number }> {
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const out = new Map<string, { x: number; y: number }>();
  for (const r of ranks) {
    byRank.get(r)!.forEach((id, i) => {
      out.set(id, { x: rankX(r), y: startY + i * rowH });
    });
  }
  return out;
}

export interface LaneLayoutOptions {
  startX?: number;
  startY?: number;
  // Estimated max block size (flow units) used to derive the no-overlap floor.
  blockW?: number;
  blockH?: number;
  minXGap?: number;
  minYGap?: number;
  // If both provided, the floor layout is scaled UP to fill `targetExtent`
  // (>=1x) and capped at `capExtent`; it is NEVER scaled below 1 (which would
  // break the no-overlap guarantee).
  targetExtent?: { w: number; h: number };
  capExtent?: { w: number; h: number };
}

export interface LaneLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  laneTops: Map<number, { top: number; bottom: number }>;
  orderedChannels: number[];
  scale: number;
}

/**
 * Channel-swimlane layout with a hard no-overlap guarantee and canvas fill.
 *
 *  1. Group modules by channel into horizontal lanes stacked top→bottom
 *     (classification, local clusters).
 *  2. Lay out with a FLOOR spacing (sxMin/syMin/lgMin) derived from the block
 *     size + a safety gap. This spacing GUARANTEES no two module rectangles
 *     overlap, at scale = 1, for any graph.
 *  3. If canvas sizes are known, scale the whole layout uniformly:
 *       - up to FILL the canvas (scale >= 1)  -> "尽量铺满画布"
 *       - but never below 1                    -> "绝对不能重叠"
 *       - capped at capExtent (e.g. 150%)      -> "不超过画布150%"
 *     If even the floor exceeds the cap, the floor is kept (no-overlap wins).
 *
 * Within a lane x follows the global data-flow rank (left→right) and y follows
 * the in-lane sequence, which is already barycenter-ordered (minimal crossings).
 * Lanes are ordered by earliest rank so cross-lane flow travels downward-right.
 */
export function assignChannelLanePositions(
  byRank: Map<number, string[]>,
  rankOf: Map<string, number>,
  channelOf: Map<string, number>,
  opts: LaneLayoutOptions = {},
): LaneLayoutResult {
  const startX = opts.startX ?? 80;
  const startY = opts.startY ?? 80;
  const blockW = opts.blockW ?? 190;
  const blockH = opts.blockH ?? 120;
  const minXGap = opts.minXGap ?? 44;
  const minYGap = opts.minYGap ?? 40;
  // Floor spacings that guarantee no node overlap at scale = 1.
  const sxMin = blockW + minXGap;
  const syMin = blockH + minYGap;
  const lgMin = blockH + minYGap;

  // Collect each channel's nodes following the global (rank, in-rank) order.
  // byRank is already barycenter-ordered, so this subsequence preserves the
  // crossing-minimal order inside the lane.
  const nodesByChannel = new Map<number, string[]>();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    for (const id of byRank.get(r)!) {
      const ch = channelOf.get(id) ?? 0;
      if (!nodesByChannel.has(ch)) nodesByChannel.set(ch, []);
      nodesByChannel.get(ch)!.push(id);
    }
  }

  // Order lanes by earliest rank (then channel id) to reduce cross-lane crossings.
  const channelMinRank = new Map<number, number>();
  for (const [ch, ids] of nodesByChannel) {
    let m = Infinity;
    for (const id of ids) m = Math.min(m, rankOf.get(id) ?? 0);
    channelMinRank.set(ch, m);
  }
  const orderedChannels = [...nodesByChannel.keys()].sort(
    (a, b) => (channelMinRank.get(a)! - channelMinRank.get(b)!) || a - b,
  );

  // Floor layout: within a lane, each rank forms a column and nodes in a rank
  // stack vertically. This keeps the lane roughly rectangular (fills the canvas)
  // instead of one very tall thin strip.
  const positions = new Map<string, { x: number; y: number }>();
  const laneTops = new Map<number, { top: number; bottom: number }>();
  const laneHeights: number[] = [];
  let y = startY;
  for (const ch of orderedChannels) {
    const ids = nodesByChannel.get(ch)!;
    const top = y;
    const rankRow = new Map<number, number>();
    let laneRows = 0;
    for (const id of ids) {
      const r = rankOf.get(id) ?? 0;
      const row = rankRow.get(r) ?? 0;
      rankRow.set(r, row + 1);
      if (row + 1 > laneRows) laneRows = row + 1;
      positions.set(id, { x: startX + r * sxMin, y: top + row * syMin });
    }
    laneHeights.push(laneRows);
    laneTops.set(ch, { top, bottom: top + laneRows * syMin });
    y = top + laneRows * syMin + lgMin;
  }

  // Floor extent (centre-to-centre span + one block).
  const R = (Math.max(0, ...[...byRank.keys()]) + 1) || 1;
  const numLanes = orderedChannels.length;
  const totalRows = laneHeights.reduce((a, b) => a + b, 0);
  const fw = (R - 1) * sxMin + blockW;
  const fh = (totalRows > 0 ? totalRows * syMin + (numLanes - 1) * lgMin : 0) + blockH;

  // Adaptive scale: fill the canvas (>=1) but never below 1 (no-overlap floor),
  // capped at capExtent when provided.
  let scale = 1;
  if (opts.targetExtent && opts.capExtent) {
    const capScale = Math.min(opts.capExtent.w / fw, opts.capExtent.h / fh);
    const fillScale = Math.min(opts.targetExtent.w / fw, opts.targetExtent.h / fh);
    // If even the floor exceeds the cap, keep the floor (no-overlap wins).
    scale = capScale < 1 ? 1 : Math.min(Math.max(fillScale, 1), capScale);
  }
  if (scale !== 1) {
    for (const p of positions.values()) {
      p.x = startX + (p.x - startX) * scale;
      p.y = startY + (p.y - startY) * scale;
    }
  }

  return { positions, laneTops, orderedChannels, scale };
}
