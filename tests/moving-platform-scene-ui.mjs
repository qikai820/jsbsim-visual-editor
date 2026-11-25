// Real WebGL, isolated IPC. No simulator/controller connection.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
const base = process.argv[2] || 'http://127.0.0.1:5194';
const profile = await mkdtemp(path.join(tmpdir(), 'moving-platform-ui-'));
const name = `.moving-platform-ui-${process.pid}`;
const html = new URL(`../client/${name}.html`, import.meta.url), module = new URL(`../client/${name}.tsx`, import.meta.url);
const rootsModule = new URL(`../client/${name}-roots.ts`, import.meta.url);
await writeFile(rootsModule, `export{_roots}from'@react-three/fiber';export{GLTFExporter}from'three/examples/jsm/exporters/GLTFExporter.js';`);
await writeFile(html, `<div id="root"></div><script type="module" src="/${name}.tsx"></script>`);
await writeFile(module, `import React from 'react';import{createRoot}from'react-dom/client';import{_roots}from'@react-three/fiber';import FlightScene from './src/components/flight-scene/FlightScene';import './src/App.css';window.__roots=_roots;window.__target=null;function Harness(){const[visible,setVisible]=React.useState(true);window.__showScene=setVisible;return visible?<div style={{display:'flex',height:'100vh'}}><FlightScene slots={{'01':'XCD20'}} onClose={()=>{}} onMonitorTargetChange={target=>window.__target=target}/></div>:null}createRoot(document.getElementById('root')).render(<Harness/>);export{_roots};`);
// Warm optional exporter dependencies before a page is open, so Vite's first
// dependency optimization cannot reload the page between CDP assertions.
assert((await fetch(`${base}/${name}-roots.ts`)).ok);
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 15000); chrome.stderr.on('data', b => { out += b; const match = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } }); });
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(p => p.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(r => setTimeout(r, 100)); } throw Error('UI timeout: ' + expression + '\n' + await evaluate('document.body.innerText') + '\n' + errors.join('\n')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__vesselRequests=0;const originalFetch=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('scenery/moving-platform/vessel.glb'))window.__vesselRequests++;return originalFetch(...args)};` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/moving-platform-preview.html' });
  await until(`document.querySelector('canvas') && !document.body.innerText.includes('正在读取船模')`);
  await evaluate(`(async()=>{window.__roots=(await import('/${name}-roots.ts'))._roots})()`);
  await until(`window.__roots?.get(document.querySelector('canvas'))?.store.getState().scene`);
  const scene = `window.__roots.get(document.querySelector('canvas')).store.getState().scene`;
  await until(`${scene}.getObjectByName('downloaded-kenney-vessel')`);
  assert.equal(await evaluate(`window.__vesselRequests`), 1);
  await evaluate(`(async()=>{const{preloadMovingPlatformAsset:load}=await import('/src/components/flight-scene/useMovingPlatformAsset.ts');const[a,b]=await Promise.all([load(),load()]);if(a!==b)throw Error('Asset decode is not shared')})()`);
  assert.equal(await evaluate(`window.__vesselRequests`), 1, 'preload and preview share one decoded vessel');
  assert.equal(await evaluate(`${scene}.getObjectByName('moving-platform-model').userData.geometry.length`), 4);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='碰撞网格');b.click()})()`);
  await until(`${scene}.getObjectByName('moving-platform-collision-wire').visible`);
  await new Promise(r => setTimeout(r, 300));
  const wireImage=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/moving-platform-collision-preview.png',Buffer.from(wireImage.data,'base64'));
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='碰撞网格');b.click()})()`);
  await until(`!${scene}.getObjectByName('moving-platform-collision-wire').visible`);
  await new Promise(r => setTimeout(r, 600));
  const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/moving-platform-preview.png', Buffer.from(image.data, 'base64'));
  const exported = await evaluate(`(async()=>{const{GLTFExporter}=await import('/${name}-roots.ts');const bytes=new Uint8Array(await new GLTFExporter().parseAsync(${scene}.getObjectByName('moving-platform-model'),{binary:true}));const chunks=[];for(let i=0;i<bytes.length;i+=8192)chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(chunks.join(''))})()`);
  await writeFile('/tmp/moving-platform-complete.glb', Buffer.from(exported, 'base64'));
  await evaluate(`(()=>{const i=document.querySelector('input[aria-label="甲板长"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'6');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until(`${scene}.getObjectByName('moving-platform-model').userData.geometry.length===6`);
  await evaluate(`(()=>{const s=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'0');s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(`!${scene}.getObjectByName('guide-rod-left')`);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__events=new Map();const callbacks=new Map();let id=0;
    window.__emit=(event,payload)=>{for(const[n,callback]of window.__events.get(event)||[])callback({event,id:n,payload})};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
    window.__TAURI_INTERNALS__={transformCallback(callback){callbacks.set(++id,callback);return id},unregisterCallback(n){callbacks.delete(n)},invoke:async(command,args)=>{
      if(command==='plugin:event|listen'){const n=++id;if(!window.__events.has(args.event))window.__events.set(args.event,new Map());window.__events.get(args.event).set(n,callbacks.get(args.handler));return n}
      if(command==='plugin:event|unlisten'){window.__events.get(args.event)?.delete(args.eventId);return}
      if(command==='ftp_download_sim_config')return{content:JSON.stringify({initial:{latitudeDeg:34,longitudeDeg:109,altitudeM:500}})};
      if(command==='ftp_list_xml_parent')return{exists:true,files:['initGrnd.xml']};
      if(command==='ftp_download_xml')return{content:'<initialize><elevation unit="M">500</elevation></initialize>'};return [];
    }};` });
  await send('Page.navigate', { url: base + '/' + name + '.html' });
  await until(`window.__events?.get('scene-frames')?.size`);
  await until(`window.__roots?.get(document.querySelector('canvas'))?.store.getState().scene`);
  await until(`window.__target?.extraKeys.includes('moving-platform/enabled')`);
  // Core telemetry deliberately omits EVERY platform property. Only the keys
  // actively requested by the scene are returned, four channels per 100 ms.
  // The original code waited indefinitely here for the slow full-tree cycle.
  await evaluate(`(async()=>{const{PLATFORM_SIGNAL_KEYS:keys}=await import('/src/sim/sceneMovingPlatform.ts');const{publishSceneMonitor}=await import('/src/sim/sceneSignals.ts');const values=[1,0,0,0,0,0,0,2,4,3,.25,1.5,.36,0,.1];window.__packet={instance_id:'01',model:'XCD20',tree_generation:1,state:'running',timestamp:10,latitude_deg:34,longitude_deg:109,altitude_m:502.27,roll_deg:0,pitch_deg:0,yaw_deg:0,properties:Object.fromEntries(keys.map((key,i)=>['/'+key,values[i]])),scene_property_age_ms:Object.fromEntries(keys.map(key=>['/'+key,0]))};window.__packet.properties['/position/terrain-elevation-asl-ft']=500/.3048;window.__packet.scene_property_age_ms['/position/terrain-elevation-asl-ft']=0;window.__startupAt=performance.now();window.__emit('scene-frames',[{...window.__packet,properties:{'/position/terrain-elevation-asl-ft':500/.3048},scene_property_age_ms:{'/position/terrain-elevation-asl-ft':0}}]);let previous='',cursor=0,seq=0;window.__monitorTimer=setInterval(()=>{const requested=window.__target?.extraKeys||[],signature=requested.join();if(signature!==previous){previous=signature;cursor=0}if(!requested.length)return;const sampleTime=10+(++seq)*.1;window.__packet.timestamp=sampleTime;window.__emit('scene-frames',[{...window.__packet,properties:{'/position/terrain-elevation-asl-ft':500/.3048},scene_property_age_ms:{'/position/terrain-elevation-asl-ft':0}}]);const selected=Array.from({length:Math.min(4,requested.length)},()=>requested[(cursor++)%requested.length]);const samples=Object.fromEntries(selected.map(key=>[key,[values[keys.indexOf(key)],sampleTime,false]]));publishSceneMonitor({...window.__packet,timestamp:sampleTime,properties:{},monitor:{version:1,revision:1,sequence:seq,samples}})},100);})()`);
  await until(`${scene}.getObjectByName('scene-moving-platform-01')?.visible && ${scene}.getObjectByName('downloaded-kenney-vessel')`);
  const startupMs = await evaluate(`performance.now()-window.__startupAt`);
  assert(startupMs < 2500, `startup without a property-tree cycle took ${startupMs} ms`);
  await evaluate(`clearInterval(window.__monitorTimer)`);
  assert.equal(await evaluate(`window.__vesselRequests`), 1, 'flight-scene preloading and platform mount share one request');
  await until(`window.__target?.extraKeys.includes('moving-platform/angles-rad[2]')`);
  const initial = await evaluate(`${scene}.getObjectByName('scene-moving-platform-01').position.toArray()`);
  assert(Math.abs(initial[1] - 2.27) < 1e-6);
  await evaluate(`(()=>{window.__packet={...window.__packet,timestamp:window.__packet.timestamp+.05,properties:{...window.__packet.properties,'/moving-platform/relative-position-m[1]':2,'/moving-platform/angles-rad[2]':Math.PI/2}};window.__emit('scene-frames',[window.__packet]);window.__steadyTimer=setInterval(()=>{window.__packet={...window.__packet,timestamp:window.__packet.timestamp+.05};window.__emit('scene-frames',[window.__packet])},50)})()`);
  await until(`Math.abs(${scene}.getObjectByName('scene-moving-platform-01').position.z+2)<.001`);
  await evaluate(`clearInterval(window.__steadyTimer)`);
  assert(await evaluate(`Math.abs(${scene}.getObjectByName('scene-moving-platform-01').userData.displayTime-${scene}.getObjectByName('scene-aircraft-01').userData.displayTime)<1e-9`), 'real rendered aircraft/vessel must use the same display time');
  await new Promise(r => setTimeout(r, 2200));
  const frozen = await evaluate(`${scene}.getObjectByName('scene-moving-platform-01').position.toArray()`);
  await evaluate(`window.__emit('scene-frames',[{...window.__packet,timestamp:window.__packet.timestamp+1,altitude_m:510,properties:{},scene_property_age_ms:{}}])`);
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(await evaluate(`${scene}.getObjectByName('scene-moving-platform-01').position.toArray()`), frozen, 'stale platform does not follow fresh aircraft');
  await evaluate(`window.__emit('scene-frames',[{...window.__packet,timestamp:window.__packet.timestamp+2,properties:{'/moving-platform/enabled':0},scene_property_age_ms:{'/moving-platform/enabled':0}}])`);
  await until(`!${scene}.getObjectByName('scene-moving-platform-01')`);
  await evaluate(`window.__showScene(false)`); await until(`!document.querySelector('canvas')`);
  await evaluate(`window.__showScene(true)`); await until(`window.__events?.get('scene-frames')?.size && window.__roots?.get(document.querySelector('canvas'))`);
  await evaluate(`window.__emit('scene-frames',[{...window.__packet,timestamp:window.__packet.timestamp+3}])`);
  await until(`${scene}.getObjectByName('downloaded-kenney-vessel')`);
  assert.equal(await evaluate(`window.__vesselRequests`), 1, 'reentering the scene reuses the decoded vessel');
  await evaluate(`window.__emit('scene-frames',[{...window.__packet,tree_generation:2,timestamp:window.__packet.timestamp+4,properties:{},scene_property_age_ms:{}}])`);
  await until(`window.__target?.extraKeys.includes('moving-platform/enabled')`);
  await evaluate(`(async()=>{const{publishSceneMonitor}=await import('/src/sim/sceneSignals.ts');publishSceneMonitor({...window.__packet,tree_generation:2,timestamp:window.__packet.timestamp+4,monitor:{version:1,revision:2,sequence:1,samples:{'moving-platform/enabled':[null,null,false]}}})})()`);
  await until(`!window.__target?.extraKeys.includes('moving-platform/enabled')`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:true,startupWithoutTreeMs:Math.round(startupMs),vesselRequests:await evaluate('window.__vesselRequests'),checks:'parameter editing, VMON discovery, cached decode, scene reentry, missing module, rotation, stale freeze, disable',preview:'/tmp/moving-platform-preview.png'}));
} finally {
  socket?.close(); const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
  await Promise.all([rm(html, { force: true }), rm(module, { force: true }), rm(rootsModule, { force: true }), rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })]);
}
