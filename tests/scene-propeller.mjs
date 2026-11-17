import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = await mkdtemp(path.join(tmpdir(), 'msc-propeller-'));
try {
  const output = path.join(dir, 'prop.cjs');
  await build({ stdin: { contents: `export * from './client/src/sim/scenePropeller';export {VOLIRO_T_GEOMETRY} from './client/src/sim/sceneVoliroT';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createPropellerBlade, createPropellerHub, VOLIRO_T_GEOMETRY: g } = createRequire(import.meta.url)(output);
  assert.ok(Math.abs(g.frontPropellerRadius * 2 - 21 * .0254) < 1e-12);
  assert.ok(Math.abs(g.frontPropellerPitch - 6.3 * .0254) < 1e-12);
  assert.equal(g.frontPropellerMassKg * 4, .188);
  const a = createPropellerBlade(g.frontPropellerRadius, g.frontPropellerPitch, 1);
  const b = createPropellerBlade(g.frontPropellerRadius, g.frontPropellerPitch, -1);
  const va = a.getAttribute('position'), vb = b.getAttribute('position');
  assert.ok(Math.abs(a.boundingBox.max.x - .2667) < 1e-7);
  assert.ok(a.boundingBox.max.y - a.boundingBox.min.y > .0048, 'pitched blade has real twist beyond mounting thickness');
  for (let i = 0; i < va.count; i++) {
    const row = Math.floor(i / 3), column = i % 3, mirror = row * 3 + 2 - column;
    assert.ok(Math.abs(va.getX(i) - vb.getX(mirror)) < 1e-8);
    assert.ok(Math.abs(va.getY(i) - vb.getY(mirror)) < 1e-8);
    assert.ok(Math.abs(va.getZ(i) + vb.getZ(mirror)) < 1e-8, 'CW and CCW are mirrored geometries');
  }
  assert.ok([...a.getAttribute('normal').array].every(Number.isFinite));
  const hub = createPropellerHub(.0095, .0048, .003); hub.computeBoundingBox();
  assert.ok(Math.abs(hub.boundingBox.max.y - hub.boundingBox.min.y - .0048) < 1e-8);
  const hv = hub.getAttribute('position');
  for (let i = 0; i < hv.count; i++) assert.ok(Math.hypot(hv.getX(i), hv.getZ(i)) >= .003 - 1e-8);
  assert.equal(g.coaxialSpacing, .11); assert.equal(g.halfSpan * 2, .9);
  a.dispose(); b.dispose(); hub.dispose();
  console.log('MSC propeller: 533.4 mm diameter, 160.02 mm nominal pitch, mirrored handedness, finite normals, 4.8 mm hub, 6 mm hole and unchanged coaxial centres passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
