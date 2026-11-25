import type { PlatformReading } from './sceneMovingPlatform';

type Measurement = { value: number; time: number; sampleAt: number; inferred?: boolean };
export type PlatformFrame = { time: number; receivedAt: number; relative: [number, number, number]; angles: [number, number, number] };
const TAU = Math.PI * 2;
const angleDelta = (a: number, b: number) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;

/** Align the six interleaved VMON channels before they share an aircraft clock.
 * Geometry/enabled samples never advance the measured motion timestamp. */
export class ScenePlatformTimeline {
  readonly samples: PlatformFrame[] = [];
  private axes: Measurement[][] = Array.from({ length: 6 }, () => []);
  private periods: number[] = [];
  private arrivedAt: number | undefined;
  sampleAt = -Infinity;
  bufferMs = 80;
  epoch = 0;

  reset() {
    this.epoch++;
    this.samples.length = 0; this.axes = Array.from({ length: 6 }, () => []);
    this.periods = []; this.arrivedAt = undefined; this.sampleAt = -Infinity; this.bufferMs = 80;
  }
  observe(reading: PlatformReading, fallbackTime: number, now: number) {
    if (reading.sampleAt - this.sampleAt >= 2000 && this.sampleAt !== -Infinity) this.reset();
    const values = [...reading.relative, ...reading.angles];
    for (let axis = 0; axis < 6; axis++) {
      const value = reading.measurements?.[axis] ?? { value: values[axis], time: fallbackTime, sampleAt: reading.sampleAt };
      if (![value.time, value.value, value.sampleAt].every(Number.isFinite)) continue;
      const history = this.axes[axis], previous = history[history.length - 1];
      if (previous && value.time <= previous.time) continue;
      // Older desktop snapshots infer times from millisecond ages. Rounding
      // can slightly move an unchanged cached sample; it is not another pose.
      if (value.inferred && previous && value.value === previous.value && value.time - previous.time < .025) continue;
      if (previous && value.sampleAt > previous.sampleAt) this.rememberPeriod(value.sampleAt - previous.sampleAt);
      history.push(value); if (history.length > 64) history.shift();
    }
    if (this.axes.some(history => !history.length)) return;
    const head = Math.min(...this.axes.map(history => history[history.length - 1].time));
    // Anchor on actual relative-position samples. Emitting again for an angle
    // fragment would create alternating short/long intervals and magnify the
    // reconstruction error when the aircraft is far away from the vessel.
    const time = [...this.axes[0]].reverse().find(sample => sample.time <= head)?.time;
    if (time === undefined) return;
    // No extrapolation: each axis must bracket the common simulation time.
    if (this.axes.some(history => history[0].time > time)) return;
    this.sampleAt = Math.min(...this.axes.map(history => history[history.length - 1].sampleAt));
    if (this.samples.length && time <= this.samples[this.samples.length - 1].time) return;
    const aligned = this.axes.map((history, axis) => {
      let a = history[0], b = history[history.length - 1];
      for (let i = 1; i < history.length; i++) if (history[i].time >= time) { a = history[i - 1]; b = history[i]; break; }
      const f = b.time > a.time ? Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))) : 0;
      return { value: a.value + (axis < 3 ? b.value - a.value : angleDelta(a.value, b.value)) * f,
        sampleAt: a.sampleAt + (b.sampleAt - a.sampleAt) * f };
    });
    const previous = this.samples[this.samples.length - 1];
    if (previous && now > (this.arrivedAt ?? now)) this.rememberPeriod(now - this.arrivedAt!);
    this.arrivedAt = now;
    this.samples.push({ time, receivedAt: Math.min(...aligned.map(v => v.sampleAt)),
      relative: aligned.slice(0, 3).map(v => v.value) as [number, number, number],
      angles: aligned.slice(3).map(v => v.value) as [number, number, number] });
    if (this.samples.length > 128) this.samples.shift();
  }
  private rememberPeriod(ms: number) {
    this.periods.push(ms); if (this.periods.length > 64) this.periods.shift();
    this.bufferMs = Math.max(80, Math.min(750, Math.max(...this.periods) * 1.5));
  }
}
