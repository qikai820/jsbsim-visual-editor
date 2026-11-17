// Offline exported-asset WebGL check. Pass the URL of export-voliro-visual's preview.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const url = process.argv[2] || 'http://127.0.0.1:8788/preview.html';
const output = process.argv[3] || '/tmp';
const profile = await mkdtemp(path.join(tmpdir(), 'voliro-render-'));
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore','ignore','pipe']});
let ws;
try {
  const endpoint=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Chrome timeout')),15000);chrome.stderr.on('data',chunk=>{out+=chunk;const m=out.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1])}})});
  const page=(await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json())).find(p=>p.type==='page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let sequence=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args)});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url});
  for(let i=0;i<100;i++){if(await evaluate('!!window.__voliro'))break;await new Promise(r=>setTimeout(r,100))}
  assert.equal(await evaluate('!!window.__voliro'),true);
  await new Promise(r=>setTimeout(r,400));
  const stats=await evaluate(`(()=>{const v=window.__voliro;return{pods:v.model.model.pods.map(p=>p.position.toArray()),draws:v.renderer.info.render.calls,triangles:v.renderer.info.render.triangles,props:v.model.props.map(p=>p.visible)}})()`);
  assert.deepEqual(stats.pods,[[-.45,0,-.07],[.45,0,-.07]]);
  assert.deepEqual(stats.props,[true,true,true,true,true]);assert.ok(stats.draws<40,JSON.stringify(stats));
  const batteryBounds=await evaluate(`(()=>{const root=window.__voliro.model.root;root.updateMatrixWorld(true);const pack=root.getObjectByName('voliro-t-battery-pack');const m=pack.children[0];m.geometry.computeBoundingBox();const b=m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);return{min:b.min.toArray(),max:b.max.toArray()}})()`);
  const close=(a,b)=>Math.abs(a-b)<1e-7;
  // Inspect the rendered pack, including its real world transform: front face at
  // the existing cross-tube line, correct product size, centred below the body.
  assert.ok(close(batteryBounds.min[2],-.07),JSON.stringify(batteryBounds));
  assert.ok(close(batteryBounds.max[2]-batteryBounds.min[2],.177));
  assert.ok(close(batteryBounds.max[0]-batteryBounds.min[0],.065));
  assert.ok(close(batteryBounds.max[1]-batteryBounds.min[1],.056));
  assert.ok(close(batteryBounds.min[0]+batteryBounds.max[0],0));
  assert.ok(close(batteryBounds.max[1],-.047));
  const batteryPosition=await evaluate(`window.__voliro.model.root.getObjectByName('voliro-t-battery').position.toArray()`);
  const gear=await evaluate(`(()=>{const v=window.__voliro;let bottom=Infinity;v.model.model.frame.updateMatrixWorld(true);v.model.model.frame.traverse(o=>{if(o.isMesh){o.geometry.computeBoundingBox();const b=o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);bottom=Math.min(bottom,b.min.y)}});return{bottom,floor:v.scene.getObjectByName('voliro-preview-ground').position.y}})()`);
  assert.ok(Math.abs(gear.bottom+.19)<.0005,JSON.stringify(gear));
  assert.ok(close(gear.floor,-.193));
  assert.ok(batteryBounds.min[1]-gear.bottom>.08,'underside battery stays above foot contact plane');
  await writeFile(path.join(output,'voliro_t_with_props.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.getElementById('props').click()`);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(await evaluate('window.__voliro.model.props.filter(p=>p.visible).length'),0);
  await writeFile(path.join(output,'voliro_t_bare.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.getElementById('props').click();document.getElementById('tilt').value='65';document.getElementById('tilt').dispatchEvent(new Event('input'))`);
  await new Promise(r=>setTimeout(r,200));
  const tilt=await evaluate('window.__voliro.model.model.pods.map(p=>p.rotation.x)');
  assert.ok(tilt.every(a=>Math.abs(a+65*Math.PI/180)<1e-10));
  assert.equal(await evaluate('window.__voliro.model.props.filter(p=>p.visible).length'),5);
  assert.deepEqual(await evaluate(`window.__voliro.model.root.getObjectByName('voliro-t-battery').position.toArray()`),batteryPosition);
  await writeFile(path.join(output,'voliro_t_tilt.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.querySelector('[data-view="top"]').click();document.getElementById('tilt').value='0';document.getElementById('tilt').dispatchEvent(new Event('input'))`);
  await new Promise(r=>setTimeout(r,200));
  await writeFile(path.join(output,'voliro_t_top.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.querySelector('[data-view="side"]').click()`);
  await new Promise(r=>setTimeout(r,200));
  await writeFile(path.join(output,'voliro_t_battery_side.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.deepEqual(errors,[]);console.log('Voliro photo visual: 190 mm landing contacts and matching preview ground; underside battery clearance, full/bare geometry, fixed battery during linked tilt, five props, no WebGL errors;',JSON.stringify({stats,batteryBounds,gear}));
} finally {
  ws?.close();chrome.kill('SIGTERM');await new Promise(r=>chrome.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
