export interface MonitorPoint { t: number; value: number | null }
interface Summary { first: number; last: number; min: number; max: number; gap: boolean }
const CHUNK = 1024, BLOCK = 64;

/** Exact samples for one simulation run, packed into numeric chunks.
 * Summaries speed up long-range plots; zoom/cursor reads still use raw data. */
export class SignalHistory {
  private chunks: Float64Array[] = [];
  private levels: Summary[][] = [];
  private finite: number[] = [];
  length = 0;

  private time(index: number) { return this.chunks[Math.floor(index / CHUNK)][index % CHUNK * 2]; }
  private value(index: number) { return this.chunks[Math.floor(index / CHUNK)][index % CHUNK * 2 + 1]; }
  private point(index: number): MonitorPoint {
    const value = this.value(index);
    return { t: this.time(index), value: Number.isNaN(value) ? null : value };
  }
  get firstTime() { return this.length ? this.time(0) : undefined; }
  get lastTime() { return this.length ? this.time(this.length - 1) : undefined; }

  append(t: number, value: number | null) {
    if (!Number.isFinite(t) || (this.length && t < this.time(this.length - 1))) return;
    if (value !== null && !Number.isFinite(value)) value = null;
    const index = this.length++, offset = index % CHUNK * 2;
    if (index % CHUNK === 0) this.chunks.push(new Float64Array(CHUNK * 2));
    const chunk = this.chunks[Math.floor(index / CHUNK)];
    chunk[offset] = t; chunk[offset + 1] = value ?? NaN;
    if (value !== null) this.finite.push(index);
    if (this.length % BLOCK !== 0) return;
    let summary: Summary = { first: this.length - BLOCK, last: this.length - 1, min: -1, max: -1, gap: false };
    for (let i = summary.first; i <= summary.last; i++) {
      const v = this.value(i);
      if (Number.isNaN(v)) summary.gap = true;
      else {
        if (summary.min < 0 || v < this.value(summary.min)) summary.min = i;
        if (summary.max < 0 || v > this.value(summary.max)) summary.max = i;
      }
    }
    for (let level = 0; ; level++) {
      const summaries = this.levels[level] ||= [];
      summaries.push(summary);
      if (summaries.length % 2 !== 0) break;
      const a = summaries[summaries.length - 2], b = summaries[summaries.length - 1];
      const mins = [a.min, b.min].filter(i => i >= 0), maxs = [a.max, b.max].filter(i => i >= 0);
      summary = { first: a.first, last: b.last, gap: a.gap || b.gap,
        min: mins.reduce((best, i) => best < 0 || this.value(i) < this.value(best) ? i : best, -1),
        max: maxs.reduce((best, i) => best < 0 || this.value(i) > this.value(best) ? i : best, -1) };
    }
  }

  private bound(t: number, inclusive: boolean, limit: number) {
    let low = 0, high = Math.min(limit, this.length);
    while (low < high) {
      const middle = Math.floor((low + high) / 2), time = this.time(middle);
      if (time < t || (inclusive && time === t)) low = middle + 1; else high = middle;
    }
    return low;
  }

  range(start = -Infinity, end = Infinity, columns = Infinity, limit = this.length): MonitorPoint[] {
    let index = this.bound(start, false, limit);
    const stop = this.bound(end, true, limit), result: MonitorPoint[] = [];
    let level = 0;
    if (stop - index <= columns * 4) {
      for (; index < stop; index++) result.push(this.point(index));
      return result;
    }
    while (level + 1 < this.levels.length && (stop - index) / (BLOCK * 2 ** level) > columns) level++;
    while (index < stop) {
      let chosen = level;
      while (chosen >= 0 && (index % (BLOCK * 2 ** chosen) !== 0 || index + BLOCK * 2 ** chosen > stop)) chosen--;
      const size = BLOCK * 2 ** chosen, summary = chosen >= 0 ? this.levels[chosen]?.[index / size] : undefined;
      if (!summary) { result.push(this.point(index++)); continue; }
      const indices = [...new Set([summary.first, summary.min, summary.max, summary.last].filter(i => i >= 0))].sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        const point = this.point(indices[i]);
        // Coarse summaries cannot claim continuity through a missing sample.
        if (summary.gap && i && point.value !== null && result[result.length - 1]?.value !== null)
          result.push({ t: (point.t + result[result.length - 1].t) / 2, value: null });
        result.push(point);
      }
      index += size;
    }
    return result;
  }

  private finiteBound(t: number, limit: number) {
    let low = 0, high = this.finite.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), index = this.finite[middle];
      if (index < limit && this.time(index) <= t) low = middle + 1; else high = middle;
    }
    return low;
  }
  recent(count = 30, end = Infinity, limit = this.length) {
    const stop = this.finiteBound(end, limit);
    return this.finite.slice(Math.max(0, stop - count), stop).map(i => this.point(i));
  }
  nearest(t: number, end = Infinity, limit = this.length): MonitorPoint | null {
    const stop = this.finiteBound(end, limit), position = Math.min(stop, this.finiteBound(t, limit));
    const candidates = [position - 1, position].filter(i => i >= 0 && i < stop).map(i => this.point(this.finite[i]));
    return candidates.reduce<MonitorPoint | null>((best, point) => !best || Math.abs(point.t - t) < Math.abs(best.t - t) ? point : best, null);
  }
}
