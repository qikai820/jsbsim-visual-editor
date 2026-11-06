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
  const { newSceneDocument, validateSceneDocument, defaultSceneTransform } = createRequire(import.meta.url)(output);
  const fresh = newSceneDocument();
  assert.equal(fresh.version, 2);assert.equal(fresh.objects.length,34);
  assert.equal(new Set(fresh.objects.map(o=>o.id)).size,34);
  assert.equal(fresh.objects.filter(o=>o.builtin==='tree').length,32);
  assert.deepEqual(fresh.objects.find(o=>o.builtin==='runway').position,[50,.025,-100]);
  // Independent documents must never share mutable transform arrays.
  fresh.objects[0].position[0]=91;
  assert.equal(newSceneDocument().objects[0].position[0],50);
  const old = { format:'jsbsim-flight-scene',version:1,name:'旧场景',groundAltitude:12,showBase:false,
    assets:[{id:'model',entry:'test.gltf',files:[{path:'test.gltf',data:'data:application/json;base64,e30='}]}],
    objects:[{id:'imported',assetId:'model',name:'Imported',visible:true,position:[1,2,3],rotation:[4,5,6],scale:[1,2,3]}] };
  const migrated = validateSceneDocument(old);
  assert.equal(migrated.version,2);assert.equal(migrated.objects.length,35);assert.equal(migrated.showBase,false);
  assert.deepEqual(migrated.objects.find(o=>o.id==='imported'),old.objects[0]);
  assert.equal(old.objects.length,1,'migration does not modify the input document');
  assert.equal(validateSceneDocument(migrated).objects.length,35,'migration is idempotent');
  const edited = newSceneDocument();edited.objects[0].position=[81,2,-44];edited.objects[1].rotation=[2,38,4];edited.objects[2].scale=[2,3,.5];
  edited.objects[3].visible=false;edited.objects=edited.objects.filter(o=>o.id!=='builtin-tree-32');
  const loaded=validateSceneDocument(JSON.parse(JSON.stringify(edited)));
  assert.deepEqual(loaded,edited,'built-in transforms, visibility and deletion survive a file roundtrip');
  assert.deepEqual(validateSceneDocument({...newSceneDocument(),objects:[]}).objects,[],'an intentionally empty v2 scene stays empty');
  assert.deepEqual(defaultSceneTransform(loaded.objects[0]),{position:[50,.025,-100],rotation:[0,0,0],scale:[1,1,1]});
  const invalid = [
    {...newSceneDocument(),version:3},
    {...newSceneDocument(),objects:[{...edited.objects[0],builtin:'unknown'}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],seed:32}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],seed:1.5}]},
    {...newSceneDocument(),objects:[{...edited.objects[0],assetId:'model'}]},
    {...newSceneDocument(),objects:[{...edited.objects[2],scale:[1,0,1]}]},
    {...newSceneDocument(),objects:[edited.objects[0],edited.objects[0]]},
  ];
  for(const doc of invalid)assert.throws(()=>validateSceneDocument(doc),/场景文件无效/);
  console.log('Scene document: independent defaults, v1 migration, v2 transform/visibility/deletion roundtrip, reset and malformed object rejection passed.');
} finally { await rm(directory,{recursive:true,force:true}); }
