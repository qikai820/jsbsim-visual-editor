import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp('/tmp/px4-simulator-source-');
try {
  await build({ entryPoints: ['client/src/px4/simulatorSource.ts'], outfile: directory + '/source.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { simulatorPx4Sources, selectSimulatorPx4Source, simulatorPx4AttachError } = createRequire(import.meta.url)(directory + '/source.cjs');
  const node = (key, id, port, enabled = true) => ({ id: key, data: { componentType: 'mavlink_forwarder', params: { id, name: id, qgc_port: port, enabled, bidirectional: true } } });
  const sources = simulatorPx4Sources([node('qgc-node', 'qgc', 14550), node('toolbox-node', 'px4-toolbox', 14553)]);
  assert.equal(selectSimulatorPx4Source(sources).port, 14553, 'a dedicated stream wins even when QGC is the first node');
  assert.equal(selectSimulatorPx4Source(sources, 'qgc-node').port, 14550, 'explicit user selection remains authoritative');
  assert.equal(selectSimulatorPx4Source(sources, 'removed-node').port, 14553, 'a stale selection recovers to the dedicated stream');
  const disabled = simulatorPx4Sources([node('qgc-node', 'qgc', 14550), node('toolbox-node', 'px4-toolbox', 14553, false)]);
  assert.equal(selectSimulatorPx4Source(disabled).port, 14550, 'disabled dedicated streams do not hide a working legacy stream');
  assert.equal(selectSimulatorPx4Source(simulatorPx4Sources([])).port, 14550, 'old models retain their default stream');
  const collision = simulatorPx4AttachError(14550, 'UDP 绑定失败：Address already in use (os error 98)');
  assert.ok(collision.includes('14550') && collision.includes('不同') && collision.includes('专用'));
  assert.equal(simulatorPx4AttachError(14553, 'network unavailable'), '等待仿真机转发：network unavailable');
  console.log('PASS: independent QGC/toolbox source selection, explicit and stale selections, disabled/legacy fallback and actionable port-conflict errors.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
