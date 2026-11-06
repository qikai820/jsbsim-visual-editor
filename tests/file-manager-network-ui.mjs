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
    localStorage.setItem('jsbsim-simulator-transport','network');
    window.__calls=[]; window.__alerts=[];
    window.__TAURI_INTERNALS__={
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,
      invoke:async(command,args)=>{
        window.__calls.push({command,args});
        if(command==='sim_status')return {external:true,connected:true,state:'stopped'};
        if(command==='simulator_network_target_get')return '192.168.3.82';
        if(command==='usb_file_edit_sessions')return [];
        if(command==='usb_file_storage')return [
          {volume:'sd',mountPath:'/mnt/sdcard',totalBytes:null,usedBytes:null,availableBytes:null},
          {volume:'data',mountPath:'/data',totalBytes:7529250816,usedBytes:146784256,availableBytes:7382466560}];
        if(command==='usb_file_list'||command==='usb_file_list_with_modified'){
          if(args.path==='sd')throw 'SD 卡未挂载，无法访问文件 (/mnt/sdcard)';
          return {files:[{name:'emmc_test.txt',directory:false,size:13,modified:1789803300},{name:'jsbsim',directory:true,size:0}]};
        }
        if(command==='usb_file_open_builtin')return {path:args.path,content:'emmc-data-ok\\n',size:13,checksum:123};
        if(command==='usb_file_ping')return {identity:'nuttx-network-files/1',source:'nuttx-network'};
        return {};
      }
    };
  `});
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:baseUrl});
  await until('Array.from(document.querySelectorAll(".file-menu-trigger")).some(b=>/Tools|工具/.test(b.textContent))');
  await evaluate('Array.from(document.querySelectorAll(".file-menu-trigger")).find(b=>/Tools|工具/.test(b.textContent)).click()');
  await evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>/Simulator Files|仿真机文件管理/.test(b.textContent)).click()');
  await until('document.querySelector(".usb-fm-list")?.textContent.includes("emmc_test.txt")');
  assert.match(await evaluate('document.querySelector(".usb-fm-header").textContent'),/网口|network/);
  assert.equal(await evaluate('document.querySelector(".usb-fm-volumes button.active strong").textContent'),'eMMC (data)');
  assert.match(await evaluate('document.querySelector(".usb-fm-volumes button").textContent'),/未挂载|Not mounted/);
  assert.equal(await evaluate('document.querySelector(".usb-fm-breadcrumb").textContent'),'data');
  assert.ok(await evaluate('window.__calls.some(c=>c.command==="usb_file_list"&&c.args.path==="data")'));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/jsbsim-file-manager-network.png',Buffer.from(shot.data,'base64'));
  await evaluate('document.querySelector(".usb-fm-volumes button").click()');
  await until('document.querySelector(".usb-fm")?.textContent.includes("SD 卡未挂载")');
  await evaluate('document.querySelectorAll(".usb-fm-volumes button")[1].click()');
  await until('document.querySelector(".usb-fm-list")?.textContent.includes("emmc_test.txt")');
  console.log('PASS: network label, mounted eMMC selected, SD unavailable, data listing and volume switching. IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
