// Deterministic render frames and delivery schedules; no simulator or GPU needed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'flight-scene-playback-'));
try {
  const output = path.join(directory, 'scene.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../client/src/sim/flightSceneState.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { FlightSceneFeed } = createRequire(import.meta.url)(output);
  const packet = (ms, extra = {}) => ({ instance_id: '01', model: 'F450', tree_generation: 1,
    timestamp: ms / 1000, capture_monotonic_us: ms * 1000, state: 'running',
    latitude_deg: 34, longitude_deg: 109 + ms / 1e7, altitude_m: 500,
    roll_deg: 0, pitch_deg: 0, yaw_deg: ms * .03, ...extra });

  const startup = new FlightSceneFeed();
  startup.ingest(packet(0), 1000);
  startup.ingest(packet(40), 1040);
  const beforeBuffer = startup.sample('01', 1040);
  assert.ok(beforeBuffer.position.length() < 1e-9,
    'a render time before the buffer starts must hold its oldest pose, never jump to the newest');

  const replay = (name, cadence, deliverAt, aged = false) => {
    const feed = new FlightSceneFeed();
    const deliveries = Array.from({ length: Math.floor(8000 / cadence) + 1 }, (_, i) => {
      const captured = i * cadence;
      return { captured, arrived: deliverAt(captured, i) };
    }).sort((a, b) => a.arrived - b.arrived || a.captured - b.captured);
    let next = 0, previous, frozen = 0, backwards = 0, largest = 0, maxLag = 0;
    for (let now = 0; now <= 8000; now += 1000 / 60) {
      while (next < deliveries.length && deliveries[next].arrived <= now) {
        const { captured, arrived } = deliveries[next++];
        // Some IPC batches have no sub-frame age; source timestamps still advance.
        feed.ingest(packet(captured, { age_ms: aged ? arrived - captured : 0 }), 1000 + arrived);
      }
      const sample = feed.sample('01', 1000 + now);
      if (!sample) continue;
      if (previous && now > 2000) {
        const step = sample.position.x - previous.position.x;
        if (Math.abs(step) < 1e-8) frozen++;
        if (step < -1e-8) backwards++;
        largest = Math.max(largest, step);
        const angle = previous.quaternion.angleTo(sample.quaternion);
        assert.ok(angle < .015, `${name}: attitude must not jump between deliveries (${angle} rad)`);
        maxLag = Math.max(maxLag, now - sample.time * 1000);
      }
      previous = sample;
    }
    assert.equal(backwards, 0, `${name}: buffer adjustment must never rewind motion`);
    assert.equal(frozen, 0, `${name}: normal delivery cadence must not cause held render frames`);
    assert.ok(largest < .25, `${name}: rendered position steps stay bounded (${largest} m)`);
    assert.ok(maxLag < 450, `${name}: playback must not accumulate unbounded delay (${maxLag} ms)`);
    return { name, frozen, backwards, largestStepM: Number(largest.toFixed(4)), maxLagMs: Math.round(maxLag) };
  };
  const results = [
    replay('10 Hz telemetry', 100, ms => ms),
    replay('40 ms poses in 120 ms IPC batches', 40, ms => Math.ceil(ms / 120) * 120),
    replay('100 Hz poses in 160 ms IPC batches', 10, ms => Math.ceil(ms / 160) * 160),
    replay('aged 40 ms poses in 120 ms IPC batches', 40, ms => Math.ceil(ms / 120) * 120, true),
    replay('aged 100 Hz poses in 160 ms IPC batches', 10, ms => Math.ceil(ms / 160) * 160, true),
    replay('variable packet delay', 40, (ms, i) => ms + [0, 10, 65, 25, 100, 0, 20, 40][i % 8]),
  ];

  const lifecycle = new FlightSceneFeed();
  for (let ms = 0; ms <= 400; ms += 40) lifecycle.ingest(packet(ms), 1000 + ms);
  lifecycle.sample('01', 1400);
  lifecycle.ingest(packet(400, { state: 'paused', capture_monotonic_us: 401000 }), 1440);
  const paused = lifecycle.sample('01', 1440);
  assert.deepEqual(lifecycle.sample('01', 1800).position.toArray(), paused.position.toArray());
  assert.equal(lifecycle.sample('01', 4000).stale, true);
  lifecycle.ingest(packet(440), 4040);
  assert.equal(lifecycle.sample('01', 4040).stale, false);
  const resumed = lifecycle.sample('01', 4040);
  assert.deepEqual(lifecycle.sample('01', 4100).position.toArray(), resumed.position.toArray(),
    'a single recovered pose is held without predicting further motion');
  lifecycle.ingest(packet(0, { tree_generation: 2 }), 4200);
  assert.equal(lifecycle.aircraft.get('01').samples.length, 1);
  console.log('Flight scene playback:', results, 'startup, pause, stale recovery and reload passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
