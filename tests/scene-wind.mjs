import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'scene-wind-'));
try {
  const output = path.join(directory, 'wind.cjs');
  await build({ stdin: { contents: `export * from './client/src/sim/sceneWind';export * from './client/src/sim/flightSceneState';export * from './client/src/sim/sceneDocument';export * from './client/src/sim/sceneCollision';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { SCENE_WIND_KEYS, windReading, windsockCenter, decodeScenePose, FlightSceneFeed, demoPackets, newSceneDocument, exportSceneCollision } = createRequire(import.meta.url)(output);
  const packet = demoPackets(10)[0];
  function vector(north, east, down, age = 0) {
    return { ...packet, properties: Object.fromEntries(SCENE_WIND_KEYS.map((key,i)=>['/01/jsbsim/'+key,[north,east,down][i]/.3048])),
      scene_property_age_ms: Object.fromEntries(SCENE_WIND_KEYS.map(key=>['/01/jsbsim/'+key,age])) };
  }
  for (const [north,east,from,x,z] of [[7,0,180,0,-1],[0,7,270,1,0],[-7,0,0,0,1],[0,-7,90,-1,0]]) {
    const pose=decodeScenePose(vector(north,east,0),1000), reading=windReading(pose,1000);
    assert.equal(reading.fromDegrees,from);assert.ok(Math.abs(reading.speed-7)<1e-10);
    assert.ok(Math.abs(Math.cos(reading.yaw)-x)<1e-10);assert.ok(Math.abs(-Math.sin(reading.yaw)-z)<1e-10);
    assert.ok(Math.abs(reading.inflation-1)<1e-10);assert.ok(reading.moving);
  }
  const calm=windReading(decodeScenePose(vector(0,0,0),1000),1000);
  assert.equal(calm.speed,0);assert.equal(calm.fromDegrees,null);assert.equal(calm.inflation,0);assert.ok(calm.fresh);
  assert.ok(windsockCenter(1,0)[1]<-1.2);assert.equal(windsockCenter(1,1)[1],0);
  const vertical=windReading(decodeScenePose(vector(0,0,-5),1000),1000);
  assert.equal(vertical.yaw,null);assert.equal(vertical.elevation,Math.PI/2);
  const partial=vector(2,3,4);delete partial.properties['/01/jsbsim/'+SCENE_WIND_KEYS[1]];
  assert.equal(decodeScenePose(partial,1000).wind,null,'partial components cannot fabricate a wind vector');
  const skew=vector(2,3,4);skew.scene_property_age_ms['/01/jsbsim/'+SCENE_WIND_KEYS[0]]=300;
  assert.equal(decodeScenePose(skew,1000).wind,null,'incoherent components cannot drive the bag');
  const stale=windReading(decodeScenePose(vector(2,3,4,2100),3000),3000);
  assert.ok(stale.wind);assert.ok(!stale.fresh);assert.ok(!stale.moving);
  assert.ok(!windReading(decodeScenePose({...vector(7,0,0),state:'paused'},1000),1000).moving);
  assert.ok(!windReading(decodeScenePose({...vector(7,0,0),state:'stopped'},1000),1000).moving);
  const foreign=vector(7,0,0);foreign.instance_id='02';
  assert.equal(decodeScenePose(foreign,1000).wind,null);
  const sliced=new FlightSceneFeed();sliced.ingest(vector(3,4,0),1000);
  sliced.ingest({...partial,timestamp:10.1,capture_monotonic_us:10.1e6},1100);
  assert.ok(Math.abs(windReading(sliced.aircraft.get('01').latest,1100).speed-5)<1e-10,'an incomplete native slice retains the last coherent wind');
  assert.equal(sliced.aircraft.get('01').latest.windSampleAt,1000,'incomplete native slices cannot freshen wind');
  assert.ok(!windReading(sliced.aircraft.get('01').latest,3100).fresh);
  const feed=new FlightSceneFeed();feed.ingest(vector(0,0,0),1000);
  const received=feed.aircraft.get('01').latest.receivedAt;
  const monitor=(sequence, samples, t=10.1)=>({instance_id:'01',model:'voliro_t',tree_generation:'demo',timestamp:t,
    monitor:{version:1,revision:1,sequence,samples}});
  const samples=Object.fromEntries(SCENE_WIND_KEYS.map((key,i)=>[key,[[3,4,0][i]/.3048,10.1,false]]));
  feed.ingestMonitor(monitor(1,{[SCENE_WIND_KEYS[0]]:samples[SCENE_WIND_KEYS[0]]}),1100);
  assert.equal(windReading(feed.aircraft.get('01').latest,1100).speed,0,'partial fast frame keeps prior coherent vector');
  feed.ingestMonitor(monitor(2,samples),1150);
  assert.ok(Math.abs(windReading(feed.aircraft.get('01').latest,1150).speed-5)<1e-10);
  assert.equal(feed.aircraft.get('01').latest.receivedAt,received,'wind traffic cannot freshen aircraft pose');
  feed.ingest({...packet,properties:{},scene_property_age_ms:{},timestamp:10.2,capture_monotonic_us:10.2e6},1200);
  assert.ok(Math.abs(windReading(feed.aircraft.get('01').latest,1200).speed-5)<1e-10,'native slices do not erase fast wind');
  feed.ingest({...packet,properties:{},scene_property_age_ms:{},timestamp:10.2,capture_monotonic_us:10.2e6},3300);
  assert.ok(!windReading(feed.aircraft.get('01').latest,3300).fresh,'repeated snapshots cannot freshen wind');
  feed.ingest({...packet,properties:{},scene_property_age_ms:{},tree_generation:'new',timestamp:0,capture_monotonic_us:11e6},3400);
  assert.equal(feed.aircraft.get('01').latest.wind,null,'reload drops previous field');
  const doc=newSceneDocument();doc.georeference={latitude:30,longitude:120,altitude:0};
  doc.objects=doc.objects.filter(o=>o.builtin==='windsock');
  const groundOnly=exportSceneCollision(doc,new Map());doc.objects[0].collision=true;
  const pole=exportSceneCollision(doc,new Map());assert.notEqual(pole,groundOnly,'optional pole collision exports without an imported asset');
  const saved=JSON.parse(JSON.stringify(doc));saved.objects[0].collision=false;
  assert.equal(exportSceneCollision(saved,new Map()),groundOnly,'animated cloth stays outside the static collision map by default');
  doc.showBase=false;
  assert.ok(exportSceneCollision(doc,new Map()).startsWith('JSBSCENE1 '),'visible poles still export on custom terrain');
  doc.objects[0].visible=false;
  assert.throws(()=>exportSceneCollision(doc,new Map()),/没有可导出/,'individually hidden poles do not collide');
  console.log('Wind: NED units, four compass directions, calm/vertical wind, pause/expiry, coherent components, instance isolation, fast monitor merge and reload passed.');
} finally { await rm(directory,{recursive:true,force:true}); }
