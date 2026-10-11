// Real browser regression for the script editor. Desktop IPC is mocked.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5183/';
const value = {
  name: 'test.xml', aircraft: 'ball', initialize: 'reset', start: '0', end: '10', dt: '0.01',
  events: [{ name: '切换模式', condition: 'simulation/sim-time-sec > 5',
    sets: [{ name: 'fcs/throttle-cmd-norm', value: '0.5' }], notifies: [] }],
};
const xml = '<runscript><use aircraft="ball" initialize="reset"/><run start="0" end="10" dt="0.01"><event name="切换模式"><condition>simulation/sim-time-sec &gt; 5</condition><set name="fcs/throttle-cmd-norm" value="0.5"/></event></run></runscript>';
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-script-editor-'));
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
    localStorage.setItem('jsbsim-last-simulation-target', JSON.stringify({script:'scripts/test.xml',model:'ball'}));
    localStorage.setItem('jsbsim-script-editor:test.xml', JSON.stringify(${JSON.stringify(value)}));
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1,
      invoke:async command=>{
        if (command === 'sim_status') return {external:true,connected:true,running:false,state:'stopped'};
        if (command === 'ftp_download_script') return {file:'test.xml',xml:${JSON.stringify(xml)},source:'remote'};
        if (command === 'sim_list_tests') return {tests:[{name:'test',file:'test.xml',path:'scripts/test.xml'}]};
        if (command === 'sim_list_models') return {models:[{name:'ball',file:'ball.xml',path:'ball'}]};
        return {};
      }
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1464, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: baseUrl });
  await until('document.querySelector(".script-flow-mini")');
  const card = JSON.parse(await evaluate(`JSON.stringify((() => {
    const el = document.querySelector('.script-flow-mini'), r = el.getBoundingClientRect();
    return {parent:el.parentElement.tagName, right:innerWidth-r.right, bottom:innerHeight-r.bottom};
  })())`));
  assert.equal(card.parent, 'BODY');
  assert.ok(Math.abs(card.right - 332) < 2 && Math.abs(card.bottom - 18) < 2, JSON.stringify(card));
  await evaluate('document.querySelector(".script-flow-mini").click()');
  await until('document.querySelector(".script-editor-modal")');
  const text = await evaluate('document.querySelector(".script-editor-modal").innerText');
  assert.match(text, /测试脚本逻辑/);
  assert.equal(await evaluate('document.querySelector(".script-flow-node-title input").value'), '切换模式');
  assert.match(text, /保存到仿真机/);
  const metrics = JSON.parse(await evaluate(`JSON.stringify((() => {
    const overlay = document.querySelector('.script-editor-overlay');
    const dialog = document.querySelector('.script-editor-modal');
    const header = document.querySelector('.script-editor-head');
    return {parent:overlay.parentElement.tagName, overlay:overlay.getBoundingClientRect().toJSON(),
      dialog:dialog.getBoundingClientRect().toJSON(), header:header.getBoundingClientRect().toJSON()};
  })())`));
  assert.equal(metrics.parent, 'BODY');
  assert.equal(metrics.overlay.height, 800);
  assert.ok(metrics.header.y >= 0 && metrics.header.bottom < 800, JSON.stringify(metrics));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/jsbsim-script-editor-ui.png', Buffer.from(shot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1464, height: 466, deviceScaleFactor: 1, mobile: false });
  const small = JSON.parse(await evaluate(`JSON.stringify((() => {
    const overlay = document.querySelector('.script-editor-overlay').getBoundingClientRect();
    const header = document.querySelector('.script-editor-head').getBoundingClientRect();
    return {height:overlay.height, headerTop:header.top, headerBottom:header.bottom};
  })())`));
  assert.equal(small.height, 466);
  assert.ok(small.headerTop >= 0 && small.headerBottom < 466, JSON.stringify(small));
  assert.ok(await evaluate(`(() => {
    const board = document.querySelector('.script-flow-board');
    return board.scrollHeight > board.clientHeight;
  })()`), 'small window keeps the event list scrollable');
  const smallShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/jsbsim-script-editor-compact-ui.png', Buffer.from(smallShot.data, 'base64'));
  await evaluate('document.querySelector(".script-editor-head button:last-child").click()');
  await until('!document.querySelector(".script-editor-overlay") && document.querySelector(".script-flow-mini")');
  const compactCard = JSON.parse(await evaluate(`JSON.stringify((() => {
    const r = document.querySelector('.script-flow-mini').getBoundingClientRect();
    return {right:innerWidth-r.right, bottom:innerHeight-r.bottom};
  })())`));
  assert.ok(Math.abs(compactCard.right - 332) < 2 && Math.abs(compactCard.bottom - 18) < 2, JSON.stringify(compactCard));
  const cardShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/jsbsim-script-card-compact-ui.png', Buffer.from(cardShot.data, 'base64'));
  console.log('PASS: script editor opens with header, event controls and save action. Desktop IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
