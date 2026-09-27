// Chromium UI test with mocked desktop status; no board writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5179';
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-import-ui-'));
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
    window.__calls=[]; window.__alerts=[];
    window.__record={recording:false,written:0,dropped:0};
    window.__TAURI_INTERNALS__={
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,
      invoke: async(command,args)=>{
        window.__calls.push({command,args});
        if(command==='sim_status') return {external:true,connected:false,state:'disconnected'};
        if(command==='telemetry_record_status') return window.__record;
        if(command==='telemetry_record_start') {
          if(args.directory==='/invalid') throw new Error('无法创建记录目录');
          window.__record={recording:true,written:12,dropped:0,path:'/tmp/telemetry-test.jsonl'};
          return window.__record;
        }
        if(command==='telemetry_record_stop') {window.__record.recording=false; return window.__record;}
        return {};
      }
    };
  `});
  await send('Page.navigate',{url:baseUrl});
  await until('Array.from(document.querySelectorAll(".file-menu-trigger")).some(b => /Tools|工具/.test(b.textContent))');
  async function openRecorder() {
    await evaluate('Array.from(document.querySelectorAll(".file-menu-trigger")).find(b => /Tools|工具/.test(b.textContent)).click()');
    await evaluate('document.querySelector(".telemetry-record-menuitem").click()');
  }
  assert.equal(await evaluate('document.querySelectorAll(".telemetry-record-trigger").length'),0);
  await openRecorder();
  await evaluate('document.querySelector(".telemetry-record-action").click()');
  await until('document.querySelector(".telemetry-record-action").textContent.includes("停止并保存")');
  assert.equal(await evaluate('window.__calls.find(c=>c.command==="telemetry_record_start").args.directory'),null);
  assert.ok(await evaluate('document.querySelector(".telemetry-record-panel input").disabled'));
  await evaluate('document.querySelector(".telemetry-record-heading button").click()');
  assert.equal(await evaluate('window.__calls.filter(c=>c.command==="telemetry_record_stop").length'),0);
  await openRecorder();
  await evaluate('document.querySelector(".telemetry-record-action").click()');
  await until('document.querySelector(".telemetry-record-panel").textContent.includes("已保存")');
  assert.match(await evaluate('document.querySelector(".telemetry-record-path").textContent'), /telemetry-test.jsonl/);
  await evaluate(`const input=document.querySelector('.telemetry-record-panel input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'/invalid'); input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await evaluate('document.querySelector(".telemetry-record-action").click()');
  await until('document.querySelector(".telemetry-record-error")?.textContent.includes("无法创建")');
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  const shot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/telemetry-recorder-ui.png',Buffer.from(shot.data,'base64'));
  console.log('PASS: Tools menu entry (no toolbar button), start, default directory, recording indicator, disabled path while recording, close without stop, stop/save, error feedback. IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
