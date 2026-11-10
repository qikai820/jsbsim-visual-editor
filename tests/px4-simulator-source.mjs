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
  assert.equal(selectSimulatorPx4Source(sources, 'qgc-node').port, 14553, 'obsolete model selections cannot take over QGC port');
  assert.equal(selectSimulatorPx4Source(sources, 'removed-node').port, 14553, 'a stale selection recovers to the dedicated stream');
  const disabled = simulatorPx4Sources([node('qgc-node', 'qgc', 14550), node('toolbox-node', 'px4-toolbox', 14553, false)]);
  assert.equal(selectSimulatorPx4Source(disabled).port, 14553, 'a disabled model route cannot disable the boot service');
  assert.equal(selectSimulatorPx4Source(simulatorPx4Sources([])).port, 14553, 'the toolbox can open without any model');
  assert.equal(sources.filter(s=>s.port===14553).length,1,'a legacy model node does not duplicate the service source');
  assert.deepEqual(selectSimulatorPx4Source(sources), selectSimulatorPx4Source(simulatorPx4Sources([])), 'model unload preserves the service identity and shell session');
  const custom = {device:'/dev/ttyACM0',baud:921600,host:'192.168.3.109',toolbox_port:14554};
  assert.equal(selectSimulatorPx4Source(simulatorPx4Sources([],custom)).port,14554,'board service settings select the actual port');
  assert.equal(selectSimulatorPx4Source(simulatorPx4Sources([],custom,false)).enabled,false,'stopped service disables attachment');
  const collision = simulatorPx4AttachError(14550, 'UDP 绑定失败：Address already in use (os error 98)');
  assert.ok(collision.includes('14550') && collision.includes('不同') && collision.includes('专用'));
  assert.equal(simulatorPx4AttachError(14553, 'network unavailable'), '等待仿真机转发：network unavailable');
  console.log('PASS: independent QGC/toolbox source selection, explicit and stale selections, disabled/legacy fallback and actionable port-conflict errors.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
