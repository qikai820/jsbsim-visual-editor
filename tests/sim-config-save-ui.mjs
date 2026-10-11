// Browser regression for config save/retry. Desktop IPC is mocked; no board writes.
// Run with Node >= 22, or Node 20 --experimental-websocket.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5174/';
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-config-save-'));
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
  assert.ok(page);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
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
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI timeout: ${expression}; body=${await evaluate('document.body.innerText')}`);
  }

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('jsbsim-language', 'en-US');
    window.confirm = () => true;
    window.__stored = JSON.stringify({version:1,mcap:{enabled:true,rateHz:500,bufferMb:500}});
    window.__uploads = [];
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1,
      invoke:async (command,args)=>{
        if (command === 'sim_status') return {external:true,connected:true,running:false,state:'stopped'};
        if (command === 'ftp_download_sim_config') return {path:args.path,content:window.__stored};
        if (command === 'ftp_upload_sim_config') {
          window.__uploads.push(args);
          return new Promise((resolve,reject) => {
            window.__saveSuccess = () => {window.__stored=args.content;resolve({path:args.path,saved:true});};
            window.__saveFailure = () => reject('USB transport busy: lock wait timed out');
          });
        }
        if (command === 'sim_network_read') return [{name:'eth0',address:'192.168.101.81',netmask:'255.255.255.0',gateway:'192.168.101.1'}];
        if (command === 'ftp_get_simulator_version') return {version:{product:'JSBSim Realtime',version:'test'}};
        if (command === 'sim_list_tests') return {tests:[]};
        if (command === 'sim_list_models') return {models:[]};
        return {};
      }
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1464, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: baseUrl });
  const open = `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === '⚙ Simulation')`;
  await until(open);
  await evaluate(`${open}.click()`);
  await until(`document.querySelector('.sim-config-dialog footer').textContent.includes('Current configuration')`);
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'MCAP Logging').click()`);
  const rate = `[...document.querySelectorAll('.sim-config-field')].find(el => el.textContent.includes('High-rate field frequency'))?.querySelector('input')`;
  await until(`${rate}.value === '500'`);
  await evaluate(`(() => {
    const field = ${rate};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '400');
    field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  const save = `document.querySelector('.sim-config-dialog footer .primary')`;
  await until(`!${save}.disabled`);
  await evaluate(`${save}.click()`);
  await until(`window.__uploads.length === 1`);
  assert.equal(await evaluate(`${save}.textContent`), 'Saving…');
  assert.equal(await evaluate(`${save}.disabled`), true);
  assert.match(await evaluate(`document.querySelector('.sim-config-dialog footer').textContent`), /Writing.*verifying/);
  await evaluate(`${save}.click()`);
  assert.equal(await evaluate('window.__uploads.length'), 1, 'saving cannot enqueue a duplicate write');
  await evaluate('window.__saveFailure()');
  await until(`!${save}.disabled`);
  assert.match(await evaluate(`document.querySelector('.sim-config-dialog footer').textContent`), /Save failed; edits retained.*lock wait timed out/);
  assert.equal(await evaluate(`${rate}.value`), '400');
  await evaluate(`${save}.click()`);
  await until('window.__uploads.length === 2');
  await evaluate('window.__saveSuccess()');
  await until(`${save}.textContent === 'Save to Simulator'`);
  assert.equal(await evaluate(`${save}.disabled`), true);
  assert.equal(await evaluate('JSON.parse(window.__stored).mcap.rateHz'), 400);
  assert.match(await evaluate(`document.querySelector('.sim-config-dialog footer').textContent`), /Saved and verified/);
  const shot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/jsbsim-config-save-ui.png', Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('.sim-config-dialog > header > button').click()`);
  await until(`!document.querySelector('.sim-config-dialog')`);
  await evaluate(`${open}.click()`);
  await until(`document.querySelector('.sim-config-dialog')`);
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'MCAP Logging').click()`);
  await until(`${rate}.value === '400'`);
  console.log('PASS: save progress, timeout recovery, retained edits, retry and reopen. Desktop IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
