// Import the real IMU XML, edit its constant on canvas, and prepare an exact
// source patch plus one runtime parameter. No board connection is opened.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'imu-rotation-ui-'));
const name = `.imu-rotation-${process.pid}`;
const entry = path.join(root, 'client', `${name}.html`);
const module = path.join(root, 'client', `${name}.tsx`);
let server, vite, chrome, socket;
try {
  await writeFile(path.join(work, 'Cargo.toml'), [
    '[package]', 'name="imu-rotation-backend"', 'version="0.0.0"', 'edition="2021"',
    '[[bin]]', 'name="imu-rotation-backend"', `path=${JSON.stringify(path.join(root, 'tests/support/model-sync-backend.rs'))}`,
    '[dependencies]', 'serde_json="1"', 'serde={version="1",features=["derive"]}',
    'quick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}', '',
  ].join('\n'));
  const built = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(work, 'Cargo.toml')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const backend = (command, args) => {
    const result = spawnSync(path.join(work, 'target/debug/imu-rotation-backend'), { input: JSON.stringify({ command, args }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    if (value.error) throw Error(value.error);
    return value;
  };
  const sensorPath = 'aircraft/voliro_t/SensorImuPX4.xml';
  const wmmPath = 'aircraft/voliro_t/VoliroTMagWmm.xml';
  const sensor = await readFile(path.resolve(root, '../jsbsim_realtime/data/aviation', sensorPath), 'utf8');
  const wmm = await readFile(path.resolve(root, '../jsbsim_realtime/data/aviation', wmmPath), 'utf8');
  const graph = backend('load_model', { model: 'voliro_t', documents: {
    'aircraft/voliro_t/voliro_t.xml': '<fdm_config name="voliro_t"><system file="SensorImuPX4"/><system file="VoliroTMagWmm"/></fdm_config>',
    [sensorPath]: sensor, [wmmPath]: wmm,
  } });
  server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') { response.end(); return; }
    let input = ''; for await (const chunk of request) input += chunk;
    try { const { command, args } = JSON.parse(input); response.end(JSON.stringify(backend(command, args))); }
    catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(entry, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
  await writeFile(module, `
import React from 'react';import{createRoot}from'react-dom/client';
import Module from './src/components/expression/ModuleExpressionCanvas';import{useFlowStore}from'./src/store/flowStore';
import{systemCanvasChannels,splitSystemCanvasChannels}from'./src/utils/systemSignalCanvas';
import{buildSignalGraph,graphToChannels}from'./src/utils/signalGraph';
import{prepareModelXml}from'./src/utils/modelXmlSync';import{projectParameterChanges}from'./src/sim/runtimeParameters';import './src/App.css';
const baseline=${JSON.stringify(graph)};useFlowStore.getState().loadProject(structuredClone(baseline));
const backend=async(command,args)=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});const v=await r.json();if(v.error)throw Error(v.error);return v;};
const generators={generateXml:async data=>(await backend('generate_xml',{data})).xml,generateSubfile:async(type,name,params)=>(await backend('generate_subfile',{req:{type,name,params}})).xml};
window.__prepare=()=>prepareModelXml(useFlowStore.getState(),baseline,'voliro_t',generators);
window.__edits=()=>projectParameterChanges(baseline,useFlowStore.getState());window.__changes=0;
window.__roundtrips=baseline.nodes.filter(n=>n.data.componentType==='system').map(node=>{const p=node.data.params;const before=systemCanvasChannels(JSON.parse(p.channels||'[]'),JSON.parse(p.topLevelItems||'[]'));const g=buildSignalGraph(before,[],{layout:false});return {before,after:graphToChannels(g.nodes,g.edges,before)};});
function Harness(){const nodes=useFlowStore(s=>s.nodes),node=nodes.find(n=>n.data.params.name==='Sensor - IMU');const p=node.data.params;
const channels=systemCanvasChannels(JSON.parse(p.channels),JSON.parse(p.topLevelItems||'[]'));
const initialLayout=Object.fromEntries(buildSignalGraph(channels,[],{layout:false}).nodes.map((n,i)=>[n.id,{x:80+i%6*240,y:80+Math.floor(i/6)*160}]));
return <div className="app" style={{height:'100vh'}}><Module embedded mode="signal" title="Sensor - IMU · PX4 rotation" modelId="imu-rotation-test" channels={channels} initialLayout={initialLayout} onInit={rf=>window.__rf=rf} onChannelsChange={chs=>{window.__changes++;const split=splitSystemCanvasChannels(chs);useFlowStore.getState().updateNodeParams(node.id,{channels:JSON.stringify(split.channels),topLevelItems:JSON.stringify(split.topLevelItems)});}} onBack={()=>{}}/></div>;}
createRoot(document.getElementById('root')).render(<Harness/>);`);
  vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: root, stdio: 'ignore' });
  chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Chrome startup timed out')), 15000);
    chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:5197/${name}.html`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const page = (await fetch(`http://${new URL(ws).host}/json/list`).then(r => r.json())).find(page => page.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 30000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async expression => { for (let i = 0; i < 200; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`); };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('jsbsim-language','zh-CN');window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async()=>({})};` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:5197/${name}.html` });
  await until('window.__rf?.getNodes().some(n=>n.data.name==="sensor/imu/rotation")');
  const roundtrips = await evaluate('window.__roundtrips');
  for (const item of roundtrips) assert.deepEqual(item.after, item.before, 'IMU and WMM graph preserve XML order, inputs, tables and values');
  assert.ok((await evaluate('window.__prepare()')).every(doc => !doc.dirty));
  const id = await evaluate(`window.__rf.getNodes().find(n=>n.data.name==='sensor/imu/rotation').id`);
  await evaluate(`document.querySelector('.react-flow__node[data-id="${id}"]').click()`);
  await until('[...document.querySelectorAll(".expr-props .field-row")].some(row=>row.querySelector("label")?.textContent==="常数值")');
  assert.equal(await evaluate(`document.querySelector('.expr-props').textContent.includes('输入信号（端口）')`), false, 'imported constants have no fake input field');
  await evaluate(`(()=>{const input=[...document.querySelectorAll('.expr-props .field-row')].find(row=>row.querySelector('label')?.textContent==='常数值').querySelector('input');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'24');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);
  await until('window.__changes===1');
  assert.equal(await evaluate(`window.__rf.getNode(${JSON.stringify(id)}).data.expression.value`), 24);
  const edits = await evaluate('window.__edits()');
  assert.equal(edits.length, 1); assert.equal(edits[0].value, 24); assert.match(edits[0].key, /^_tuning\/value\/n/);
  const saved = await evaluate('window.__prepare()');
  assert.deepEqual(saved.filter(doc => doc.dirty).map(doc => doc.path), [sensorPath]);
  assert.equal(saved.find(doc => doc.path === sensorPath).content, sensor.replace('<function><value>0</value></function>', '<function><value>24</value></function>'), 'one constant edit preserves all other source bytes');
  assert.equal(saved.find(doc => doc.path === wmmPath).content, wmm);
  if (process.env.IMU_ROTATION_SCREENSHOT) {
    await evaluate(`window.__rf.setViewport({x:120,y:150,zoom:1})`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.IMU_ROTATION_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  console.log('PASS: real IMU/WMM import, graph roundtrip, visible constant edit, one runtime parameter, exact XML save');
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  chrome?.kill('SIGTERM'); vite?.kill('SIGTERM');
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await Promise.all([rm(entry, { force: true }), rm(module, { force: true })]);
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
