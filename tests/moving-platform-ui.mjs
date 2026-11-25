// End-to-end XML sync regression. Real Rust XML parser/generator, isolated
// in-memory simulator IPC; no hardware is contacted. Node 20: --experimental-websocket.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'model-xml-sync-'));
const bridgeSource = fileURLToPath(new URL('support/model-sync-backend.rs', import.meta.url));
await writeFile(path.join(work, 'Cargo.toml'), `[package]\nname="model-sync-backend"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="model-sync-backend"\npath=${JSON.stringify(bridgeSource)}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
const build = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(work, 'Cargo.toml')], { cwd: root, encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr);
const backend = (command, args) => {
  const result = spawnSync(path.join(work, 'target/debug/model-sync-backend'), { input: JSON.stringify({ command, args }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  if (value.error) throw new Error(value.error);
  return value;
};
const aviation=process.env.JSBSIM_PLATFORM_LIBRARY;
assert.ok(aviation);
const documents={};
for(const folder of ['aircraft/XCD20_FlightIdentified','engine','systems']) {
  let names=[];try{names=await (await import('node:fs/promises')).readdir(path.join(aviation,folder));}catch{}
  for(const name of names.filter(name=>name.endsWith('.xml')))documents[folder+'/'+name]=await readFile(path.join(aviation,folder,name),'utf8');
}
const graph=backend('load_model',{model:'XCD20_FlightIdentified',documents});
const native=graph.nodes.filter(n=>n.data.componentType==='moving_platform');
assert.equal(native.length,1);assert.ok(native[0].data.params.source.path.endsWith('/BodyForces.xml'));
assert.equal(graph.nodes.some(n=>n.data.params.file==='GuideRailsXML.xml'),false);
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (request.method === 'OPTIONS') { response.end(); return; }
  let source = ''; for await (const chunk of request) source += chunk;
  try { const { command, args } = JSON.parse(source); response.end(JSON.stringify(backend(command, args))); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const backendUrl = `http://127.0.0.1:${server.address().port}`;
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5193', '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    chrome.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:5193')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(page => page.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const until = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`); };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const graph = ${JSON.stringify(graph)};
    window.__graph = graph;
    window.__files = Object.fromEntries(graph.xmlFiles.map(file => [file.path, file.originalXml]));
    window.__writes = []; window.__alerts = []; window.__failRead = ''; window.__failWrite = ''; window.__badReadback = ''; window.__holdWrite = false;
    window.confirm = () => true; window.alert = message => window.__alerts.push(message);
    if (!localStorage.getItem('jsbsim-quota-reload-fixture')) {
      localStorage.setItem('jsbsim-language', 'zh-CN'); localStorage.setItem('jsbsim-cache-version', '2');
      localStorage.setItem('jsbsim-project', JSON.stringify(graph)); localStorage.setItem('jsbsim-remote-model', 'XCD20_FlightIdentified');
      localStorage.setItem('jsbsim-remote-baseline:XCD20_FlightIdentified', JSON.stringify(graph));
      localStorage.setItem('jsbsim-remote-upload-enabled', 'true');
    }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow:{label:'main'}, currentWebview:{label:'main'} }, transformCallback:()=>1,
      invoke: async (command, args) => {
        if (command === 'load_aircraft') {
          const documents=Object.fromEntries(Object.entries(window.__files).filter(([path])=>path!==window.__failRead));
          const result=await fetch(${JSON.stringify(backendUrl)}, {method:'POST',body:JSON.stringify({command:'load_model',args:{model:args.aircraftId,documents}})}).then(r=>r.json());
          if(result.error) throw new Error(result.error); return result;
        }
        if (['generate_xml','generate_subfile','parse_xml'].includes(command)) {
          const result = await fetch(${JSON.stringify(backendUrl)}, { method:'POST', body:JSON.stringify({command,args}) }).then(r=>r.json());
          if (result.error) throw new Error(result.error); return result;
        }
        if (command === 'ftp_download_xml') {
          if (window.__failRead === args.path) throw new Error('USB timeout');
          if (!(args.path in window.__files)) throw new Error('ENOENT');
          return { path:args.path, content:window.__badReadback === args.path && window.__writes.length ? '<wrong/>' : window.__files[args.path] };
        }
        if (command === 'ftp_list_xml_parent') {
          const files=Object.keys(window.__files).filter(path=>path.startsWith(args.parent+'/')).map(path=>path.slice(args.parent.length+1));
          return { exists: true, files };
        }
        if (command === 'ftp_download_sim_config') {
          if (!(args.path in window.__files)) throw new Error('ENOENT');
          return {path:args.path,content:window.__files[args.path]};
        }
        if (command === 'ftp_upload_sim_config') {window.__writes.push({path:args.path,content:args.content});window.__files[args.path]=args.content;return {saved:true};}
        if (command === 'ftp_upload_file') {
          if (window.__failWrite === args.path) throw new Error('Write failed');
          if (window.__holdWrite) await new Promise(resolve => {window.__releaseWrite=resolve;});
          window.__writes.push({path:args.path,content:args.content});window.__files[args.path]=args.content;return {uploaded:true};
        }
        if (command === 'sim_status') return {external:true,connected:true,running:false,state:'stopped'};
        if (command === 'sim_list_tests') return {tests:[]};
        if (command === 'sim_list_models') {
          if(window.__failList) throw new Error('Model list unavailable');
          return {models:Object.keys(window.__files).flatMap(path=>{const m=path.match(/^aircraft\\/([^/]+)\\/([^/]+)\\.xml$/);return m&&m[1]===m[2]?[{name:m[1]}]:[]})};
        }
        if (command === 'sim_list_instances') return {instances:[]};
        return {};
      }
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5193/' });
  await until(`document.querySelector('.toolbar')`);
  await evaluate(`(async()=>{window.store=(await import('/src/store/flowStore.ts')).useFlowStore;window.sync=(await import('/src/utils/modelXmlSync.ts'));window.changes=(await import('/src/utils/modelChanges.ts'));window.api=(await import('/src/utils/tauriApi.ts'));})()`);
  await until(`window.store.getState().nodes.length > 0`);
  await until(`document.body.innerText.includes('移动平台起降')`);
  const started=Date.now();
  await evaluate(`(()=>{const s=window.store.getState();s.setSelectedNode(s.nodes.find(n=>n.data.componentType==='moving_platform').id);})()`);
  await until(`document.querySelector('[data-testid="moving-platform-editor"]')`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="moving-platform-editor"] canvas').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="moving-platform-editor"] details').length`),5);
  // Edit through the actual grouped component property editor.
  await evaluate(`(()=>{const select=document.querySelector('[data-testid="moving-platform-editor"] select[aria-label="场景"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'3');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`window.store.getState().nodes.find(n=>n.data.componentType==='moving_platform').data.params['scenario/mode']===3`);
  const saved=await evaluate(`(async()=>{const s=window.store.getState();return window.sync.prepareModelXml(s,window.__graph,'XCD20_FlightIdentified',window.api);})()`);
  const dirty=saved.filter(x=>x.dirty);assert.deepEqual(dirty.map(x=>x.path),['aircraft/XCD20_FlightIdentified/BodyForces.xml']);
  const source=documents[dirty[0].path];
  const expected=source.replace(/(<property value=")0(">scenario\/mode<\/property>)/,'$13$2');
  assert.equal(dirty[0].content,expected,'one property edit preserves all other original bytes, including body drag');
  const reopened=backend('load_model',{model:'XCD20_FlightIdentified',documents:{...documents,[dirty[0].path]:dirty[0].content}});
  assert.equal(reopened.nodes.find(n=>n.data.componentType==='moving_platform').data.params['scenario/mode'],3);
  assert.equal(reopened.nodes.filter(n=>n.data.componentType==='engine').length,8);
  const tiltFields = [
    ['固定 Pitch', 'moving-platform/fixed-pitch-deg', 5],
    ['固定 Roll', 'moving-platform/fixed-roll-deg', -3],
  ];
  for (const [label, key, degrees] of tiltFields) {
    const input = `document.querySelector('input[aria-label="${label}"]')`;
    assert.equal(await evaluate(`${input}.value`), '0');
    await evaluate(`(()=>{const field=${input};field.focus();field.select();})()`);
    await send('Input.insertText', { text: String(degrees) });
    await evaluate(`${input}.blur()`);
    await until(`window.store.getState().nodes.find(n=>n.data.componentType==='moving_platform').data.params[${JSON.stringify(key)}]===${degrees}`);
  }
  const tilted = await evaluate(`window.sync.prepareModelXml(window.store.getState(),window.__graph,'XCD20_FlightIdentified',window.api)`);
  const tiltedDirty = tilted.filter(file => file.dirty);
  assert.deepEqual(tiltedDirty.map(file => file.path), [dirty[0].path]);
  const tiltedGraph = backend('load_model', {model:'XCD20_FlightIdentified',
    documents:{...documents,[tiltedDirty[0].path]:tiltedDirty[0].content}});
  const tiltedParams = tiltedGraph.nodes.find(node => node.data.componentType === 'moving_platform').data.params;
  for (const [, key, degrees] of tiltFields) assert.equal(tiltedParams[key], degrees);
  const level = await evaluate(`(async()=>{const state=window.store.getState();
    const nodes=state.nodes.map(node=>node.data.componentType==='moving_platform'
      ? {...node,data:{...node.data,params:{...node.data.params,
          'moving-platform/fixed-pitch-deg':0,'moving-platform/fixed-roll-deg':0}}}
      : node);
    return window.sync.prepareModelXml({...state,nodes},window.__graph,'XCD20_FlightIdentified',window.api);
  })()`);
  assert.equal(level.find(file => file.path === dirty[0].path).content, expected);
  for(let i=0;i<12;i++)await evaluate(`(()=>{const s=window.store.getState();s.setSelectedNode(null);s.setSelectedNode(s.nodes.find(n=>n.data.componentType==='moving_platform').id);})()`);
  await until(`document.querySelector('[data-testid="moving-platform-editor"]')`);
  await send('Page.captureScreenshot',{format:'png'}).then(result=>writeFile('/tmp/xcd20-moving-platform-ui.png',Buffer.from(result.data,'base64')));
  await new Promise(resolve=>setTimeout(resolve,500));
  await evaluate(`localStorage.setItem('jsbsim-quota-reload-fixture','1')`);
  await send('Page.reload');await until(`document.querySelector('.toolbar')`);
  await evaluate(`(async()=>{window.store=(await import('/src/store/flowStore.ts')).useFlowStore;})()`);
  await until(`window.store.getState().nodes.some(n=>n.data.componentType==='moving_platform')`);
  assert.equal(await evaluate(`window.store.getState().nodes.find(n=>n.data.componentType==='moving_platform').data.params['scenario/mode']`),3);
  console.log(JSON.stringify({passed:true,componentCount:1,engines:8,sourcePreserved:true,reload:true,interactionMs:Date.now()-started,projectBytes:Buffer.byteLength(JSON.stringify(graph))}));
} finally {
  socket?.close();const exited=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill();vite.kill();server.close();await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);await rm(work,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
