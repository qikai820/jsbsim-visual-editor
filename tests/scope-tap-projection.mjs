import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'scope-tap-'));
try {
  const output = path.join(directory, 'projection.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../client/src/components/monitor/tapProjection.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {closestWirePoint} = createRequire(import.meta.url)(output);
  const line={getScreenCTM:()=>{throw new Error('projection must not use viewport transforms')},getAttribute:()=> 'M 0,0 L 1e2 0 L 100 80',getTotalLength:()=>{throw new Error('straight path should not be sampled')}};
  assert.deepEqual(closestWirePoint(line,{x:50,y:4}),{x:50,y:0},'horizontal centerline');
  assert.deepEqual(closestWirePoint(line,{x:97,y:25}),{x:100,y:25},'vertical centerline');
  assert.deepEqual(closestWirePoint(line,{x:105,y:100}),{x:100,y:80},'endpoint clamp');
  const length=Math.PI*5, angle=Math.PI/4;
  const curve={getScreenCTM:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),getAttribute:()=> 'M 10 0 A 10 10 0 0 1 0 10',getTotalLength:()=>length,
    getPointAtLength:t=>({x:10*Math.cos(t/10),y:10*Math.sin(t/10)})};
  const point=closestWirePoint(curve,{x:14*Math.cos(angle),y:14*Math.sin(angle)});
  assert.ok(Math.hypot(point.x-10*Math.cos(angle),point.y-10*Math.sin(angle))<.01,'curves project onto the actual path');
  console.log('PASS: flow-coordinate projection, endpoints and curved paths');
} finally {await rm(directory,{recursive:true,force:true})}
