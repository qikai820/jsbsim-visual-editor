// Real WebGL rendering and Tauri event contract with isolated IPC; no board I/O.
// Run with Node 20 --experimental-websocket against a running Vite server.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const base = process.argv[2] || 'http://127.0.0.1:5185';
const name = `.scene-editor-test-${process.pid}`;
const html = new URL(`../client/${name}.html`, import.meta.url);
const module = new URL(`../client/${name}.tsx`, import.meta.url);
const rootsModule = new URL(`../client/${name}-roots.ts`, import.meta.url);
const profile = await mkdtemp(path.join(tmpdir(), 'flight-scene-chrome-'));
await writeFile(html, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
await writeFile(rootsModule, `export {_roots as roots} from '@react-three/fiber';`);
await writeFile(module, `import React from 'react';import{createRoot}from'react-dom/client';import{_roots}from'@react-three/fiber';import FlightScene from './src/components/flight-scene/FlightScene';import './src/App.css';window.__sceneRoots=_roots;function Harness(){return <div style={{display:'flex',height:'100vh'}}><FlightScene onClose={()=>{}} /></div>}createRoot(document.getElementById('root')).render(<Harness/>);`);
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error('Chrome timeout')), 15000);
    chrome.stderr.on('data', chunk => { out += chunk; const found = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timer); resolve(found[1]); } });
  });
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(p => p.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(), exceptions = [], shaderErrors = [];
  ws.addEventListener('message', event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '')); });
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { const message = m.params.args.map(arg => arg.value || arg.description || '').join(' '); if (/WebGLProgram|Shader Error|VALIDATE_STATUS/.test(message)) shaderErrors.push(message); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate('Boolean(' + expression + ')')) return; await new Promise(r => setTimeout(r, 100)); } throw Error(`Timeout ${expression}\n${await evaluate('document.body.innerText')}\n${exceptions.join('\n')}`); };
  const clickText = text => evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('No button '+${JSON.stringify(text)});button.click()})()`);
  const screenshot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(file, Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__events=new Map();window.__emit=(event,payload)=>{for(const[eventId,callback]of window.__events.get(event)||[])callback({event,id:eventId,payload})};const callbacks=new Map();let id=0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
    window.__TAURI_INTERNALS__={transformCallback(callback){callbacks.set(++id,callback);return id},unregisterCallback(n){callbacks.delete(n)},invoke:async(command,args)=>{
      if(command==='plugin:event|listen'){const n=++id;if(!window.__events.has(args.event))window.__events.set(args.event,new Map());window.__events.get(args.event).set(n,callbacks.get(args.handler));return n}
      if(command==='plugin:event|unlisten'){window.__events.get(args.event)?.delete(args.eventId);return}
      if(command==='scene_upload_collision'){if(window.__failSync)throw Error('readback mismatch');return{path:'jsbsim/aircraft/ball/scene.collision',revision:Number(args.content.split(' ')[1])}}
      if(command==='scene_import_directory')return window.__nativeDirectory||null;return [];
    }};
    const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/json')window.__saved=blob;if(blob.type==='application/octet-stream')window.__collision=blob;return create(blob)};
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/${name}.html` });
  await until(`document.querySelector('.scene-empty')`);
  await clickText('编辑场景');
  await until(`document.querySelector('.scene-editor')`);
  await until(`window.__sceneRoots?.get(document.querySelector('canvas'))?.store.getState().scene.getObjectByName('scene-object-builtin-runway')`);

  const binary = Buffer.from(new Float32Array([0,0,0, 2,0,0, 0,2,0, 0,0, 1,0, 0,1]).buffer);
  const model = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0,0,0], max: [2,2,0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.9,.3,.1,1], metallicFactor: 0 } }] };
  const rawJson = Buffer.from(JSON.stringify(model)), json = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 0x20);rawJson.copy(json);
  const glb = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(json.length,12);glb.writeUInt32LE(0x4e4f534a,16);json.copy(glb,20);
  glb.writeUInt32LE(binary.length,20+json.length);glb.writeUInt32LE(0x004e4942,24+json.length);binary.copy(glb,28+json.length);
  const importFiles = (files, input = '导入模型文件') => evaluate(`(()=>{const transfer=new DataTransfer();for(const f of ${JSON.stringify(files)}){const file=new File([Uint8Array.from(atob(f.data),c=>c.charCodeAt(0))],f.name.split('/').pop(),{type:f.type||''});if(f.path)Object.defineProperty(file,'webkitRelativePath',{value:f.path});transfer.items.add(file)}const input=document.querySelector('input[aria-label="${input}"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const rootState = `window.__sceneRoots.get(document.querySelector('canvas')).store.getState()`;
  const objectState = `(()=>{const s=${rootState},id=document.querySelector('[data-scene-object][aria-pressed=true]')?.dataset.sceneObject,o=s.scene.getObjectByName('scene-object-'+id);return o?{id,p:o.position.toArray(),r:[o.rotation.x,o.rotation.y,o.rotation.z],s:o.scale.toArray(),visible:o.visible}:null})()`;
  const setNumber = (label, value) => evaluate(`(()=>{const i=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${value}');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=builtin]').length`),34);
  const builtinCases = [
    ['builtin-runway', [45,.2,-90], [0,15,0], [1.1,1,1.2]],
    ['builtin-hangar', [-30,1,-55], [0,25,0], [1.2,.9,.8]],
    ['builtin-tree-1', [-90,2,-12], [8,35,5], [1.5,1.8,.9]],
  ];
  const selectObject = id => evaluate(`document.querySelector('[data-scene-object="${id}"]').click()`);
  const clickWorldPoint = async (id, point) => {
    const position=await evaluate(`(()=>{const s=${rootState},o=s.scene.getObjectByName('scene-object-${id}'),r=s.gl.domElement.getBoundingClientRect(),p=o.localToWorld(s.camera.position.clone().set(${point.join(',')})).project(s.camera);return{x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...position});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',clickCount:1});
    await until(`document.querySelector('[data-scene-object="${id}"]').getAttribute('aria-pressed')==='true'`);
  };
  for(const [id,position,rotation,scale] of builtinCases) {
    await selectObject(id);
    for(const [label,values] of [['位置',position],['旋转',rotation],['缩放',scale]])
      for(let i=0;i<3;i++)await setNumber(label+' '+['X','Y','Z'][i],values[i]);
    const actual=await evaluate(objectState);assert.deepEqual(actual.p,position);assert.deepEqual(actual.s,scale);
    assert.ok(actual.r.every((n,i)=>Math.abs(n-rotation[i]*Math.PI/180)<1e-6));
    await clickText('定位物体');await new Promise(r=>setTimeout(r,150));
    await selectObject(id==='builtin-runway'?'builtin-hangar':'builtin-runway');
    await clickWorldPoint(id,id==='builtin-runway'?[3,0,10]:id==='builtin-hangar'?[0,4,0]:[0,5.2,Math.sin(1)*.5]);
  }
  // Compare rendered instances against the selected tree's complete transform,
  // rather than checking only the inspector or the invisible editing pivot.
  assert.ok(await evaluate(`(()=>{const s=${rootState},o=s.scene.getObjectByName('scene-object-builtin-tree-1'),mesh=s.scene.getObjectByName('scene-tree-trunks'),actual=mesh.matrix.clone();mesh.getMatrixAt(0,actual);actual.premultiply(mesh.matrixWorld);const local=mesh.matrix.clone().makeScale(.24,3,.24);local.setPosition(0,1.5,0);const expected=o.matrixWorld.clone().multiply(local);return actual.elements.every((n,i)=>Math.abs(n-expected.elements[i])<1e-4)})()`),'tree instance follows position, rotation and nonuniform scale');
  const treeMatrix = await evaluate(`(()=>{const s=${rootState},m=s.scene.getObjectByName('scene-tree-trunks'),a=m.matrix.clone();m.getMatrixAt(1,a);return a.elements})()`);
  const firstTreeX = await evaluate(`(()=>{const m=(${rootState}).scene.getObjectByName('scene-tree-trunks'),a=m.matrix.clone();m.getMatrixAt(0,a);return a.elements[12]})()`);
  await setNumber('位置 X',-85);
  await until(`(()=>{const m=(${rootState}).scene.getObjectByName('scene-tree-trunks'),a=m.matrix.clone();m.getMatrixAt(0,a);return Math.abs(a.elements[12]-(${firstTreeX + 5}))<1e-4})()`);
  assert.deepEqual(await evaluate(`(()=>{const s=${rootState},m=s.scene.getObjectByName('scene-tree-trunks'),a=m.matrix.clone();m.getMatrixAt(1,a);return a.elements})()`),treeMatrix,'editing one tree does not move its neighbour');
  builtinCases[2][1][0]=-85;
  await evaluate(`document.querySelectorAll('.scene-editor-check input')[1].click()`);
  await until(`(()=>{const s=${rootState},m=s.scene.getObjectByName('scene-tree-trunks'),a=m.matrix.clone();m.getMatrixAt(0,a);return a.elements[0]===0&&a.elements[5]===0&&a.elements[10]===0})()`);
  await evaluate(`document.querySelectorAll('.scene-editor-check input')[1].click()`);
  await selectObject('builtin-tree-32');await clickText('删除物体');
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=builtin]').length`),33);
  await screenshot('/tmp/jsbsim-scene-builtins.png');
  await importFiles([{ name: 'triangle.glb', data: glb.toString('base64') }]);
  await until(`document.querySelectorAll('[data-scene-source=model]').length===1 && !document.querySelector('fieldset').disabled`);
  await until(`${objectState}`);
  assert.equal(await evaluate(`document.querySelector('.scene-camera-tabs button.active').textContent`), '自由');
  await setNumber('位置 X', 3); await setNumber('位置 Y', 4); await setNumber('位置 Z', -2);
  await setNumber('旋转 Y', 45); await setNumber('缩放 X', 2);
  await until(`(${objectState})?.p[0]===3 && (${objectState})?.p[1]===4 && (${objectState})?.s[0]===2`);
  assert.ok(Math.abs((await evaluate(objectState)).r[1] - Math.PI / 4) < 1e-6);
  await clickText('旋转');
  assert.equal(await evaluate(`(()=>{let c;(${rootState}).scene.traverse(o=>{if(o.isTransformControls)c=o});return c.mode})()`), 'rotate');
  await clickText('缩放');
  assert.equal(await evaluate(`(()=>{let c;(${rootState}).scene.traverse(o=>{if(o.isTransformControls)c=o});return c.mode})()`), 'scale');
  await clickText('移动'); await clickText('定位物体');
  await new Promise(r => setTimeout(r, 250));
  // Find a real X handle hit, then drag via browser pointer events.
  const handle = await evaluate(`(()=>{const s=${rootState};let c;s.scene.traverse(o=>{if(o.isTransformControls)c=o});const rect=s.gl.domElement.getBoundingClientRect(),center=c.worldPosition.clone().project(s.camera),cx=(center.x+1)*rect.width/2,cy=(1-center.y)*rect.height/2;for(let d=20;d<85;d+=4)for(let a=0;a<6.28;a+=.12){const x=cx+Math.cos(a)*d,y=cy+Math.sin(a)*d;c.pointerHover({x:x/rect.width*2-1,y:1-y/rect.height*2,button:0});if(c.axis==='X')return{x:x+rect.x,y:y+rect.y}}return null})()`);
  assert.ok(handle, 'a visible transform X handle is pickable');
  const beforeDrag = await evaluate(objectState);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...handle });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
  assert.equal(await evaluate(`(${rootState}).controls.enabled`), false, 'orbit is disabled during gizmo drag');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 55, y: handle.y + 8, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 55, y: handle.y + 8, button: 'left', clickCount: 1 });
  await until(`Math.abs((${objectState}).p[0]-${beforeDrag.p[0]})>.1`);
  assert.equal(await evaluate(`(${rootState}).controls.enabled`), true, 'orbit resumes after dragging');
  await until(`Math.abs(Number(document.querySelector('input[aria-label="位置 X"]').value)-(${objectState}).p[0])<.001`);
  await screenshot('/tmp/jsbsim-scene-editor.png');

  // A glTF folder with a binary buffer and a nested, URL-encoded image path.
  const textured = structuredClone(model);textured.buffers[0].uri = '../mesh.bin';
  textured.images = [{ uri: '../textures/red%20tile.png' }];textured.textures = [{ source: 0 }];
  textured.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  const image = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=2;const ctx=c.getContext('2d');ctx.fillStyle='#c86432';ctx.fillRect(0,0,2,2);return c.toDataURL('image/png').split(',')[1]})()`);
  const folder = [{ name: 'hangar.gltf', path: 'airport/models/hangar.gltf', data: Buffer.from(JSON.stringify(textured)).toString('base64') },
    { name: 'mesh.bin', path: 'airport/mesh.bin', data: binary.toString('base64') },
    { name: 'red tile.png', path: 'airport/textures/red tile.png', type: 'image/png', data: image }];
  await evaluate(`window.__nativeDirectory=${JSON.stringify(folder.map(file => ({ path: file.path, data: `data:${file.type || 'application/octet-stream'};base64,${file.data}` })))}`);
  await clickText('导入目录');
  await until(`document.querySelectorAll('[data-scene-source=model]').length===2 && !document.querySelector('fieldset').disabled`);
  assert.equal(await evaluate(`(()=>{const s=${rootState},id=document.querySelector('[data-scene-object][aria-pressed=true]').dataset.sceneObject,o=s.scene.getObjectByName('scene-object-'+id);let textured=false;o.traverse(n=>{if(n.material?.map?.image)textured=true});return textured})()`), true, 'external PNG is decoded and attached to glTF material');
  const beforeFailure = await evaluate(`document.querySelectorAll('[data-scene-source=model]').length`);
  await importFiles(folder.slice(0,1), '导入模型目录');
  await until(`document.querySelector('.scene-editor-error')?.textContent.includes('缺少资源')`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=model]').length`), beforeFailure, 'missing dependencies preserve the current scene');
  // A texture decode failure must not silently commit an untextured model.
  await importFiles([...folder.slice(0,2), { ...folder[2], data: Buffer.from('invalid png').toString('base64') }], '导入模型目录');
  await until(`document.querySelector('.scene-editor-error')?.textContent.includes('无法解码')`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=model]').length`), beforeFailure);

  // Set a nonzero reference elevation, verifying gizmo and object world frames.
  await evaluate(`document.querySelector('.scene-settings').open=true`);
  await setNumber('参考地面海拔', 30);
  await evaluate(`document.querySelector('.scene-settings').open=false`);
  await evaluate(`(()=>{const input=[...document.querySelectorAll('.scene-editor-check input')][0];input.click()})()`);
  await setNumber('原点纬度',30);await setNumber('原点经度',120);await setNumber('基准海拔',30);
  await clickText('保存场景');
  const saved = await evaluate(`window.__saved.text().then(JSON.parse)`);
  const imported = saved.objects.filter(object=>object.assetId);
  let exported;
  for (let i=0;i<50;i++) { exported=(await readdir(profile)).find(file=>file.endsWith('.scene.json'));if(exported)break;await new Promise(r=>setTimeout(r,100)); }
  assert.ok(exported, 'save produces an actual downloaded scene file');
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, exported),'utf8')),saved);
  assert.equal(saved.assets.length, 2);assert.equal(saved.objects.length, 35);assert.equal(saved.showBase, false);assert.equal(saved.groundAltitude, 30);
  assert.equal(saved.version,2);assert.deepEqual(saved.georeference,{latitude:30,longitude:120,altitude:30});
  for(const [id,position,rotation,scale] of builtinCases){const o=saved.objects.find(o=>o.id===id);assert.deepEqual(o.position,position);assert.deepEqual(o.rotation,rotation);assert.deepEqual(o.scale,scale)}
  assert.ok(!saved.objects.some(o=>o.id==='builtin-tree-32'),'deleted defaults stay deleted in the saved document');
  assert.equal(saved.assets[1].files.length, 3, 'portable scene carries all dependencies');
  assert.equal(imported[0].scale[0], 2);assert.equal(imported[0].rotation[1], 45);
  assert.ok(Math.abs(imported[0].position[0]-beforeDrag.p[0])>.1, 'gizmo changes are saved');
  const portable = { name: 'airport.scene.json', data: Buffer.from(JSON.stringify(saved)).toString('base64') };
  // Reload the page first: original File objects and model URLs are gone.
  await send('Page.reload');await until(`document.querySelector('.scene-empty')`);await clickText('编辑场景');
  await importFiles([portable], '加载场景文件');
  await until(`document.querySelectorAll('[data-scene-source=model]').length===2 && !document.querySelector('fieldset').disabled`);
  await evaluate(`document.querySelector('[data-scene-source=model]').click()`);
  assert.deepEqual((await evaluate(objectState)).p, imported[0].position, 'fresh page restores positions from the saved file');
  assert.deepEqual((await evaluate(objectState)).s, imported[0].scale);
  assert.equal(await evaluate(`document.querySelector('input[aria-label="参考地面海拔"]').value`), '30');
  assert.equal(await evaluate(`document.querySelector('.scene-editor-check input').checked`), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=builtin]').length`),33,'load does not reintroduce a deleted default');
  for(const [id,position,rotation,scale] of builtinCases){await selectObject(id);const actual=await evaluate(objectState);assert.deepEqual(actual.p,position);assert.deepEqual(actual.s,scale);assert.ok(actual.r.every((n,i)=>Math.abs(n-rotation[i]*Math.PI/180)<1e-6))}
  await evaluate(`document.querySelectorAll('[data-scene-source=model]')[1].click()`);
  assert.equal(await evaluate(`(()=>{const s=${rootState},id=document.querySelector('[data-scene-object][aria-pressed=true]').dataset.sceneObject;let found=false;s.scene.getObjectByName('scene-object-'+id).traverse(n=>{if(n.material?.map?.image)found=true});return found})()`), true, 'fresh load restores embedded external texture');
  const bad = structuredClone(saved);bad.objects[0].scale = [0,1,1];
  await importFiles([{ name: 'bad.json', data: Buffer.from(JSON.stringify(bad)).toString('base64') }], '加载场景文件');
  await until(`document.querySelector('.scene-editor-error')?.textContent.includes('缩放')`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-scene-source=model]').length`), 2, 'invalid scene load is atomic');
  // Collision export, live version acknowledgement, datum stability and failed sync.
  await clickText('导出仿真碰撞地图');
  await until(`window.__collision && document.body.innerText.includes('尚未同步或生效')`);
  const collision=await evaluate(`window.__collision.text()`),version=Number(collision.split(' ')[1]);
  assert(collision.startsWith('JSBSCENE1 '));
  await evaluate(`window.__collisionPacket={instance_id:'01',model:'ball',tree_generation:'collision-test',timestamp:1,state:'running',latitude_deg:30,longitude_deg:120,altitude_m:50,roll_deg:0,pitch_deg:0,yaw_deg:0,properties:{'scene/loaded':1,'scene/revision':${version},'scene/contact-count':2,'position/terrain-elevation-asl-ft':30/.3048},scene_property_age_ms:{'scene/loaded':0,'scene/revision':0,'scene/contact-count':0,'position/terrain-elevation-asl-ft':0}};window.__emit('scene-frames',[window.__collisionPacket])`);
  await until(`document.body.innerText.includes('与本次导出一致') && document.body.innerText.includes('接触 2')`);
  const baseline=await evaluate(`(${rootState}).scene.getObjectByName('scene-object-'+${JSON.stringify(imported[0].id)}).parent.position.y`);
  await evaluate(`window.__collisionPacket.timestamp=2;window.__collisionPacket.properties['position/terrain-elevation-asl-ft']=999/.3048;window.__emit('scene-frames',[window.__collisionPacket])`);
  assert.equal(await evaluate(`(${rootState}).scene.getObjectByName('scene-object-'+${JSON.stringify(imported[0].id)}).parent.position.y`),baseline,'telemetry cannot move scenery');
  await setNumber('飞机包络半径',.7);
  await until(`document.body.innerText.includes('当前布局尚未核对')`);
  await evaluate(`window.__failSync=true`);await clickText('同步到 ball（读回校验）');
  await until(`document.querySelector('.scene-editor-error')?.textContent.includes('readback mismatch')`);
  assert(!await evaluate(`document.body.innerText.includes('已上传并读回校验')`),'failed readback is never reported as success');
  await until(`document.body.innerText.includes('状态未知 / 数据过期')`);
  // Disposal releases geometry and textures after the last owner is deleted.
  await evaluate(`(()=>{const s=${rootState},id=document.querySelector('[data-scene-object][aria-pressed=true]').dataset.sceneObject;window.__disposed={geometry:0,texture:0};s.scene.getObjectByName('scene-object-'+id).traverse(o=>{o.geometry?.addEventListener('dispose',()=>window.__disposed.geometry++);o.material?.map?.addEventListener('dispose',()=>window.__disposed.texture++)})})()`);
  await clickText('删除物体');
  await until(`window.__disposed.geometry>0 && window.__disposed.texture>0`);
  await clickText('完成');
  await until(`!document.querySelector('.scene-editor') && document.querySelector('.scene-inspector')`);
  assert.equal(await evaluate(`(${rootState}).scene.getObjectByName('scene-object-'+${JSON.stringify(imported[0].id)})!==undefined`), true, 'finishing editing retains imported scenery');
  assert.equal(exceptions.length, 0, exceptions.join('\n'));assert.equal(shaderErrors.length, 0, shaderErrors.join('\n'));
  console.log('Scene editor WebGL: default runway/hangar/individual-tree picking, transforms and instanced-tree matrices, neighbour isolation, visibility/deletion persistence; GLB/glTF, real gizmo dragging and orbit isolation, portable save/reload, atomic failures and resource disposal passed.');
} finally {
  ws?.close();chrome.kill();
  await Promise.all([rm(html,{force:true}),rm(module,{force:true}),rm(rootsModule,{force:true})]);
  if(chrome.exitCode===null)await new Promise(r=>chrome.once('exit',r));
  await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}
