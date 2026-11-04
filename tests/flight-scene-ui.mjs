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
const profile = await mkdtemp(path.join(tmpdir(), 'flight-scene-chrome-'));
await writeFile(html, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
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
  let sequence = 0; const pending = new Map(), exceptions = [];
  ws.addEventListener('message', event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '')); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate('Boolean(' + expression + ')')) return; await new Promise(r => setTimeout(r, 100)); } throw Error(`Timeout ${expression}\n${await evaluate('document.body.innerText')}\n${exceptions.join('\n')}`); };
  const clickText = text => evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('No button '+${JSON.stringify(text)});button.click()})()`);
  const screenshot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(file, Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
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
  assert.equal(await evaluate(`document.querySelector('[data-testid=flight-scene]').dataset.mode`), 'live');
  await until(`window.__calls.some(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.includes('fcs/voliro_t/pitch-rad')&&c.args.keys.length===19)`);
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
  await evaluate(`window.__holdInspector=true;window.__poseKeys=['position/lat-geod-deg','position/long-gc-deg','position/h-sl-meters','attitude/phi-rad','attitude/theta-rad','attitude/psi-rad'];window.__poseValues=[34.0722,108.998,610,Math.PI/6,-Math.PI/9,Math.PI/2];window.__pushPose=(start,end,sequence,t)=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:t,monitor:{version:1,revision,sequence,samples:Object.fromEntries(window.__poseKeys.slice(start,end).map((key,i)=>[key,[window.__poseValues[start+i],t,false]]))}})};window.__pushPose(0,4,4,14)`);
  await new Promise(r=>setTimeout(r,80));
  assert.deepEqual(await evaluate(`window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-aircraft-01').position.toArray()`),beforePose.p,'an incomplete pose cycle cannot move the aircraft');
  await evaluate(`window.__pushPose(4,6,5,14.02)`);
  await until(`(()=>{const o=window.__sceneRoots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('scene-aircraft-01');return o.position.distanceTo({x:${beforePose.p[0]},y:${beforePose.p[1]},z:${beforePose.p[2]}})>10 && o.quaternion.toArray().some((v,i)=>Math.abs(v-${JSON.stringify(beforePose.q)}[i])>.01)})()`);
  await evaluate('window.__holdInspector=false');
  await until(`document.querySelector('.scene-pose-status').textContent.includes('位姿高速采样') && !document.querySelector('.scene-stale')`);
  assert.ok(await evaluate(`document.querySelector('.scene-attitude dl').textContent.includes('30.0°')`),'measured radians reach the attitude inspector as degrees');
  assert.ok(await evaluate(`document.querySelector('.scene-position').textContent.includes('34.0722000°')`),'measured geodetic latitude reaches the position inspector');
  await evaluate(`window.__servoSequence=6;window.__servoOnly=setInterval(()=>{const revision=window.__calls.filter(c=>c.command==='sim_monitor_subscribe'&&c.args.instanceId===1&&c.args.keys.length).at(-1).args.revision;window.__sampleQueue.push({instance_id:'01',model:'voliro_t',tree_generation:'demo',state:'running',timestamp:15,monitor:{version:1,revision,sequence:window.__servoSequence++,samples:{'fcs/voliro_t/pitch-rad':[.5,15,false]}}})},100)`);
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
  const viewportClip = await evaluate(`(()=>{const r=document.querySelector('.scene-viewport').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
  const gridOn = (await send('Page.captureScreenshot', { format: 'png', clip: viewportClip })).data;
  await evaluate(`document.querySelector('.scene-layer-list input').click()`);
  await new Promise(r => setTimeout(r, 250));
  const gridOff = (await send('Page.captureScreenshot', { format: 'png', clip: viewportClip })).data;
  assert.ok(gridOn !== gridOff, 'grid switch changes the rendered viewport pixels');
  assert.equal(await evaluate(`document.querySelector('.scene-layer-list input').checked`), false);
  await evaluate(`document.querySelector('.scene-layer-list input').click()`);
  await evaluate(`document.querySelector('.scene-toolbar .scene-action').click()`);
  assert.equal(await evaluate(`window.__calls.filter(c=>c.command==='sim_instance_control').length`), callsBefore, 'demo pause/resume never sends flight-control commands');
  await screenshot('/tmp/jsbsim-flight-scene-1600.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await screenshot('/tmp/jsbsim-flight-scene-1024.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true);
  await clickText('退出演示');
  await until(`document.querySelector('.scene-empty') && window.__events.get('scene-frames')?.size===1`);
  // Exercise the production App entry and lazy workspace navigation as well.
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?workspace=scene` });
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
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  console.log('Flight scene WebGL UI: same-generation reboot and new subscription acknowledgement, stale-cache rejection, measured pose recovery and motion, incomplete-cycle rejection, servo-only expiry, actual-property subscription, frame-driven servo, last-sample age, interleaved events, per-aircraft pause, stale freeze, demo, cameras, layers and App navigation passed.');
} finally {
  ws?.close(); chrome.kill();
  await Promise.all([rm(html, { force: true }), rm(module, { force: true })]);
  await new Promise(r => chrome.once('exit', r));
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
