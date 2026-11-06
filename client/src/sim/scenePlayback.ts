type TimedPose = { time: number; receivedAt: number };
const MIN_BUFFER_MS = 80;
const MAX_BUFFER_MS = 250;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A monotonic playout clock. Packet delivery time controls buffering, not motion. */
export class ScenePlaybackClock {
  private gaps: number[] = [];
  private delayMs = MIN_BUFFER_MS;
  private rate = 1;
  private time: number | null = null;
  private updatedAt: number | null = null;
  private arrivedAt: number | null = null;

  observe(samples: readonly TimedPose[], now: number) {
    const latest = samples[samples.length - 1], previous = samples[samples.length - 2];
    // receivedAt subtracts the native queue age. Use actual delivery time for
    // jitter: age-corrected sample spacing would hide IPC batching entirely.
    const gap = this.arrivedAt === null ? 0 : now - this.arrivedAt;
    this.arrivedAt = now;
    if (gap > 0) {
      this.gaps.push(gap);
      if (this.gaps.length > 32) this.gaps.shift();
      this.delayMs = clamp(Math.max(...this.gaps) * 1.5, MIN_BUFFER_MS, MAX_BUFFER_MS);
    }
    if (!previous || latest.time <= previous.time) return;
    // Estimate simulation speed over a window, so a burst's near-zero receive
    // spacing cannot turn into an enormous angular or positional velocity.
    const first = samples[0], elapsed = latest.receivedAt - first.receivedAt;
    if (elapsed >= 500) {
      const measured = (latest.time - first.time) * 1000 / elapsed;
      this.rate += (clamp(measured, .05, 20) - this.rate) * .05;
    }
  }

  sample(samples: readonly TimedPose[], now: number, frozen: boolean): number {
    const oldest = samples[0], latest = samples[samples.length - 1];
    const desired = latest.time + (now - latest.receivedAt - this.delayMs) * this.rate / 1000;
    if (frozen) this.time = latest.time;
    else if (this.time === null || this.updatedAt === null || now - this.updatedAt > 2000) {
      this.time = clamp(desired, oldest.time, latest.time);
    } else {
      const elapsed = Math.max(0, now - this.updatedAt) / 1000;
      // Absorb buffer changes by a small speed adjustment. Changing the delay
      // directly would rewind the airframe whenever the next packet was late.
      const correction = clamp(1 + (desired - this.time) / (.5 * this.rate), .85, 1.15);
      this.time = clamp(this.time + elapsed * this.rate * correction, oldest.time, latest.time);
    }
    this.updatedAt = now;
    return this.time;
  }
}
