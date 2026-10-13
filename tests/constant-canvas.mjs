// A new source block can precede the existing H7 channel blocks on canvas.
// The original channel identity and the new constant must both survive the
// graph-to-XML handoff.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'jsbsim-constant-canvas-'));
try {
  const output = path.join(directory, 'signalGraph.cjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../client/src/utils/signalGraph.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const { graphToChannels } = createRequire(import.meta.url)(output);
  const nodes = [
    { id: 'new', position: { x: 0, y: 0 }, data: {
      kind: 'component', itemType: 'constant', ch: 0, chName: '',
      name: 'fcs/constant-1', inputs: [], compProps: { constant: { value: '0', attrs: {} } },
    } },
    { id: 'existing', position: { x: 200, y: 0 }, data: {
      kind: 'component', itemType: 'integrator', ch: 0, chName: 'H7 Viztra',
      name: 'fcs/existing', inputs: ['fcs/input'], compProps: { c1: { value: '1', attrs: {} } },
    } },
  ];
  const channels = graphToChannels(nodes, []);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, 'H7 Viztra');
  assert.equal(channels[0].items.length, 2);
  assert.deepEqual(channels[0].items[0], {
    type: 'constant', name: 'fcs/constant-1', componentProps: { constant: { value: '0', attrs: {} } },
  });
  console.log('PASS: new constant and original channel both reach XML generation');
} finally {
  await rm(directory, { recursive: true, force: true });
}
