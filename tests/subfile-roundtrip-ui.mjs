// Real parser/generator + module canvas: viewing/layout never edits child XML,
// and a scalar edit changes only the selected source bytes. No hardware I/O.
// node --experimental-websocket tests/subfile-roundtrip-ui.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'subfile-roundtrip-'));
const name = `.subfile-roundtrip-${process.pid}`;
const entry = path.join(root, 'client', `${name}.html`);
const module = path.join(root, 'client', `${name}.tsx`);
await writeFile(path.join(work, 'Cargo.toml'), `[package]\nname="subfile-roundtrip-backend"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="subfile-roundtrip-backend"\npath=${JSON.stringify(path.join(root, 'tests/support/model-sync-backend.rs'))}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
const built = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(work, 'Cargo.toml')], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const backend = (command, args) => {
  const result = spawnSync(path.join(work, 'target/debug/subfile-roundtrip-backend'), { input: JSON.stringify({ command, args }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  if (value.error) throw Error(value.error);
  return value;
};
const sources = await Promise.all(['systems/SensorImu.xml', 'systems/SensorImuPX4.xml',
  'aircraft/H7/H7_SensorImuPX4.xml', 'aircraft/voliro_t/VoliroTActuators.xml'].map(async file => ({
  file: `systems/${path.basename(file)}`, xml: await readFile(path.resolve(root, '../jsbsim_realtime/data/aviation', file), 'utf8'),
})));
sources.push({ file: 'systems/Metadata.xml', xml: `<?xml version='1.0'?>\r\n<system name='Metadata'>\r\n\t<!-- keep spacing, quotes and empty channels -->\r\n\t<channel name='Empty' execute='fcs/enabled'/>\r\n\t<channel name='Control' execute='1'>\r\n\t\t<pid name='fcs/pid'><input lag='1'> fcs/input </input><kp type='real'>2.00</kp><output>fcs/output</output></pid>\r\n\t\t<summer name='fcs/sum'><input>fcs/output</input><gain>2</gain><input>fcs/other</input></summer>\r\n\t</channel>\r\n</system>\r\n` });
const graphs = sources.map(({ file, xml }) => backend('load_model', { model: 'Roundtrip', documents: {
  'aircraft/Roundtrip/Roundtrip.xml': `<fdm_config name="Roundtrip"><system file="${path.basename(file, '.xml')}"/></fdm_config>`,
  [file]: xml,
} }));
const server = createServer(async (request, response) => {
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
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Module from './src/components/expression/ModuleExpressionCanvas';import{useFlowStore}from'./src/store/flowStore';
import{systemCanvasChannels,splitSystemCanvasChannels}from'./src/utils/systemSignalCanvas';
import{buildSignalGraph,graphToChannels}from'./src/utils/signalGraph';
import{prepareModelXml}from'./src/utils/modelXmlSync';import{changedModelPaths}from'./src/utils/modelChanges';
import './src/App.css';
window.__store=useFlowStore;window.__graphs=${JSON.stringify(graphs)};
window.__backend=async(command,args)=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});const v=await r.json();if(v.error)throw Error(v.error);return v;};
window.__generators={generateXml:async data=>(await window.__backend('generate_xml',{data})).xml,generateSubfile:async(type,name,params)=>(await window.__backend('generate_subfile',{req:{type,name,params}})).xml};
window.__prepare=()=>prepareModelXml(useFlowStore.getState(),window.__baseline,'Roundtrip',window.__generators);
window.__paths=()=>changedModelPaths(useFlowStore.getState(),window.__baseline,'Roundtrip');
window.__roundtrip=graph=>{const node=graph.nodes.find(n=>n.data.componentType==='system'),p=node.data.params;
 const channels=systemCanvasChannels(JSON.parse(p.channels||'[]'),JSON.parse(p.topLevelItems||'[]'));
 const g=buildSignalGraph(channels,[],{layout:false});return {before:channels,after:graphToChannels(g.nodes,g.edges,channels)};};
function Harness(){const[version,setVersion]=useState(0);window.__mount=index=>{const graph=structuredClone(window.__graphs[index]);window.__baseline=structuredClone(graph);useFlowStore.getState().loadProject(graph);window.__rf=null;window.__calls=0;window.__backs=0;setVersion(v=>v+1);};
 const nodes=useFlowStore(s=>s.nodes),node=nodes.find(n=>n.data.componentType==='system');if(!node)return null;
 const p=node.data.params,channels=systemCanvasChannels(JSON.parse(p.channels||'[]'),JSON.parse(p.topLevelItems||'[]'));
 const initialLayout=Object.fromEntries(buildSignalGraph(channels,[],{layout:false}).nodes.map((n,i)=>[n.id,{x:80+i%6*240,y:80+Math.floor(i/6)*180}]));
 return <div className="app" style={{height:'100vh'}}><Module key={version} embedded mode="signal" title="Sensor - IMU" modelId="roundtrip" channels={channels} initialLayout={initialLayout}
 onInit={rf=>window.__rf=rf} onChannelsChange={chs=>{window.__calls++;const split=splitSystemCanvasChannels(chs);useFlowStore.getState().updateNodeParams(node.id,{channels:JSON.stringify(split.channels),topLevelItems:JSON.stringify(split.topLevelItems)});}}
 onLayoutChange={layout=>useFlowStore.getState().updateNodeParams(node.id,{layout:JSON.stringify(layout)})} onBack={()=>window.__backs++}/></div>;
}createRoot(document.getElementById('root')).render(<Harness/>);`);
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5198', '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const ws = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Chrome startup timed out')), 15000);
    chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:5198/${name}.html`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
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
  await send('Page.navigate', { url: `http://127.0.0.1:5198/${name}.html` }); await until('window.__mount');
  for (let i = 0; i < graphs.length; i++) {
    const result = await evaluate(`window.__roundtrip(window.__graphs[${i}])`);
    assert.ok(result.before.some(channel => channel.items.length > 0), 'fixture imports actual child components');
    assert.deepEqual(result.after, result.before, `${sources[i].file}: graph roundtrip retains all original fields and empty channels`);
    await evaluate(`window.__mount(${i})`); await until('window.__rf?.getNodes().some(n=>n.data.kind==="component") && document.querySelector(".expr-back-btn")');
    await evaluate('document.querySelector(".expr-back-btn").click()');
    assert.equal(await evaluate('window.__calls'), 0, `${sources[i].file}: viewing/returning never commits model data`);
    assert.deepEqual(await evaluate('window.__paths()'), [], `${sources[i].file}: layout does not mark XML dirty`);
    const documents = await evaluate('window.__prepare()');
    assert.ok(documents.every(doc => !doc.dirty));
    assert.equal(documents.find(doc => doc.path === sources[i].file)?.content, sources[i].xml);
  }
  const order = await evaluate(`(async()=>{const{applyXmlDelta}=await import('/src/utils/xmlDelta.ts');
   const source="<system>\\n  <channel name='a'/>\\n  <!-- keep -->\\n  <channel name='b'/>\\n</system>";
   const before='<system><channel name="a"/><channel name="b"/></system>';
   const after='<system><channel name="b"/><channel name="a"/></system>';
   return applyXmlDelta(source,before,after);})()`);
  assert.equal(order, "<system>\n  <channel name='b'/>\n  <!-- keep -->\n  <channel name='a'/>\n</system>", 'an actual order edit still moves source nodes');
  await evaluate('window.__mount(0)'); await until('window.__rf?.getNodes().some(n=>n.data.kind==="component") && document.querySelector(".expr-back-btn")');
  await until('document.querySelector(".react-flow__node-signalBlock.draggable")');
  await evaluate(`(async()=>{await window.__rf.setViewport({x:100,y:100,zoom:1});await new Promise(requestAnimationFrame);})()`);
  // Drag through the real ReactFlow event handlers, then return.
  const dragged = await evaluate(`(()=>{const n=window.__rf.getNodes().find(n=>n.data.kind==='component');const r=document.querySelector('.react-flow__node[data-id="'+n.id+'"] .diagram-block').getBoundingClientRect();const point={x:r.x+r.width/2,y:r.y+r.height/2};return {id:n.id,position:n.position,point,hit:document.elementFromPoint(point.x,point.y)?.closest('.react-flow__node')?.dataset.id};})()`);
  assert.equal(dragged.hit, dragged.id, 'the drag targets a visible component');
  const point = dragged.point;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
  for (let step = 1; step <= 5; step++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x + 60 * step / 5, y: point.y + 30 * step / 5 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: point.x + 60, y: point.y + 30 });
  await until(`JSON.stringify(window.__rf.getNode(${JSON.stringify(dragged.id)}).position)!==${JSON.stringify(JSON.stringify(dragged.position))}`);
  await evaluate('document.querySelector(".expr-back-btn").click()');
  assert.equal(await evaluate('window.__calls'), 0, 'dragging changes layout only');
  assert.deepEqual(await evaluate('window.__paths()'), []);
  // Exercise a real property-panel edit in the Sensor - IMU system.
  await evaluate('window.__mount(0)'); await until('window.__rf?.getNodes().some(n=>n.data.kind==="component") && document.querySelector(".expr-back-btn")');
  const sensorId = await evaluate(`window.__rf.getNodes().find(n=>n.data.name==='temp_C').id`);
  await evaluate(`document.querySelector('.react-flow__node[data-id="${sensorId}"]').click()`);
  await until('document.querySelector(".expr-props input")');
  const changed = await evaluate(`(async()=>{const row=[...document.querySelectorAll('.expr-props .field-row')].find(r=>r.textContent.includes('lag'));
   if(!row)throw Error('lag property missing: '+document.querySelector('.expr-props').innerText);const input=row.querySelector('input');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.125');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));return true;})()`);
  assert.ok(changed); await until('window.__calls > 0');
  const saved = await evaluate('window.__prepare()');
  assert.deepEqual(saved.filter(doc => doc.dirty).map(doc => doc.path), [sources[0].file]);
  assert.equal(saved.find(doc => doc.path === sources[0].file).content, sources[0].xml.replace('<lag>0</lag>', '<lag>0.125</lag>'), 'one lag edit leaves every other source byte unchanged');
  // A second edit and a revert must still compare against the source snapshot.
  await evaluate(`(()=>{const input=[...document.querySelectorAll('.expr-props .field-row')].find(r=>r.textContent.includes('lag')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0');input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);
  await until('window.__calls === 2');
  assert.ok((await evaluate('window.__prepare()')).every(doc => !doc.dirty), 'restoring the original value clears XML changes');
  console.log(`PASS: ${graphs.length} real child XML roundtrips, untouched return, layout-only drag, explicit reorder and exact scalar patch/revert`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  chrome.kill('SIGTERM'); vite.kill('SIGTERM'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await Promise.all([rm(entry, { force: true }), rm(module, { force: true })]);
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
