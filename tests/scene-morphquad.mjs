import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'scene-morphquad-'));
try {
  const output = path.join(directory, 'morph.cjs');
  await build({ stdin: { contents: `export * from './client/src/sim/sceneMorphQuad';export * from './client/src/sim/sceneRotors';export * from './client/src/sim/flightSceneState';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { isMorphQuad, MORPHQUAD_ARMS, MORPHQUAD_ROTOR_RADIUS, rotorCount, rotorLabel, rotorReading,
    FlightSceneFeed, decodeScenePose, demoPackets, gimbalKey } = createRequire(import.meta.url)(output);
  for (const name of ['MorphQuad', 'morphquad', 'MorphQuad_bridge', 'morphquad.xml']) {
    assert.ok(isMorphQuad(name)); assert.equal(rotorCount(name), 8);
  }
  assert.equal(isMorphQuad('quadrotor_x'), false);
  assert.deepEqual(MORPHQUAD_ARMS.map(({ x, z }) => [x, z]), [[.225, -.225], [-.225, -.225], [-.225, .225], [.225, .225]]);
  assert.equal(MORPHQUAD_ROTOR_RADIUS * 2, .1524);
  assert.equal(rotorLabel('MorphQuad', 0), 'M1 · 前右上');
  assert.equal(rotorLabel('MorphQuad', 7), 'M8 · 后右下');
  const packet = demoPackets(10)[7];
  assert.equal(packet.model, 'MorphQuad');
  const pose = decodeScenePose(packet, 1000);
  assert.equal(pose.rpm.length, 8); assert.equal(pose.gimbals.length, 4);
  for (let arm = 0; arm < 4; arm++) {
    assert.equal(pose.gimbals[arm].outer, packet.properties[gimbalKey(arm, 'outer')]);
    assert.equal(pose.gimbals[arm].inner, packet.properties[gimbalKey(arm, 'inner')]);
    assert.ok(rotorReading(pose, arm * 2, 1000).angularVelocity * rotorReading(pose, arm * 2 + 1, 1000).angularVelocity < 0);
  }
  const withoutSense = { ...pose, rpmSense: Array(8).fill(null) };
  assert.deepEqual(withoutSense.rpm.map((_, i) => Math.sign(rotorReading(withoutSense, i, 1000).angularVelocity)), [-1, 1, 1, -1, -1, 1, 1, -1]);
  assert.equal(rotorReading({ ...pose, state: 'paused' }, 7, 1000).angularVelocity, 0);
  assert.equal(rotorReading(pose, 7, 3100).angularVelocity, 0);
  const empty = { ...packet, properties: {}, scene_property_age_ms: {} };
  assert.equal(decodeScenePose(empty, 1000).gimbals[0].outer, null);
  assert.equal(rotorReading(decodeScenePose(empty, 1000), 7, 1000).source, 'none');
  const feed = new FlightSceneFeed(); feed.ingest(empty, 1000);
  const sample = (sequence, time, samples) => ({ instance_id: '08', model: 'MorphQuad', tree_generation: 'demo', timestamp: time,
    state: 'running', monitor: { version: 1, revision: 7, sequence, samples } });
  feed.ingestMonitor(sample(1, 10.1, { 'fcs/gimbal-outer-rad[0]': [Math.PI, 10.1, false],
    'fcs/gimbal-inner-rad[0]': [.4, 10.1, false], 'propulsion/engine[7]/propeller-rpm': [4300, 10.1, false] }), 1100);
  let measured = feed.aircraft.get('08').latest;
  assert.equal(measured.gimbals[0].outer, Math.PI, 'inverted gimbal angles remain signed and unclamped');
  assert.equal(measured.gimbals[0].inner, .4); assert.equal(measured.rpm[7], 4300);
  assert.equal(measured.receivedAt, 1000, 'gimbal/RPM-only samples cannot refresh aircraft pose');
  feed.ingestMonitor(sample(2, 10.2, { '/09/jsbsim/fcs[0]/gimbal-inner-rad[0]': [9, 10.2, false],
    'fcs/gimbal-outer-rad[3]': [0, 10.2, false] }), 1200);
  measured = feed.aircraft.get('08').latest;
  assert.equal(measured.gimbals[0].inner, .4, 'foreign instance cannot overwrite gimbal');
  assert.equal(measured.gimbals[3].outer, 0, 'measured zero is retained');
  feed.ingest({ ...empty, timestamp: 10.3, capture_monotonic_us: 10.3e6 }, 1300);
  assert.equal(feed.aircraft.get('08').latest.gimbals[0].outer, Math.PI, 'property slices retain monitor angles');
  const newer = { ...empty, timestamp: 10.4, capture_monotonic_us: 10.4e6,
    properties: { 'fcs/gimbal-outer-rad[0]': -.8 }, scene_property_age_ms: { 'fcs/gimbal-outer-rad[0]': 0 } };
  feed.ingest(newer, 1400);
  assert.equal(feed.aircraft.get('08').latest.gimbals[0].outer, -.8, 'older monitor cache cannot undo a newer tree sample');
  feed.ingest({ ...empty, tree_generation: 'reloaded', timestamp: 0, capture_monotonic_us: 11e6 }, 1500);
  assert.equal(feed.aircraft.get('08').latest.gimbals[0].outer, null, 'reload clears previous gimbals');
  console.log('MorphQuad: eight mapped coaxial rotors, signed/zero/independent gimbal samples, pause/expiry, source order, instance isolation and reload passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
