// Node 20: node --experimental-websocket tests/model-library-load-ui.mjs [Vite URL]
// Chromium UI test with mocked desktop status; no board writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5197';
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-library-ui-'));
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    let output = '';
    chrome.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}`)); });
  });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    const targets = await fetch(`http://${new URL(endpoint).host}/json/list`).then(response => response.json());
    page = targets.find(target => target.type === 'page');
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome page target is available');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer); pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
  });
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      const result = await evaluate(`Boolean(${expression})`);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI timeout: ${expression}\nAlerts: ${JSON.stringify(await evaluate('window.__alerts'))}\nCalls: ${JSON.stringify(await evaluate('window.__calls.map(call => call.command)'))}\n${await evaluate('document.body.innerText')}`);
  }


  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {source: `
    localStorage.clear();
    localStorage.setItem('jsbsim-simulator-transport','network');
    window.__calls=[]; window.__alerts=[]; window.__failure=true; window.__releases={};
    window.alert=message=>window.__alerts.push(message);
    const setTimeoutOriginal=window.setTimeout.bind(window);
    window.setTimeout=(callback,delay,...args)=>setTimeoutOriginal(callback,
      delay===90000 && window.__fastTimeout ? 200 : delay,...args);
    window.__TAURI_INTERNALS__={
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,
      invoke:async(command,args)=>{
        window.__calls.push({command,args});
        if(command==='sim_status')return {external:true,connected:true,state:'stopped'};
        if(command==='sim_list_models')return {models:[]};
        if(command==='sim_list_tests')return {tests:[]};
        if(command==='sim_list_instances')return {instances:[]};
        if(command==='get_aircraft_library')return {library:[{id:'voliro_t',name:'voliro_t',type:'fixed_wing',size:0,subFiles:[]}]};
        if(command==='load_aircraft'){
          if(window.__holdModel)await new Promise(resolve=>{
            window.__release=resolve; window.__releases[args.requestId]=resolve;
          });
          return {model:'voliro_t',aircraft:{name:'voliro_t'},nodes:[],edges:[],subFiles:[],xmlFiles:[],sourceXml:'<fdm_config name="voliro_t"/>',referenceFiles:[]};
        }
        if(command==='cancel_aircraft_load'){
          window.__releases[args.requestId]?.(); delete window.__releases[args.requestId];
          return;
        }
        if(command==='ftp_download_xml')return {content:args.path.endsWith('.pwm.xml')?'<pwm_inputs/>':'<serial_outputs/>'};
        if(command==='ftp_list_xml_parent')return {exists:true,files:['voliro_t.json']};
        if(command==='ftp_download_sim_config'){
          if(window.__holdConfig)await new Promise(resolve=>window.__release=resolve);
          if(window.__failure)throw 'curl: (7) Failed to connect to 192.168.101.82 port 21';
          return {content:'{"version":1,"environment":{"windNorthFps":12}}'};
        }
        return {};
      }
    };
  `});
  await send('Page.navigate',{url:baseUrl});
  await until('document.querySelector(".workspace-menu-trigger")');
  async function openLibrary() {
    await evaluate('document.querySelector(".workspace-menu-trigger").click()');
    await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>/模型库|Models/.test(b.textContent)).click()');
    await until('document.querySelector(".library-item")');
    await evaluate('document.querySelector(".library-item").click()');
    await until('document.querySelector(".library-load-btn")');
  }
  const target = ()=>evaluate('localStorage.getItem("jsbsim-remote-model")');
  const start = ()=>evaluate('document.querySelector(".library-load-btn").click()');
  await openLibrary();
  const initialTarget=await target();
  await start();
  await until('document.querySelector(".library-load-error")');
  assert.match(await evaluate('document.querySelector(".library-load-error").textContent'),/voliro_t.*port 21/);
  assert.equal(await evaluate('document.querySelector(".library-load-btn").disabled'),false);
  assert.deepEqual(await evaluate('window.__alerts'),[],'loading errors must not block the UI with alert');
  assert.equal(await target(),initialTarget,'failed configuration must preserve the previous model');

  await evaluate('window.__failure=false;window.__holdConfig=true;window.__release=null');
  await start();
  await until('typeof window.__release === "function"');
  await evaluate('Array.from(document.querySelectorAll(".library-select-sim-btn")).find(b=>b.textContent==="取消加载").click()');
  await until('!document.querySelector(".library-load-btn").disabled');
  await evaluate('window.__release();window.__holdConfig=false');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await target(),initialTarget,'cancelled sidecar completion must not replace the model');

  await evaluate('window.__holdModel=true;window.__release=null');
  await start();
  await until('typeof window.__release === "function"');
  const configReads=await evaluate('window.__calls.filter(c=>c.command==="ftp_download_sim_config").length');
  await evaluate('document.querySelector(".library-modal .wizard-close").click()');
  await until('!document.querySelector(".library-modal")');
  await evaluate('window.__release();window.__holdModel=false');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await target(),initialTarget,'closing the library must cancel pending import');
  assert.equal(await evaluate('window.__calls.filter(c=>c.command==="ftp_download_sim_config").length'),configReads);

  await openLibrary();
  await evaluate('window.__holdModel=true;window.__release=null');
  await start();
  await until('typeof window.__release === "function"');
  const cancelledRequest = await evaluate('window.__calls.filter(c=>c.command==="load_aircraft").at(-1).args.requestId');
  await evaluate('Array.from(document.querySelectorAll(".library-select-sim-btn")).find(b=>b.textContent==="取消加载").click()');
  await until(`window.__calls.some(c=>c.command==="cancel_aircraft_load" && c.args.requestId===${JSON.stringify(cancelledRequest)})`);
  await until('!document.querySelector(".library-load-btn").disabled');
  assert.equal(await target(),initialTarget,'cancelled backend read must preserve the previous model');

  // Retry while the previous request settles; each attempt must use its own ID.
  await evaluate('window.__fastTimeout=true;window.__release=null');
  await start();
  await until('document.querySelector(".library-load-error")?.textContent.includes("90 秒")');
  const timedOutRequest = await evaluate('window.__calls.filter(c=>c.command==="load_aircraft").at(-1).args.requestId');
  assert.notEqual(timedOutRequest,cancelledRequest);
  await until(`window.__calls.some(c=>c.command==="cancel_aircraft_load" && c.args.requestId===${JSON.stringify(timedOutRequest)})`);
  await evaluate('window.__holdModel=false;window.__fastTimeout=false');

  await evaluate('window.__holdConfig=true;window.__fastTimeout=true;window.__release=null');
  await start();
  await until('document.querySelector(".library-load-error")?.textContent.includes("90 秒")');
  assert.equal(await evaluate('document.querySelector(".library-load-btn").disabled'),false);
  await evaluate('window.__release();window.__holdConfig=false;window.__fastTimeout=false');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await target(),initialTarget,'timed-out completion must not replace the model');

  await start();
  await until('!document.querySelector(".library-modal")');
  assert.equal(await target(),'voliro_t');
  assert.deepEqual(await evaluate('window.__alerts'),[]);
  console.log('PASS: failure stays inline; cancel, close and timeout ignore late results; model reads send request-specific backend cancellation; retry succeeds. Desktop IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
