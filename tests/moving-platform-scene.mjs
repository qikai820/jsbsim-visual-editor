import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
const work = await mkdtemp(path.join(tmpdir(), 'moving-platform-scene-'));
try {
  const output = path.join(work, 'test.cjs');
  await build({ stdin: { contents: `export * from './client/src/sim/sceneMovingPlatform';export * from './client/src/sim/sceneMovingPlatformVisual';export * from './client/src/sim/flightSceneState';export * from './client/src/sim/sceneSignals';export * from './client/src/sim/sceneRotors';export * from './client/src/flight-test/xcd20Monitor';export{Group,Mesh,BoxGeometry,MeshBasicMaterial,Box3,Vector3}from'three';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(output);
  const { PLATFORM_SIGNAL_KEYS: keys, platformGeometry, readMovingPlatform, FlightSceneFeed, decodeScenePose, demoPackets, createMovingPlatformModel, Group, Mesh, BoxGeometry, MeshBasicMaterial, Box3, Vector3, sceneMonitorKeys, sceneMonitorPlan, mergeSceneMonitorKeys, rotorReading, rotorRpmKey, xcd20ObservationKeys } = api;
  const geometry = platformGeometry({});
  const values = [1, 1, 2, 3, .1, .2, .3, 2, 4, 3, .25, 1.5, .36, 0, .1];
  const properties = Object.fromEntries(keys.map((key, i) => ['/' + key, values[i]]));
  const packet = { ...demoPackets(1)[0], properties, scene_property_age_ms: Object.fromEntries(keys.map(key => ['/' + key, 0])) };
  const p = decodeScenePose(packet, 1000);
  assert.equal(p.platformEnabled, true); assert.deepEqual(p.platform.relative, [1, 2, 3]); assert.equal(p.platform.geometry.length, 4);
  const reader = key => ({ value: properties['/' + key], age: 0 });
  assert(readMovingPlatform(reader, 1000));
  assert.equal(readMovingPlatform(key => key.endsWith('relative-position-m[1]') ? undefined : reader(key), 1000), null);
  assert.equal(readMovingPlatform(key => ({ ...reader(key), age: key.endsWith('angles-rad[2]') ? 300 : 0 }), 1000), null);
  assert.equal(readMovingPlatform(key => ({ ...reader(key), age: 2500 }), 1000), null);
  for (const model of ['F450', 'MorphQuad', 'XCD20', 'voliro_t']) {
    const subscription = mergeSceneMonitorKeys([], sceneMonitorKeys(model, keys));
    assert(subscription.length <= 32); for (const key of keys) assert(subscription.includes(key), model + ' ' + key);
    const full = Array.from({ length: 32 }, (_, i) => 'user/' + i);
    assert.deepEqual(new Set(mergeSceneMonitorKeys(full, sceneMonitorKeys(model, keys))), new Set(full));
  }
  const model = 'XCD20_FlightIdentified';
  const rpmKeys = Array.from({ length: 8 }, (_, i) => rotorRpmKey(model, i));
  const defaultPlan = sceneMonitorPlan({ instance: '01', model, platformEnabled: true, extraKeys: keys });
  const defaultSubscription = mergeSceneMonitorKeys([], defaultPlan.keys, defaultPlan.reserved);
  for (const key of [...keys, ...rpmKeys, 'position/terrain-elevation-asl-ft', 'scene/loaded',
    'atmosphere/total-wind-north-fps', 'atmosphere/total-wind-east-fps', 'atmosphere/total-wind-down-fps']) {
    assert(defaultSubscription.includes(key), key);
  }

  const userKeys = ['propulsion/engine/propeller-rpm', ...Array.from({ length: 31 }, (_, i) => `user/${i}`)];
  const testKeys = xcd20ObservationKeys({ aircraft: model, requirements: { 'xcd20-takeoff': 1 } });
  // A custom value may already use the unindexed alias for a platform signal.
  const plan = sceneMonitorPlan({ instance: '01', model, platformEnabled: true, extraKeys: ['moving-platform/relative-position-m', ...keys] }, testKeys);
  const selected = mergeSceneMonitorKeys(userKeys, plan.keys, plan.reserved);
  assert.equal(selected.length, 32);
  for (const key of [...keys, ...rpmKeys.slice(1), ...testKeys, userKeys[0]]) assert(selected.includes(key), key);
  assert(!selected.includes(rpmKeys[0]), 'subscribed RPM alias occupies one slot');
  const disabled = sceneMonitorPlan({ instance: '01', model, platformEnabled: false, extraKeys: keys });
  assert.deepEqual(new Set(mergeSceneMonitorKeys(userKeys, disabled.keys, disabled.reserved)), new Set(userKeys));

  // Feed the scene only core telemetry and the simulator's rotating VMON batches.
  const live = new FlightSceneFeed();
  const samples = new Map(keys.map((key, i) => [key, values[i]]));
  rpmKeys.forEach((key, i) => samples.set(i === 0 ? userKeys[0] : key, 5000 + i));
  for (let i = 0; i < 90; i++) {
    const now = 1000 + i * 40, timestamp = 1 + i * .04;
    const core = { ...packet, model, timestamp, capture_monotonic_us: now * 1000, properties: {}, scene_property_age_ms: {} };
    live.ingest(core, now);
    const batch = selected.slice(i % 8 * 4, (i % 8 + 1) * 4);
    live.ingestMonitor({ ...core, monitor: { version: 1, revision: 1, sequence: i + 1,
      samples: Object.fromEntries(batch.map(key => [key, [samples.get(key) ?? null, samples.has(key) ? timestamp : null, false]])) } }, now);
  }
  const livePose = live.aircraft.get('01').latest;
  const now = 1000 + 89 * 40;
  assert.deepEqual(livePose.platform.relative, [1, 2, 3]);
  for (let i = 0; i < 8; i++) {
    const reading = rotorReading(livePose, i, now);
    assert.equal(reading.rpm, 5000 + i);
    assert(now - reading.sampleAt < 320);
    assert.notEqual(reading.visualAngularVelocity, 0);
    assert.equal(rotorReading(livePose, i, now + 2000).visualAngularVelocity, 0);
  }

  const feed = new FlightSceneFeed(); feed.ingest(packet, 1000);
  feed.ingest({ ...packet, timestamp: 2, properties: {}, scene_property_age_ms: {} }, 2000);
  assert.equal(feed.aircraft.get('01').latest.platform.sampleAt, 1000, 'missing slices preserve age');
  feed.ingest({ ...packet, timestamp: 3, tree_generation: 'new', properties: {}, scene_property_age_ms: {} }, 3000);
  assert.equal(feed.aircraft.get('01').latest.platform, null, 'model generation clears the platform');
  feed.ingest({ ...packet, timestamp: 4, tree_generation: 'new', properties: { '/moving-platform/enabled': 0 }, scene_property_age_ms: { '/moving-platform/enabled': 0 } }, 4000);
  assert.equal(feed.aircraft.get('01').latest.platformEnabled, false);
  const monitor = new FlightSceneFeed(); monitor.ingest({ ...packet, properties: {}, scene_property_age_ms: {} }, 1000);
  monitor.ingestMonitor({ instance_id: '01', model: packet.model, tree_generation: packet.tree_generation, timestamp: 1, state: 'running', monitor: { version: 1, revision: 1, sequence: 1, samples: Object.fromEntries(keys.map((key, i) => [key, [values[i], 1, false]])) } }, 1010);
  assert.deepEqual(monitor.aircraft.get('01').latest.platform.relative, [1, 2, 3], 'VMON measured vectors reach the scene');
  monitor.ingest({ ...packet, timestamp: 2, properties: { '/moving-platform/enabled': 0 }, scene_property_age_ms: { '/moving-platform/enabled': 0 } }, 1020);
  assert.equal(monitor.aircraft.get('01').latest.platformEnabled, false, 'older monitor enable cannot override a newer disable');
  const discovery = new FlightSceneFeed();
  discovery.ingest({ ...packet, properties: {}, scene_property_age_ms: {} }, 1000);
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, undefined);
  const probe = (sequence, value, time = 1, other = {}) => ({ instance_id: '01', model: packet.model, tree_generation: packet.tree_generation,
    timestamp: 1, monitor: { version: 1, revision: 1, sequence, samples: { 'moving-platform/enabled': [value, time, false] } }, ...other });
  discovery.ingestMonitor(probe(1, null, null, { instance_id: '02' }), 1010);
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, undefined, 'other instance cannot complete discovery');
  discovery.ingestMonitor(probe(1, null, null, { age_ms: 2500 }), 1010);
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, undefined, 'stale missing reply cannot complete discovery');
  discovery.ingestMonitor(probe(2, null, null), 1020);
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, false, 'missing-property reply completes discovery without making up an enabled value');
  assert.equal(discovery.aircraft.get('01').latest.platformEnabled, undefined);
  discovery.ingestMonitor(probe(3, 1), 1030);
  assert.equal(discovery.aircraft.get('01').latest.platformEnabled, true, 'fast probe discovers the module without a property-tree slice');
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, true);
  discovery.ingest({ ...packet, timestamp: 2, tree_generation: 'another', properties: {}, scene_property_age_ms: {} }, 2000);
  assert.equal(discovery.aircraft.get('01').latest.platformAvailable, undefined, 'a new model generation probes afresh');
  const vessel = new Group(); vessel.add(new Mesh(new BoxGeometry(4, 3, 10), new MeshBasicMaterial()));
  const visual = createMovingPlatformModel(vessel, geometry);
  visual.root.updateWorldMatrix(true, true);
  const deck = new Box3().setFromObject(visual.root.getObjectByName('landing-deck'));
  assert(Math.abs(deck.max.y + geometry.deckZ) < 1e-7, 'visual deck matches native positive-down height');
  const rods = ['guide-rod-left', 'guide-rod-right'].map(name => new Box3().setFromObject(visual.root.getObjectByName(name)));
  assert(Math.abs(rods[0].min.y - (geometry.cgZ - geometry.sleeve / 2)) < 1e-6);
  assert(Math.abs(rods[1].getCenter(new Vector3()).x - rods[0].getCenter(new Vector3()).x - geometry.spacing) < 1e-6);
  const deckOnly = createMovingPlatformModel(vessel, { ...geometry, mode: 0 }); assert.equal(deckOnly.root.getObjectByName('guide-rod-left'), undefined);
  visual.dispose(); deckOnly.dispose();
  const glb = await readFile(new URL('../client/public/scenery/moving-platform/vessel.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)));
  assert(json.images.every(image => image.bufferView !== undefined && !image.uri));
  assert(json.buffers.every(buffer => !buffer.uri));
  const provenance=JSON.parse(await readFile(new URL('../client/public/scenery/moving-platform/visual-model.json',import.meta.url),'utf8'));
  assert.equal(provenance.collision.sourceSha256,createHash('sha256').update(glb).digest('hex'),'native collision geometry must refer to the exact bundled visual GLB');
  assert.equal(provenance.collision.triangles,367);
  assert.equal(provenance.collision.removedDegenerateTriangles,7);
  console.log('PASS moving platform: native geometry alignment, coherent measured pose, lifecycle, VMON budgets, offline GLB');
} finally { await rm(work, { recursive: true, force: true }); }
