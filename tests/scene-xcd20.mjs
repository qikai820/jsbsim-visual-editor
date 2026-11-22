import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const work=await mkdtemp(path.join(tmpdir(),'xcd20-scene-'));
try {
  const output=path.join(work,'model.cjs');
  await build({stdin:{contents:`export * from './client/src/sim/sceneXcd20';export * from './client/src/sim/sceneXcd20Visual';export * from './client/src/sim/sceneRotors';export * from './client/src/sim/flightSceneState';export * from './client/src/sim/sceneSignals';export{Vector3}from'three';`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {isXcd20,XCD20_GEOMETRY:g,XCD20_ROTORS:r,createXcd20Model,rotorCount,rotorLabel,rotorReading,decodeScenePose,sceneSignalKeys,Vector3}=createRequire(import.meta.url)(output);
  for(const name of ['XCD20','xcd20','XCD20_usb','XCD20.xml'])assert(isXcd20(name)&&rotorCount(name)===8);
  assert(!isXcd20('XCD200'));assert.equal(rotorCount('F450'),4);assert.equal(rotorCount('MorphQuad'),8);assert.equal(rotorCount('voliro_t'),5);
  assert.equal(g.rotorRadius*2,.381);assert.equal(g.blades,3);assert.deepEqual(g.batteryDimensionsBody,[.2,.15,.08]);
  const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
  near(Math.hypot(r[0].x-r[2].x,r[0].z-r[2].z),.7);
  for(const rotor of r){const peer=r[rotor.paired_channel];near(rotor.x,peer.x);near(rotor.z,peer.z);near(Math.abs(rotor.y-peer.y),.15);assert.equal(rotor.sense,-peer.sense);}
  assert.equal(rotorLabel('XCD20',4),'M5 · 左前下');
  const keys=sceneSignalKeys('XCD20');assert(keys.length<=32);
  for(let i=0;i<8;i++){assert(keys.includes(`propulsion/engine[${i}]/propeller-rpm`));assert(keys.includes(`propulsion/engine[${i}]/propeller-sense`));}
  const properties=Object.fromEntries(r.flatMap(rotor=>[[`/propulsion/engine[${rotor.channel}]/propeller-rpm`,4900+rotor.channel*10],[`/propulsion/engine[${rotor.channel}]/propeller-sense`,rotor.sense]]));
  const packet={instance_id:'01',model:'XCD20',tree_generation:1,state:'running',timestamp:10,latitude_deg:34,longitude_deg:109,altitude_m:583,roll_deg:0,pitch_deg:0,yaw_deg:0,properties,scene_property_age_ms:Object.fromEntries(Object.keys(properties).map(k=>[k,0]))};
  const pose=decodeScenePose(packet,1000);assert.equal(pose.rpm.length,8);
  for(const rotor of r){const reading=rotorReading(pose,rotor.channel,1000);assert.equal(reading.rpm,4900+rotor.channel*10);assert.equal(Math.sign(reading.angularVelocity),rotor.sense);assert.equal(rotorReading({...pose,state:'paused'},rotor.channel,1000).angularVelocity,0);assert.equal(rotorReading(pose,rotor.channel,3100).angularVelocity,0);}
  const missing=decodeScenePose({...packet,properties:{},scene_property_age_ms:{}},1000);assert.equal(rotorReading(missing,7,1000).source,'none');
  const model=createXcd20Model();model.root.updateWorldMatrix(true,true);
  let draws=0,triangles=0;const geometries=new Set(),materials=new Set();
  model.root.traverse(o=>{if(o.isMesh){draws++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);geometries.add(o.geometry);(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));}});
  for(const rotor of r){const object=model.rotors[rotor.channel];assert.equal(object.children[0].count,3);const p=object.getWorldPosition(new Vector3());near(p.x,rotor.x);near(p.y,rotor.y);near(p.z,rotor.z);}
  assert(draws<=40&&triangles<35000,JSON.stringify({draws,triangles}));
  let disposedGeometry=0,disposedMaterial=0;geometries.forEach(o=>o.addEventListener('dispose',()=>disposedGeometry++));materials.forEach(o=>o.addEventListener('dispose',()=>disposedMaterial++));model.dispose();assert.equal(disposedGeometry,geometries.size);assert.equal(disposedMaterial,materials.size);
  console.log('PASS: XCD20 physical dimensions, eight-channel telemetry and spin signs, stale/pause handling, propeller counts, GPU resource disposal and legacy model counts.',JSON.stringify({draws,triangles,monitorKeys:keys.length}));
} finally {await rm(work,{recursive:true,force:true});}
