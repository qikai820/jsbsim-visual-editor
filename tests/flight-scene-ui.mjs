// Real WebGL rendering and Tauri event contract with isolated IPC; no board I/O.
// Run with Node 20 --experimental-websocket against a running Vite server.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const base = process.argv[2] || 'http://127.0.0.1:5185';
const name = `.flight-scene-test-${process.pid}`;
const html = new URL(`../client/${name}.html`, import.meta.url);
const module = new URL(`../client/${name}.tsx`, import.meta.url);
const rootsModule = new URL(`../client/${name}-roots.ts`, import.meta.url);
const profile = await mkdtemp(path.join(tmpdir(), 'flight-scene-chrome-'));
await writeFile(html, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
await writeFile(rootsModule, `export {_roots as roots} from '@react-three/fiber';`);
await writeFile(module, `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{_roots}from'@react-three/fiber';import FlightScene from './src/components/flight-scene/FlightScene';import{useSignalMonitor}from'./src/sim/useSignalMonitor';import{sceneSignalKeys}from'./src/sim/sceneSignals';import './src/App.css';window.__sceneRoots=_roots;function Harness(){const[target,setTarget]=useState(null);useSignalMonitor(target?.instance||'01',target?sceneSignalKeys(target.model):[]);return <div style={{display:'flex',height:'100vh'}}><FlightScene onClose={()=>{window.__closed=true}} slots={{'01':'voliro_t','02':'F450'}} onMonitorTargetChange={setTarget}/></div>}createRoot(document.getElementById('root')).render(<Harness/>);`);
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
  const connectRoots = () => evaluate(`import('/${name}-roots.ts').then(module=>{window.__sceneRoots=module.roots;return true})`);
  const assetStates = `(()=>{const root=window.__sceneRoots?.get(document.querySelector('canvas'));if(!root)return [];const maps=new Map();root.store.getState().scene.traverse(o=>{const map=o.material?.map||o.material?.uniforms?.map?.value;if(map?.userData.polyHaven)maps.set(map.uuid,map.userData.polyHaven)});return [...maps.values()]})()`;
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  // Every photograph must come from the app bundle, even with its publisher's
  // API and CDN unavailable at runtime.
  await send('Network.setBlockedURLs', { urls: ['https://*.polyhaven.com/*', 'https://*.polyhaven.org/*'] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('jsbsim-language','zh-CN');
    if(location.pathname.includes('.flight-scene-test-')) {
      const interval=window.setInterval.bind(window);window.__holdInspector=false;
      window.setInterval=(callback,delay,...args)=>interval(()=>{if(delay!==200||!window.__holdInspector)callback(...args)},delay);
      const callbacks=new Map(),events=new Map();let id=0;window.__calls=[];window.__events=events;window.__sampleQueue=[];
      window.__emit=(event,payload)=>{for(const [eventId,callback]of events.get(event)||[])callback({event,id:eventId,payload})};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
      window.__TAURI_INTERNALS__={transformCallback(callback){const next=++id;callbacks.set(next,callback);return next},unregisterCallback(next){callbacks.delete(next)},invoke:async(command,args)=>{
        if(command==='plugin:event|listen'){const eventId=++id;if(!events.has(args.event))events.set(args.event,new Map());events.get(args.event).set(eventId,callbacks.get(args.handler));return eventId}
        if(command==='plugin:event|unlisten'){events.get(args.event)?.delete(args.eventId);return}
        if(command==='sim_monitor_snapshot')return window.__sampleQueue.splice(0);
        window.__calls.push({command,args});return{sent:true};
      }};
    }
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/${name}.html` });
  await until(`document.querySelector('.scene-empty') && window.__events.get('scene-frames')?.size===1`);
  await until(`(${assetStates}).length===5 && (${assetStates}).every(asset=>asset.state==='ready')`);
  assert.deepEqual(await evaluate(`(${assetStates}).map(asset=>asset.asset).sort()`), ['asphalt_02','concrete_floor_01','concrete_floor_01','grass_ground','kloppenheim_03_puresky'], 'all photographic surfaces are loaded from the bundle');
  assert.equal(await evaluate(`document.querySelector('[data-testid=flight-scene]').dataset.mode`), 'live');
  await until(`window.__calls.some(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.includes('fcs/voliro_t/pitch-rad')&&c.args.keys.length===26)`);
  await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');window.__packets=demoPackets(12);window.__emit('scene-frames',window.__packets)})()`);
  await until(`document.querySelectorAll('[data-aircraft]').length===8 && !document.querySelector('.scene-empty')`);
  await until(`document.querySelector('.scene-status').textContent.includes('8 / 8 在线')`);
  assert.equal(await evaluate(`document.querySelector('.scene-inspector header strong').textContent`), '01 · voliro_t');
  // The desktop publishes ordinary telemetry before its detailed scene batch.
  // Allow React's inspector refresh to run between them to expose blanking.
  for (const time of [12.2, 12.4]) {
    await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');const frame=demoPackets(${time})[0];delete frame.properties;delete frame.scene_property_age_ms;delete frame.groundspeed_mps;window.__emit('telemetry',frame)})()`);
    await new Promise(r => setTimeout(r, 300));
    assert.notEqual(await evaluate(`document.querySelector('.scene-tilt b').textContent`), '—', 'interleaved ordinary event cannot blank tilt');
    assert.ok(await evaluate(`[...document.querySelectorAll('.scene-motor b')].every(el=>el.textContent!=='—')`), 'motor values remain present between the two event channels');
    assert.ok(await evaluate(`!document.querySelector('.scene-metrics>div:first-child strong').textContent.includes('—')`), 'AGL remains present');
    assert.ok(await evaluate(`!document.querySelector('.scene-metrics>div:nth-child(2) strong').textContent.includes('—')`), 'groundspeed remains present');
    await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');window.__emit('scene-frames',demoPackets(${time + .04}))})()`);
  }
  await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');window.__packets=demoPackets(13);window.__nativeAt=performance.now();window.__emit('scene-frames',window.__packets)})()`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas'))?.store.getState().scene.getObjectByName('scene-tilt-01-0')`);
  // Servo geometry must update from actual samples even while the 200 ms
  // inspector timer is held. Repeating prevents the 1 Hz FPS render masking lag.
  await evaluate('window.__holdInspector=true');
  let sampleSequence=0;
  for (const angle of [.45, -.55, .9]) {
    sampleSequence++;
    await evaluate(`(()=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:${13 + sampleSequence * .01},monitor:{version:1,revision,sequence:${sampleSequence},samples:{'fcs/voliro_t/pitch-rad':[${angle},${13 + sampleSequence * .01},false]}}})})()`);
    let followed = false;
    for (let i = 0; i < 25; i++) {
      followed = await evaluate(`Math.abs(window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-tilt-01-0').rotation.x+${angle})<.0001`);
      if (followed) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(followed, 'servo geometry follows sampled angle without waiting for inspector refresh');
  }
  await evaluate('window.__holdInspector=false');
  await until(`document.querySelector('.scene-mechanism-status').textContent.includes('高速采样')`);
  // Actual RPM is sampled independently of the inspector render timer.
  await until(`window.__sceneRoots.get(document.querySelector('canvas'))?.store.getState().scene.getObjectByName('scene-rotor-01-0')`);
  await evaluate(`window.__rotorSequence=4;window.__pushRotor=(samples,t)=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:t,monitor:{version:1,revision,sequence:window.__rotorSequence++,samples:Object.fromEntries(Object.entries(samples).map(([i,rpm])=>[Number.isInteger(Number(i))?'fcs/voliro_t/rpm['+i+']':i,[rpm,t,false]]))}})};window.__pushRotor({0:2400,4:-1200,'fcs/voliro_t/rpm-model/version':1,'fcs/voliro_t/rpm-model/tail-calibrated':0},13.04)`);
  await until(`document.querySelector('.scene-rpm-row[data-rotor="0"]').textContent.includes('2400')`);
  assert.ok(await evaluate(`document.querySelector('.scene-rpm-row[data-rotor="4"]').textContent.includes('未标定')`),'uncalibrated tail model state is identified');
  assert.ok(await evaluate(`(()=>{const d=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').userData;return d.rpm===2400 && Math.abs(d.visualAngularVelocity)<Math.abs(d.angularVelocity)})()`),'the display keeps actual RPM while compressing visual phase');
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').parent.parent.position.x`),.45,'M1 is the right upper rotor');
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-1').parent.position.y`),-.055,'M2 is the right lower rotor');
  assert.ok(await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene;return s.getObjectByName('scene-rotor-01-0').userData.angularVelocity>0 && s.getObjectByName('scene-rotor-01-1').userData.angularVelocity<0 && s.getObjectByName('scene-rotor-01-4').userData.angularVelocity<0})()`),'coaxial pair and reversible tail follow the sampled directions');
  await evaluate(`window.__holdInspector=true;window.__pushRotor({0:0},13.05)`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').userData.angularVelocity===0`);
  const stoppedAngle=await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').rotation.y`);
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').rotation.y`),stoppedAngle,'zero measured RPM stops geometry even with nonzero ESC and the inspector timer held');
  await evaluate('window.__holdInspector=false');
  await evaluate(`document.querySelector('[data-aircraft="02"]').click()`);
  await until(`document.querySelector('.scene-inspector header strong').textContent==='02 · F450'`);
  await evaluate(`document.querySelector('.scene-toolbar .scene-action').click()`);
  await until(`window.__calls.some(c=>c.command==='sim_instance_control')`);
  assert.deepEqual(await evaluate(`window.__calls.find(c=>c.command==='sim_instance_control').args`), { instanceId: '02', action: 'pause' });
  await evaluate(`document.querySelector('[data-aircraft="01"]').click()`);
  await until(`document.querySelector('.scene-inspector header strong').textContent==='01 · voliro_t'`);
  // Re-sending cached frames must not hide disconnection.
  await evaluate(`window.__cached=setInterval(()=>window.__emit('scene-frames',window.__packets.map(p=>({...p,age_ms:5000}))),100)`);
  await until(`document.querySelector('.scene-stale')`);
  await until(`document.querySelector('.scene-tilt .scene-value-stale')`);
  assert.notEqual(await evaluate(`document.querySelector('.scene-tilt b').textContent`), '—', 'expired sampling is marked, not repeatedly blanked');
  await evaluate('clearInterval(window.__cached)');
  // Reproduce the live symptom: the native pose is stale while monitor packets
  // still arrive. Only six new measured pose channels may restore the aircraft.
  const beforePose = await evaluate(`(()=>{const o=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-aircraft-01');return {p:o.position.toArray(),q:o.quaternion.toArray()}})()`);
  await evaluate(`window.__holdInspector=true;window.__poseKeys=['position/lat-geod-deg','position/long-gc-deg','position/h-sl-meters','attitude/phi-rad','attitude/theta-rad','attitude/psi-rad'];window.__poseValues=[34.0722,108.998,610,Math.PI/6,-Math.PI/9,Math.PI/2];window.__pushPose=(start,end,sequence,t)=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:t,monitor:{version:1,revision,sequence,samples:Object.fromEntries(window.__poseKeys.slice(start,end).map((key,i)=>[key,[window.__poseValues[start+i],t,false]]))}})};window.__pushPose(0,4,6,14)`);
  await new Promise(r=>setTimeout(r,80));
  assert.deepEqual(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-aircraft-01').position.toArray()`),beforePose.p,'an incomplete pose cycle cannot move the aircraft');
  await evaluate(`window.__pushPose(4,6,7,14.02)`);
  await until(`(()=>{const o=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-aircraft-01');return o.position.distanceTo({x:${beforePose.p[0]},y:${beforePose.p[1]},z:${beforePose.p[2]}})>10 && o.quaternion.toArray().some((v,i)=>Math.abs(v-${JSON.stringify(beforePose.q)}[i])>.01)})()`);
  await evaluate('window.__holdInspector=false');
  await until(`document.querySelector('.scene-pose-status').textContent.includes('位姿高速采样') && !document.querySelector('.scene-stale')`);
  assert.ok(await evaluate(`document.querySelector('.scene-attitude dl').textContent.includes('30.0°')`),'measured radians reach the attitude inspector as degrees');
  assert.ok(await evaluate(`document.querySelector('.scene-position').textContent.includes('34.0722000°')`),'measured geodetic latitude reaches the position inspector');
  await evaluate(`window.__servoSequence=8;window.__servoOnly=setInterval(()=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:15,monitor:{version:1,revision,sequence:window.__servoSequence++,samples:{'fcs/voliro_t/pitch-rad':[.5,15,false]}}})},100)`);
  await until(`document.querySelector('.scene-stale')`);
  assert.ok(await evaluate(`document.querySelector('.scene-mechanism-status').textContent.includes('机构高速采样')`),'fresh servo traffic does not conceal loss of measured body pose');
  await evaluate('clearInterval(window.__servoOnly)');
  // Reboot with the same tree generation: low counters first trigger a new
  // VMON nonce, and only its acknowledgement may restart measured pose time.
  await new Promise(r=>setTimeout(r,2100));
  const oldRevision=await evaluate(`window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision`);
  await evaluate(`window.__pushPose(0,4,1,.1)`);
  await until(`window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision!==${oldRevision}`);
  assert.ok(await evaluate(`!!document.querySelector('.scene-stale')`),'renewing the subscription alone cannot freshen pose');
  await evaluate(`window.__poseValues=[34.073,109.002,620,Math.PI/3,0,Math.PI];window.__pushPose(0,4,2,.2)`);
  await new Promise(r=>setTimeout(r,60));
  await evaluate(`window.__pushPose(4,6,3,.22)`);
  await until(`!document.querySelector('.scene-stale') && document.querySelector('.scene-attitude dl').textContent.includes('60.0°')`);
  assert.ok(await evaluate(`document.querySelector('.scene-position').textContent.includes('34.0730000°')`),'same-generation reboot recovers measured position');
  await evaluate(`window.__oldNative=setInterval(()=>window.__emit('scene-frames',window.__packets.map(p=>({...p,age_ms:performance.now()-window.__nativeAt}))),50)`);
  await new Promise(r=>setTimeout(r,400));
  assert.ok(await evaluate(`!document.querySelector('.scene-stale') && document.querySelector('.scene-attitude dl').textContent.includes('60.0°')`),'old native cache cannot undo recovered post-reboot measurements');
  await evaluate(`clearInterval(window.__oldNative)`);
  await clickText('演示场景');
  await until(`document.querySelector('[data-testid=flight-scene]').dataset.mode==='demo' && document.querySelectorAll('[data-aircraft]').length===8`);
  assert.equal(await evaluate(`window.__events.get('scene-frames').size`), 0, 'native subscription is released in demo mode');
  for (const label of ['自由', '地面', '机载', '编队', '跟随']) {
    await evaluate(`document.querySelector('.scene-camera-tabs button:nth-child(${['自由','跟随','地面','机载','编队'].indexOf(label)+1})').click()`);
    await until(`document.querySelector('.scene-camera-tabs button.active').textContent===${JSON.stringify(label)}`);
  }
  const callsBefore = await evaluate(`window.__calls.filter(c=>c.command==='sim_instance_control').length`);
  await evaluate(`document.querySelector('.scene-toolbar .scene-action').click()`);
  await new Promise(r => setTimeout(r, 2300));
  assert.equal(await evaluate(`!!document.querySelector('.scene-stale')`), false, 'paused demo remains connected');
  // Exercise a wide field view: scenery should stay inexpensive with all eight
  // aircraft present, and toggling layers must reuse its GPU resources.
  await evaluate(`document.querySelector('.scene-camera-tabs button').click()`);
  await new Promise(r => setTimeout(r, 100));
  await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState();s.camera.position.set(120,52,110);s.controls.target.set(10,-9,-95);s.controls.update()})()`);
  await new Promise(r => setTimeout(r, 400));
  const rendering = await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState();return {calls:s.gl.info.render.calls,triangles:s.gl.info.render.triangles,textures:s.gl.info.memory.textures,geometries:s.gl.info.memory.geometries,shadows:s.gl.shadowMap.enabled}})()`);
  assert.ok(rendering.calls <= 240, `eight-aircraft draw budget: ${JSON.stringify(rendering)}`);
  assert.ok(rendering.triangles < 10000, `eight-aircraft triangle budget: ${JSON.stringify(rendering)}`);
  assert.equal(rendering.textures, 6, 'small shared surface and sky maps only');
  assert.equal(rendering.shadows, false, 'scenery never enables a shadow-map render pass');
  const surfaceIds = await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState(),ids=new Set();s.scene.traverse(o=>{if(o.material?.map)ids.add(o.material.map.uuid);if(o.material?.uniforms?.map)ids.add(o.material.uniforms.map.value.uuid)});return [...ids].sort()})()`);
  await screenshot('/tmp/jsbsim-flight-scene-scenery.png');
  await screenshot('/tmp/jsbsim-flight-scene-polyhaven.png');
  const viewportClip = await evaluate(`(()=>{const r=document.querySelector('.scene-viewport').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
  const gridOn = (await send('Page.captureScreenshot', { format: 'png', clip: viewportClip })).data;
  await evaluate(`document.querySelector('.scene-layer-list input').click()`);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState(),ids=new Set();s.scene.traverse(o=>{if(o.material?.map)ids.add(o.material.map.uuid);if(o.material?.uniforms?.map)ids.add(o.material.uniforms.map.value.uuid)});return [...ids].sort()})()`), surfaceIds, 'layer changes and inspector refresh reuse the same surface maps');
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().gl.info.memory.textures`), 6, 'layer changes do not allocate textures');
  await new Promise(r => setTimeout(r, 250));
  const gridOff = (await send('Page.captureScreenshot', { format: 'png', clip: viewportClip })).data;
  assert.ok(gridOn !== gridOff, 'grid switch changes the rendered viewport pixels');
  assert.equal(await evaluate(`document.querySelector('.scene-layer-list input').checked`), false);
  await evaluate(`document.querySelector('.scene-layer-list input').click()`);
  await evaluate(`document.querySelector('.scene-toolbar .scene-action').click()`);
  await new Promise(r => setTimeout(r, 300));
  const runningRendering = await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState();return {calls:s.gl.info.render.calls,triangles:s.gl.info.render.triangles}})()`);
  assert.ok(runningRendering.calls <= 240 && runningRendering.triangles < 10000, `running eight-aircraft budget: ${JSON.stringify(runningRendering)}`);
  await evaluate(`document.querySelector('.scene-camera-tabs button:nth-child(2)').click()`);
  assert.equal(await evaluate(`window.__calls.filter(c=>c.command==='sim_instance_control').length`), callsBefore, 'demo pause/resume never sends flight-control commands');
  await screenshot('/tmp/jsbsim-flight-scene-1600.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await screenshot('/tmp/jsbsim-flight-scene-1024.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true);
  await clickText('退出演示');
  await until(`document.querySelector('.scene-empty') && window.__events.get('scene-frames')?.size===1`);
  // The approved Voliro fallback uses the actual ESC output and the bench
  // curve, with no fabricated tail RPM value.
  await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');window.__bench=demoPackets(20)[0];for(const k of Object.keys(window.__bench.properties))if(k.includes('/rpm['))delete window.__bench.properties[k];for(let i=0;i<5;i++)window.__bench.properties['/fcs/esc-out['+i+']']=i===4?-.5:.33;window.__emit('scene-frames',[window.__bench])})()`);
  await until(`document.querySelector('.scene-rpm-row[data-rotor="0"]').dataset.source==='bench' && document.querySelector('.scene-rpm-row[data-rotor="0"]').textContent.includes('2465')`);
  assert.equal(await evaluate(`document.querySelector('.scene-rpm-row[data-rotor="4"]').dataset.source`),'visual');
  assert.ok(await evaluate(`document.querySelector('.scene-rpm-row[data-rotor="4"]>div').textContent==='随输出'`),'tail indication does not display an invented RPM');
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-4').userData.angularVelocity<0`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-ground-shade-01').visible`);
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="参考地面海拔"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'650');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until(`!window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-ground-shade-01').visible`);
  await evaluate(`(()=>{const input=document.querySelector('input[aria-label="参考地面海拔"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-ground-shade-01').visible`);
  const rotatingAngle=await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').rotation.y`);
  await new Promise(r=>setTimeout(r,90));
  assert.notEqual(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').rotation.y`),rotatingAngle,'bench RPM animates the actual blade mesh');
  await evaluate(`document.querySelector('.scene-rpm').scrollIntoView({block:'center'})`);
  await screenshot('/tmp/jsbsim-flight-scene-rpm.png');
  await evaluate(`window.__bench={...window.__bench,timestamp:20.04,capture_monotonic_us:20.04e6,state:'paused'};window.__emit('scene-frames',[window.__bench])`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-0').userData.angularVelocity===0`);

  // MorphQuad uses four independent two-axis gimbals and eight three-blade rotors.
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(async()=>{const{demoPackets}=await import('/src/sim/flightSceneState.ts');window.__morph={...demoPackets(30)[7],instance_id:'01',roll_deg:0,pitch_deg:0,yaw_deg:0};window.__emit('scene-frames',[window.__morph])})()`);
  await until(`document.querySelector('.scene-inspector header strong').textContent==='01 · MorphQuad' && document.querySelectorAll('.scene-gimbal-row').length===4 && document.querySelectorAll('.scene-rpm-row').length===8`);
  await until(`window.__calls.some(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length===32&&c.args.keys.includes('fcs/gimbal-inner-rad[3]')&&c.args.keys.includes('propulsion/engine[7]/propeller-rpm'))`);
  const morphGeometry = await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene;return Array.from({length:4},(_,i)=>{const p=s.getObjectByName('scene-gimbal-outer-01-'+i).parent;return [p.position.x,p.position.y,p.position.z]})})()`);
  assert.deepEqual(morphGeometry, [[.225,.04,-.225],[-.225,.04,-.225],[-.225,.04,.225],[.225,.04,.225]]);
  await until(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene;return Array.from({length:4},(_,i)=>s.getObjectByName('scene-rotor-01-'+(i*2))?.userData.angularVelocity*s.getObjectByName('scene-rotor-01-'+(i*2+1))?.userData.angularVelocity<0).every(Boolean)})()`);
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-7').children[0].count`),3,'MorphQuad uses three blades per propeller');
  await evaluate(`window.__holdInspector=true;window.__morphSequence=1;window.__pushGimbal=(a,b)=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'MorphQuad',tree_generation:'demo',state:'running',timestamp:30.1+window.__morphSequence*.01,monitor:{version:1,revision,sequence:window.__morphSequence++,samples:{'fcs/gimbal-outer-rad[0]':[a,30.1,false],'fcs/gimbal-inner-rad[0]':[b,30.1,false]}}})}`);
  for (const [a,b] of [[0,0],[.5,.35],[Math.PI,0],[-.8,-.4]]) {
    await evaluate(`window.__pushGimbal(${a},${b})`);
    await until(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene;return Math.abs(s.getObjectByName('scene-gimbal-outer-01-0').rotation.x+${a})<1e-6&&Math.abs(s.getObjectByName('scene-gimbal-inner-01-0').rotation.z+${b})<1e-6})()`);
    const direction = await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState(),outer=s.scene.getObjectByName('scene-gimbal-outer-01-0'),inner=s.scene.getObjectByName('scene-gimbal-inner-01-0');return s.camera.position.clone().set(0,1,0).applyQuaternion(inner.quaternion).applyQuaternion(outer.quaternion).toArray()})()`);
    const expected = [Math.sin(b), Math.cos(a)*Math.cos(b), -Math.sin(a)*Math.cos(b)];
    assert.ok(direction.every((value,i)=>Math.abs(value-expected[i])<1e-6),'gimbal hierarchy matches XML thrust direction, including inversion');
  }
  await evaluate('window.__holdInspector=false');
  await until(`document.querySelector('.scene-gimbal-row b').textContent.includes('-45.8')`);
  await evaluate(`window.__morph={...window.__morph,timestamp:30.3,capture_monotonic_us:30.3e6,state:'paused'};window.__emit('scene-frames',[window.__morph])`);
  await until(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-rotor-01-7').userData.angularVelocity===0`);
  await clickText('以所选飞机重设场景原点');
  await new Promise(r=>setTimeout(r,150));
  await evaluate(`(()=>{const s=window.__sceneRoots.get(document.querySelector('canvas')).store.getState(),p=s.scene.getObjectByName('scene-aircraft-01').position;s.camera.position.copy(p).add(s.camera.position.clone().set(.85,.65,1));s.controls.target.copy(p);s.controls.update();document.querySelector('.scene-inspector').scrollTop=280})()`);
  await new Promise(r=>setTimeout(r,250));
  await screenshot('/tmp/jsbsim-flight-scene-morphquad.png');
  const frozenGimbal = await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-gimbal-outer-01-0').rotation.x`);
  await until(`document.querySelector('.scene-gimbal-row b.scene-value-stale')`);
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-gimbal-outer-01-0').rotation.x`),frozenGimbal,'expired gimbal stays at the last measured angle');

  // Exercise the production App entry and lazy workspace navigation as well.
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?workspace=scene` });
  await connectRoots();
  await until(`document.querySelector('[data-testid=flight-scene]')`);
  await clickText('演示场景');
  await until(`document.querySelectorAll('[data-aircraft]').length===8`);
  await new Promise(r => setTimeout(r, 1500));
  await screenshot('/tmp/jsbsim-flight-scene-app.png');
  await evaluate(`document.querySelector('.scene-breadcrumb>button').click()`);
  await until(`!document.querySelector('[data-testid=flight-scene]')`);
  await evaluate(`document.querySelector('.workspace-menu-trigger').click()`);
  await clickText('◈ 飞行视景');
  await until(`document.querySelector('[data-testid=flight-scene]')`);
  await until(`(${assetStates}).length===5 && (${assetStates}).every(asset=>asset.state==='ready')`);
  // A missing bundle file must leave a usable fallback, and a fresh viewport
  // must recover after the file becomes available again.
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: [`${base}/scenery/polyhaven/*.jpg`] });
  await send('Page.navigate', { url: `${base}/?workspace=scene` });
  await connectRoots();
  await until(`(${assetStates}).length===5 && (${assetStates}).every(asset=>asset.state==='fallback')`);
  assert.equal(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().gl.info.memory.textures`), 6, 'missing images preserve the fallback scene');
  await send('Network.setBlockedURLs', { urls: ['https://*.polyhaven.com/*', 'https://*.polyhaven.org/*'] });
  await send('Page.navigate', { url: `${base}/?workspace=scene` });
  await connectRoots();
  await until(`(${assetStates}).length===5 && (${assetStates}).every(asset=>asset.state==='ready')`);
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  assert.equal(shaderErrors.length, 0, shaderErrors.join('\n'));
  console.log('Flight scene scenery render budget:', { paused: rendering, running: runningRendering });
  console.log('Flight scene WebGL UI: offline Poly Haven images, missing-image fallback and recovery, scenery draw/triangle budget, shared texture reuse, reference-ground shade, no shadow-map pass or shader errors; per-rotor RPM, geometry motion, measured zero, mapped coaxial directions, bench/tail indication, pause; same-generation reboot and new subscription acknowledgement, stale-cache rejection, measured pose recovery and motion, incomplete-cycle rejection, servo-only expiry, actual-property subscription, frame-driven servo, last-sample age, interleaved events, per-aircraft pause, stale freeze, demo, cameras, layers and App navigation passed.');
} finally {
  ws?.close(); chrome.kill();
  await Promise.all([rm(html, { force: true }), rm(module, { force: true }), rm(rootsModule, { force: true })]);
  await new Promise(r => chrome.once('exit', r));
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
