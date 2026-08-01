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
  rankX: (r: number) => number;
  startY?: number;
  rowH?: number;
  laneGap?: number;
}

export interface LaneLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  laneTops: Map<number, { top: number; bottom: number }>;
  orderedChannels: number[];
}

/**
 * Channel-swimlane layout.
 *  - Nodes are grouped by channel into horizontal "lanes" stacked top→bottom,
 *    so modules are classified by channel (local clusters that never overlap).
 *  - Within a lane, x follows the global data-flow rank (left→right) and y
 *    follows the in-lane sequence, which is already barycenter-ordered; this
 *    keeps wires inside a lane tidy and crossings minimal.
 *  - Lanes are ordered by the minimum rank of their nodes (source-ish channels
 *    on top) so cross-lane data flow generally travels downward-right.
 *
 * `byRank` must already be crossing-ordered (e.g. via orderRanksByBarycenter);
 * `rankOf` maps node id -> its global rank; `channelOf` maps node id -> channel
 * index. Returns a position per id plus per-channel lane extents.
 */
export function assignChannelLanePositions(
  byRank: Map<number, string[]>,
  rankOf: Map<string, number>,
  channelOf: Map<string, number>,
  opts: LaneLayoutOptions,
): LaneLayoutResult {
  const startY = opts.startY ?? 80;
  const rowH = opts.rowH ?? 120;
  const laneGap = opts.laneGap ?? 70;

  // Collect each channel's nodes following the global (rank, in-rank) order.
  // Because byRank is already barycenter-ordered, this subsequence preserves
  // the crossing-minimal order inside the lane.
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

  const positions = new Map<string, { x: number; y: number }>();
  const laneTops = new Map<number, { top: number; bottom: number }>();
  let y = startY;
  for (const ch of orderedChannels) {
    const ids = nodesByChannel.get(ch)!;
    const top = y;
    ids.forEach((id, i) => {
      const r = rankOf.get(id) ?? 0;
      positions.set(id, { x: opts.rankX(r), y: top + i * rowH });
    });
    const height = Math.max(1, ids.length) * rowH;
    laneTops.set(ch, { top, bottom: top + height });
    y = top + height + laneGap;
  }

  return { positions, laneTops, orderedChannels };
}
