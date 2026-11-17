import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto=webcrypto;
const directory=await mkdtemp(path.join(tmpdir(),'scene-online-'));
try {
  const output=path.join(directory,'online.cjs');
  await build({stdin:{contents:`export * from './client/src/sim/sceneOnline';export * from './client/src/sim/sceneDocument';`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {downloadSceneAsset,sceneModelUrl,sceneAssetJson,sceneAssetBytes,newSceneDocument,validateSceneDocument}=createRequire(import.meta.url)(output);
  const signal=()=>new AbortController().signal;
  for(const url of ['file:///tmp/model.glb','javascript:alert(1)','https://user:password@example.com/model.glb'])assert.throws(()=>sceneModelUrl(url),/HTTP/);
  assert.throws(()=>sceneModelUrl('https://sketchfab.com/3d-models/punxsutawney-municipal-airport-385c2f095c824374b5aa22ae1689b160'),/展示页/);
  const calls=[],binary=new Uint8Array([0,128,255,10]);
  const json={asset:{version:'2.0'},buffers:[{uri:'../shared/mesh.bin?token=example',byteLength:4}],images:[{uri:'https://cdn.example.com/grass.png?v=2'},{uri:'https://cdn.example.com/grass.png?v=2'}]};
  const fetcher=async(url,options)=>{
    calls.push(url);assert.equal(options.credentials,'omit');assert.equal(options.mode,'cors');
    if(url==='https://example.com/models/airport.gltf'){
      const response=new Response(JSON.stringify(json),{headers:{'content-type':'model/gltf+json'}});
      Object.defineProperty(response,'url',{value:'https://example.com/redirected/airport.gltf'});return response;
    }
    if(url==='https://example.com/shared/mesh.bin?token=example')return new Response(binary);
    if(url==='https://cdn.example.com/grass.png?v=2')return new Response(binary,{headers:{'content-type':'image/png'}});
    throw Error('Unexpected URL '+url);
  };
  const asset=await downloadSceneAsset('https://example.com/models/airport.gltf',{signal:signal(),fetcher});
  assert.equal(asset.files.length,3);assert.equal(calls.length,3,'identical remote textures are downloaded once');
  const packed=sceneAssetJson(asset);
  assert.equal(packed.buffers[0].uri,'resources/file-1.bin');assert.equal(packed.images[0].uri,packed.images[1].uri);
  assert.deepEqual(Buffer.from(asset.files[1].data.split(',')[1],'base64'),Buffer.from(binary));
  assert.equal(JSON.stringify(asset).includes('token=example'),false,'portable scenes do not retain source URL credentials');
  validateSceneDocument({...newSceneDocument(),assets:[asset],objects:[{id:'airport',assetId:asset.id,name:'Online',visible:true,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}]});
  function glb(model,bin){
    const encoded=Buffer.from(JSON.stringify(model)), padded=Math.ceil(encoded.length/4)*4;
    const bytes=Buffer.alloc(20+padded+(bin?8+bin.length:0),32);
    bytes.writeUInt32LE(0x46546c67,0);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(padded,12);bytes.writeUInt32LE(0x4e4f534a,16);encoded.copy(bytes,20);
    if(bin){bytes.writeUInt32LE(bin.length,20+padded);bytes.writeUInt32LE(0x004e4942,24+padded);bin.copy(bytes,28+padded)}return bytes;
  }
  const source=glb({asset:{version:'2.0'},buffers:[{byteLength:4}],images:[{uri:'grass.png'}]},Buffer.from(binary));
  const packedGlb=await downloadSceneAsset('https://example.com/model.glb',{signal:signal(),fetcher:async url=>new Response(url.endsWith('grass.png')?binary:source)});
  const rewritten=sceneAssetBytes(packedGlb),rewrittenJson=sceneAssetJson(packedGlb);
  assert.equal(rewrittenJson.images[0].uri,'resources/file-1.png');assert.deepEqual(rewritten.slice(-4),binary,'GLB JSON rewriting preserves the binary chunk');
  assert.equal(new DataView(rewritten.buffer).getUint32(8,true),rewritten.length);
  const embedded=glb({asset:{version:'2.0'},buffers:[{byteLength:4}]},Buffer.from(binary));
  const unchanged=await downloadSceneAsset('https://example.com/download?signed=1',{signal:signal(),fetcher:async()=>new Response(embedded)});
  assert.equal(unchanged.entry,'online-scene.glb');assert.deepEqual(Buffer.from(sceneAssetBytes(unchanged)),embedded);
  for(const [body,status,expected]of [['<html>Product page</html>',200,/直链/],['Not found',404,/404/],[JSON.stringify({asset:{version:'1.0'}}),200,/glTF 2.0/]]){
    await assert.rejects(()=>downloadSceneAsset('https://example.com/model',{signal:signal(),fetcher:async()=>new Response(body,{status})}),expected);
  }
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model',{signal:signal(),maxBytes:8,fetcher:async()=>new Response('abc',{headers:{'content-length':'9'}})}),/100 MB/);
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model',{signal:signal(),maxBytes:8,fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5));c.enqueue(new Uint8Array(5));c.close()}}))}),/100 MB/,'streamed bodies enforce the limit without Content-Length');
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model',{signal:signal(),fetcher:async()=>{throw new TypeError('Failed to fetch')}}),/CORS/);
  let requests=0;
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model.gltf',{signal:signal(),fetcher:async()=>{requests++;return new Response(JSON.stringify({...json,extensionsRequired:['KHR_draco_mesh_compression']}))}}),/压缩/);
  assert.equal(requests,1,'unsupported compression fails before downloading textures');
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model.gltf',{signal:signal(),fetcher:async()=>new Response(JSON.stringify({asset:{version:'2.0'},images:[{uri:'http://example.com/grass.png'}]}))}),/HTTPS/);
  const hanging=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
  await assert.rejects(()=>downloadSceneAsset('https://example.com/model.glb',{signal:signal(),timeoutMs:15,fetcher:hanging}),/超时/);
  const controller=new AbortController();
  const pending=downloadSceneAsset('https://example.com/model.glb',{signal:controller.signal,fetcher:hanging});controller.abort();await assert.rejects(()=>pending,/取消/);
  console.log('Online scenery: real GLB/glTF bytes, redirected dependencies, texture deduplication, portable assets, GLB binary preservation, credentials omission, page/compression rejection, download limits, CORS, timeout and cancellation passed.');
}finally{await rm(directory,{recursive:true,force:true})}
