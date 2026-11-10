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
    localStorage.setItem('jsbsim-multi-model-slots-v1', JSON.stringify({'01':'test'}));
    window.confirm = () => true;
    window.__stored = JSON.stringify({version:1,mcap:{enabled:true,rateHz:500,bufferMb:500}});
    window.__uploads = [];
    window.__networkSaves = [];
    window.__networkInterfaces = [
      {name:'eth0',address:'192.168.144.82',netmask:'255.255.255.0',gateway:'0.0.0.0'},
      {name:'eth1',address:'192.168.101.82',netmask:'255.255.255.0',gateway:'192.168.101.1'},
    ];
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
        if (command === 'sim_network_read') return structuredClone(window.__networkInterfaces);
        if (command === 'sim_network_set') {
          window.__networkSaves.push(args);
          return new Promise((resolve,reject) => {
            window.__networkSaveSuccess = transport => {
              window.__networkInterfaces = window.__networkInterfaces.map(item => item.name === args.name ? {...args} : item);
              resolve({...args,transport});
            };
            window.__networkSaveFailure = () => reject('Network readback temporarily unavailable');
          });
        }
        if (command === 'ftp_get_simulator_version') return {version:{product:'JSBSim Realtime',version:'test'}};
        if (command === 'sim_list_tests') return {tests:[]};
        if (command === 'sim_list_models') return {models:[]};
        return {};
      }
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1464, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: baseUrl });
  const workspace = `document.querySelector('.workspace-menu-trigger')`;
  await until(workspace);
  await evaluate(`${workspace}.click()`);
  const open = `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === '⚙ Simulation')`;
  await until(open);
  await evaluate(`${open}.click()`);
  await until(`document.querySelector('.sim-config-dialog footer')?.textContent.includes('Current configuration')`);
  const networkPort = `document.querySelector('.sim-config-network select')`;
  const networkAddress = `document.querySelector('.sim-config-network input')`;
  await until(`${networkPort}?.options.length === 2`);
  assert.deepEqual(await evaluate(`[...${networkPort}.options].map(option => option.value)`), ['eth0', 'eth1']);
  await until(`${networkAddress}.value === '192.168.144.82'`);
  await evaluate(`(() => {const field=${networkPort};field.value='eth1';field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`${networkAddress}.value === '192.168.101.82'`);
  await evaluate(`[...document.querySelectorAll('.sim-config-network button')].find(button => button.textContent === 'Read Back').click()`);
  await until(`${networkPort}.value === 'eth1' && ${networkAddress}.value === '192.168.101.82' && !${networkPort}.disabled`);
  await evaluate(`(() => {const field=${networkPort};field.value='eth0';field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`${networkAddress}.value === '192.168.144.82'`);
  const networkSave = `document.querySelector('.sim-config-dialog footer .primary')`;
  const networkGateway = `document.querySelectorAll('.sim-config-network input')[2]`;
  assert.equal(await evaluate(`${networkSave}.textContent`), 'Save & Apply');
  assert.equal(await evaluate(`${networkSave}.disabled`), true, 'unchanged network settings cannot enqueue a write');
  assert.equal(await evaluate(`document.querySelector('.sim-config-network').textContent.includes('Apply over USB')`), false);
  await evaluate(`(() => {const field=${networkGateway};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'192.168.144.1');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`!${networkSave}.disabled`);
  await evaluate(`${networkSave}.click()`);
  await until('window.__networkSaves.length === 1');
  assert.equal(await evaluate(`${networkSave}.disabled`), true);
  assert.equal(await evaluate(`${networkSave}.textContent`), 'Saving…');
  await evaluate(`${networkSave}.click()`);
  assert.equal(await evaluate('window.__networkSaves.length'), 1, 'no duplicate network write while busy');
  await evaluate('window.__networkSaveFailure()');
  await until(`!${networkSave}.disabled`);
  assert.equal(await evaluate(`${networkGateway}.value`), '192.168.144.1', 'failed save retains network edits');
  assert.match(await evaluate(`document.querySelector('.sim-config-dialog footer').textContent`), /Save failed; edits retained/);
  await evaluate(`${networkSave}.click()`);
  await until('window.__networkSaves.length === 2');
  await evaluate(`window.__networkSaveSuccess('network')`);
  await until(`${networkSave}.disabled && document.querySelector('.sim-config-dialog footer').textContent.includes('Saved over Ethernet')`);
  await evaluate(`(() => {const field=${networkGateway};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'0.0.0.0');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`${networkSave}.click()`);
  await until('window.__networkSaves.length === 3');
  await evaluate(`window.__networkSaveSuccess('usb')`);
  await until(`${networkSave}.disabled && document.querySelector('.sim-config-dialog footer').textContent.includes('Saved over USB')`);
  assert.equal(await evaluate('window.__uploads.length'), 0, 'network settings do not write a model configuration');
  assert.equal(await evaluate(`(() => {const box=${networkSave}.getBoundingClientRect();return box.width>0 && box.bottom<=innerHeight && box.right<=innerWidth;})()`), true, 'network save remains visible in the fixed footer');
  const networkShot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/jsbsim-network-interfaces-ui.png', Buffer.from(networkShot.data, 'base64'));
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'Runtime & Time').click()`);
  const simRate = `[...document.querySelectorAll('.sim-config-field')].find(el => el.textContent.includes('Simulation rate'))?.querySelector('input')`;
  const timeStep = `[...document.querySelectorAll('.sim-config-field')].find(el => el.textContent.includes('Time step'))?.querySelector('input')`;
  await until(`${simRate}.value === '500'`);
  await evaluate(`(() => {
    const field = ${simRate};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '250');
    field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await until(`${timeStep}.value === '0.004'`);
  await evaluate(`(() => {
    const field = ${simRate};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '250.5');
    field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  assert.equal(await evaluate(`${simRate}.value`), '250', 'fractional frequency is rejected');
  const displayRate = `[...document.querySelectorAll('.sim-config-field')].find(el => el.textContent.includes('Wire / scope display rate'))?.querySelector('input')`;
  await until(`${displayRate}.value === '25'`);
  for (const invalid of ['0', '101', '25.5']) {
    await evaluate(`(() => {const field=${displayRate};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(invalid)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate(`document.querySelector('.sim-config-dialog footer .primary').click()`);
    await until(`document.querySelector('.sim-config-dialog footer').textContent.includes('Display rate must be an integer from 1 to 100 Hz')`);
    assert.equal(await evaluate('window.__uploads.length'),0,'invalid display rate cannot reach the task machine');
  }
  await evaluate(`(() => {const field=${displayRate};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'50');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate(`${timeStep}.value`),'0.004','display frequency does not change the simulation timestep');
  const performanceTab = `[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'Performance & Safety')`;
  const usbDebug = `[...document.querySelectorAll('.sim-config-check')].find(el => el.textContent.includes('USB debug prints'))?.querySelector('input')`;
  await evaluate(`${performanceTab}.click()`);
  await until(usbDebug);
  assert.equal(await evaluate(`${usbDebug}.checked`), false, 'old configurations default to quiet USB diagnostics');
  await evaluate(`${usbDebug}.click()`);
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'MCAP Logging').click()`);
  const rate = `[...document.querySelectorAll('.sim-config-field')].find(el => el.textContent.includes('State and critical field rate'))?.querySelector('input')`;
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
  assert.equal(await evaluate('JSON.parse(window.__stored).runtime.dt'), 0.004);
  assert.equal(await evaluate('JSON.parse(window.__stored).runtime.displayRateHz'),50);
  assert.equal(await evaluate('JSON.parse(window.__stored).diagnostics.usbDebugPrint'), true);
  assert.match(await evaluate(`document.querySelector('.sim-config-dialog footer').textContent`), /Saved and verified/);
  const shot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/jsbsim-config-save-ui.png', Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('.sim-config-dialog > header > button').click()`);
  await until(`!document.querySelector('.sim-config-dialog')`);
  await evaluate(`${workspace}.click()`);
  await evaluate(`${open}.click()`);
  await until(`document.querySelector('.sim-config-dialog')`);
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'Runtime & Time').click()`);
  await until(`${displayRate}.value === '50'`);
  const displayShot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/jsbsim-display-rate-config.png',Buffer.from(displayShot.data,'base64'));
  await evaluate(`[...document.querySelectorAll('.sim-config-layout nav button')].find(el => el.textContent === 'MCAP Logging').click()`);
  await until(`${rate}.value === '400'`);
  await evaluate(`${performanceTab}.click()`);
  await until(`${usbDebug}.checked === true`);
  await evaluate(`${usbDebug}.click()`);
  await evaluate(`${save}.click()`);
  await until('window.__uploads.length === 3');
  await evaluate('window.__saveSuccess()');
  await until(`${save}.disabled && ${save}.textContent === 'Save to Simulator'`);
  assert.equal(await evaluate('JSON.parse(window.__stored).diagnostics.usbDebugPrint'), false);
  const usbShot = await send('Page.captureScreenshot', {format:'png'});
  await writeFile('/tmp/jsbsim-usb-debug-config.png', Buffer.from(usbShot.data, 'base64'));
  console.log('PASS: network Save & Apply visible, busy/deduplication, failure retains edits, Ethernet/USB acknowledgement; both Ethernet ports selectable and selection retained on refresh; display rate/save/reopen and USB debug persistence. Desktop IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
