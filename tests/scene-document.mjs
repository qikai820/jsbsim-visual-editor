import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'scene-document-'));
try {
  const output = path.join(directory, 'document.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../client/src/sim/sceneDocument.ts', import.meta.url))],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { newSceneDocument, newSceneWindsock, sceneObjectVisible, validateSceneDocument, defaultSceneTransform } = createRequire(import.meta.url)(output);
  const fresh = newSceneDocument();
  assert.equal(fresh.version, 2);assert.equal(fresh.objects.length,37);
  assert.equal(fresh.visualGroundOffsetM,0);
  assert.equal(new Set(fresh.objects.map(o=>o.id)).size,37);
  assert.equal(fresh.objects.filter(o=>o.builtin==='tree').length,32);
  assert.equal(fresh.objects.find(o=>o.builtin==='windsock').collision,false);
  assert.deepEqual(fresh.objects.find(o=>o.builtin==='windsock').position,[-6,0,0]);
  assert.deepEqual(fresh.objects.find(o=>o.builtin==='runway').position,[50,.025,-100]);
  const apron=fresh.objects.find(o=>o.builtin==='apron'), f35=fresh.objects.find(o=>o.builtin==='f35');
  assert.deepEqual(apron.position,[-35,.024,-8]);assert.deepEqual(f35.position,apron.position);
  assert.deepEqual(f35.rotation,[0,180,0]);assert.equal(f35.collision,false);
  // Independent documents must never share mutable transform arrays.
  fresh.objects[0].position[0]=91;
  assert.equal(newSceneDocument().objects[0].position[0],50);
  const old = { format:'jsbsim-flight-scene',version:1,name:'旧场景',groundAltitude:12,showBase:false,
    assets:[{id:'model',entry:'test.gltf',files:[{path:'test.gltf',data:'data:application/json;base64,e30='}]}],
    objects:[{id:'imported',assetId:'model',name:'Imported',visible:true,position:[1,2,3],rotation:[4,5,6],scale:[1,2,3]}] };
  const migrated = validateSceneDocument(old);
  assert.equal(migrated.version,2);assert.equal(migrated.objects.length,38);assert.equal(migrated.showBase,false);
  assert.deepEqual(migrated.objects.find(o=>o.id==='imported'),old.objects[0]);
  assert.equal(old.objects.length,1,'migration does not modify the input document');
  assert.equal(validateSceneDocument(migrated).objects.length,38,'migration is idempotent');
  const edited = newSceneDocument();edited.objects[0].position=[81,2,-44];edited.objects[1].rotation=[2,38,4];edited.objects[2].scale=[2,3,.5];
  edited.objects[3].visible=false;edited.objects=edited.objects.filter(o=>o.id!=='builtin-tree-32');
  const loaded=validateSceneDocument(JSON.parse(JSON.stringify(edited)));
  assert.deepEqual(loaded,edited,'built-in transforms, visibility and deletion survive a file roundtrip');
  for (const offset of [-.3, 0, .25]) assert.equal(validateSceneDocument(JSON.parse(JSON.stringify({ ...edited, visualGroundOffsetM: offset }))).visualGroundOffsetM,offset,'display ground offset survives the scene file roundtrip');
  const legacy = { ...edited };delete legacy.visualGroundOffsetM;
  assert.equal(validateSceneDocument(legacy).visualGroundOffsetM ?? 0,0,'older scenes keep zero display correction');
  assert.deepEqual(validateSceneDocument({...newSceneDocument(),objects:[]}).objects,[],'an intentionally empty v2 scene stays empty');
  assert.deepEqual(defaultSceneTransform(loaded.objects[0]),{position:[50,.025,-100],rotation:[0,0,0],scale:[1,1,1]});
  const layout=newSceneDocument();
  for(let i=0;i<12;i++)layout.objects.push(newSceneWindsock(layout.objects,`wind-${i}`));
  const socks=layout.objects.filter(object=>object.builtin==='windsock');
  assert.equal(socks.length,13);assert.equal(new Set(socks.map(object=>object.name)).size,13);
  for(const a of socks)for(const b of socks)if(a!==b)assert.ok(Math.hypot(a.position[0]-b.position[0],a.position[2]-b.position[2])>=5-1e-6);
  const source=socks[1];source.position=[10,2,-30];source.rotation=[0,55,0];source.scale=[2,1.5,2];source.collision=true;source.visible=false;
  const copy=newSceneWindsock(layout.objects,'copied',source);
  assert.equal(copy.visible,true);assert.equal(copy.collision,true);assert.equal(copy.position[1],2);
  assert.deepEqual(copy.rotation,source.rotation);assert.deepEqual(copy.scale,source.scale);assert.notDeepEqual(copy.position,source.position);
  copy.rotation[1]=0;copy.scale[0]=1;assert.equal(source.rotation[1],55);assert.equal(source.scale[0],2);
  layout.objects.push(copy);layout.showBase=false;
  assert.ok(sceneObjectVisible(copy,false));assert.ok(!sceneObjectVisible(source,false));
  assert.ok(!sceneObjectVisible(layout.objects.find(object=>object.builtin==='runway'),false));
  assert.deepEqual(validateSceneDocument(JSON.parse(JSON.stringify(layout))),layout,'multiple windsock layouts roundtrip independently of the default field');
  const invalid = [
    {...newSceneDocument(),version:3},
    {...newSceneDocument(),objects:[{...edited.objects[0],builtin:'unknown'}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],seed:32}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],seed:1.5}]},
    {...newSceneDocument(),objects:[{...edited.objects[0],assetId:'model'}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],scale:[1,0,1]}]},
    {...newSceneDocument(),objects:[edited.objects[0],edited.objects[0]]},
    ...[null, '0.2', NaN, Infinity, -100.01, 100.01].map(visualGroundOffsetM=>({...newSceneDocument(),visualGroundOffsetM})),
  ];
  for(const doc of invalid)assert.throws(()=>validateSceneDocument(doc),/场景文件无效/);
  console.log('Scene document: independent defaults, v1 migration, v2 transform/visibility/deletion roundtrip, reset and malformed object rejection passed.');
} finally { await rm(directory,{recursive:true,force:true}); }
