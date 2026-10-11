// XML import and board-error UI tests. Desktop IPC is mocked; no board writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5183';
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
    window.__calls = []; window.__alerts = [];
    window.alert = value => window.__alerts.push(value);
    window.__fixture = {directory:'/tmp/xml-check',mainFile:'ball.xml',assets:[],
      files:[{name:'ball.xml',xml:'<fdm_config>\\n  <metrics></wrong>\\n</fdm_config>'}]};
    localStorage.setItem('jsbsim-last-simulation-target', JSON.stringify({script:'',model:'ball'}));
    window.__boardError = '仿真机 XML 加载失败：ball\\n\\n/mnt/sdcard/jsbsim/aircraft/ball/ball.xml:27:9:\\n27 |         <wingarea unit="FT2"> bad </wingarea>\\n             ^\\nXML element: /fdm_config[1]/metrics[1]/wingarea[1]\\nInvalid number: bad\\n启动日志：/mnt/sdcard/LOG/start_ball.log';
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1,
      invoke:async (command,args)=>{
        window.__calls.push({command,args});
        if (command === 'select_model_import') return window.__fixture;
        if (command === 'sim_status') return {external:true,connected:true,running:false,state:'stopped'};
        if (command === 'sim_list_models') return {models:[{name:'ball',file:'ball.xml',path:'ball'}]};
        if (command === 'sim_list_tests') return {tests:[]};
        if (command === 'sim_start') throw window.__boardError;
        return {};
      }
    };
  `});
  await send('Page.navigate',{url:baseUrl});
  await until('document.querySelector(".file-menu-trigger")');
  const unicodePosition = await evaluate(`(async () => {
    const {validateXmlSource} = await import('/src/utils/xmlDiagnostics.ts');
    try { validateXmlSource(${JSON.stringify('<a>\r  😀<b></wrong>\r</a>')}, 'unicode.xml'); }
    catch (error) { return error.message; }
  })()`);
  assert.match(unicodePosition, /unicode\.xml:2:7:/);
  async function openImport() {
    await evaluate('document.querySelector(".file-menu-trigger").click()');
    await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b=>/自动关联同目录|Import XML with siblings/.test(b.textContent)).click()`);
  }
  await openImport();
  await until('document.querySelector(".xml-diagnostic-dialog")');
  assert.match(await evaluate('document.querySelector(".xml-diagnostic-dialog pre").textContent'),/ball\.xml:2:\d+:/);
  assert.equal(await evaluate('window.__calls.some(c=>c.command==="parse_xml")'),false);
  assert.equal(await evaluate('Boolean(localStorage.getItem("jsbsim-raw-xml"))'),false);
  await evaluate('document.querySelector("[aria-label=关闭诊断]").click()');
  await evaluate('window.__fixture.files=' + JSON.stringify([{name:'ball.xml',xml:'<fdm_config name="ball" version="2.0"/>'},{name:'systems/bad.xml',xml:'<system>\n  <gain></wrong>\n</system>'}]));
  await openImport();
  await until('document.querySelector(".xml-diagnostic-dialog")');
  assert.match(await evaluate('document.querySelector(".xml-diagnostic-dialog pre").textContent'),/systems\/bad\.xml:2:\d+:/);
  assert.equal(await evaluate('window.__calls.some(c=>c.command==="parse_xml")'),false);
  await evaluate('document.querySelector("[aria-label=关闭诊断]").click()');
  // Exercise the real Start button's catch path with a string returned by IPC.
  await until('document.querySelector(".sim-primary-action") && !document.querySelector(".sim-primary-action").disabled');
  await evaluate('document.querySelector(".sim-primary-action").click()');
  await until('document.querySelector(".xml-diagnostic-dialog")');
  assert.equal(await evaluate('document.querySelector(".xml-diagnostic-dialog pre").textContent'),await evaluate('window.__boardError'));
  assert.ok(await evaluate('window.__calls.some(c=>c.command==="sim_start")'));
  await send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/jsbsim-xml-diagnostic-ui.png',Buffer.from(screenshot.data,'base64'));
  await evaluate('document.querySelector("[aria-label=关闭诊断]").click()');
  await until('!document.querySelector(".sim-primary-action").disabled');
  assert.deepEqual(await evaluate('window.__alerts'),[]);
  console.log('PASS: malformed main XML and reference are blocked before graph mutation; Start failure displays multiline source, caret and log path; retry is enabled. IPC mocked.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
