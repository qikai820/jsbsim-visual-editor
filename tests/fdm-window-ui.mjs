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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__calls = []; window.__alerts = [];
    window.__status = {external:true, connected:true, running:true, state:'running',
      healthAgeMs:20, cpuCores:[36,12], fdmRunMs:0.4,
      fdmWindow:{averageMs:0.8,maxMs:6.5,samples:25},simulationDt:0.002};
    window.__TAURI_INTERNALS__ = {
      metadata: {currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback: () => 1,
      invoke: async (command,args) => {
        window.__calls.push({command,args});
        if (command === 'sim_status') return window.__status;
        return {};
      }
    };
  ` });
  await send('Page.navigate', {url:baseUrl});
  await until('document.querySelector(".sim-connection-fdm")?.textContent.includes("0.800")');
  await evaluate('document.querySelector(".sim-connection-fdm").click()');
  await until('document.querySelector(".sim-fdm-popup")');
  assert.match(await evaluate('document.querySelector(".sim-fdm-stats").innerText'), /6.500/);
  assert.equal(await evaluate('document.querySelectorAll(".sim-fdm-popup polyline").length'),2);
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  const screenshot = await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/jsbsim-fdm-window.png',Buffer.from(screenshot.data,'base64'));
  await evaluate('delete window.__status.fdmWindow; window.__status.fdmRunMs=1.25');
  await until('document.querySelector(".sim-connection-fdm")?.textContent.includes("1.250")');
  assert.ok(!(await evaluate('document.querySelector(".sim-connection-fdm").textContent')).includes('均值'));
  await evaluate('window.__status.state="stopped"; window.__status.fdmRunMs=0; window.__status.fdmWindow={averageMs:0,maxMs:0,samples:0}');
  await until('document.querySelector(".sim-connection-fdm")?.textContent.includes("0.000")');
  console.log('PASS: window mean, retained 6.5 ms peak, both curves, old-firmware fallback, stopped zero. Desktop status mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
