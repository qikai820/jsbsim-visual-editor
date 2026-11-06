// CPU/SSD temperature UI regression; mocked telemetry, no hardware writes.
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
    window.__health={external:true, connected:true, state:'stopped', healthAgeMs:50,
      cpuCores:[5,10,15,20,25,30,35,40], memory:{total:100,used:20,free:80,percent:20},
      temperatures:{cpuC:57.31,ssdC:36.85}};
    window.__TAURI_INTERNALS__={
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,
      invoke:async(command,args)=>{
        window.__calls.push({command,args});
        if(command==='sim_status'){if(window.__failStatus)throw new Error('IPC unavailable');return window.__health;}
        if(command==='simulator_network_target_get')return '192.168.101.82';
        if(command.startsWith('ftp_list')||command==='ftp_models')return [];
        return {};
      }
    };
  `});
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:baseUrl});
  const cpu = `document.querySelector('[data-testid="cpu-temperature"]')`;
  const ssd = `document.querySelector('[data-testid="ssd-temperature"]')`;
  await until(`${cpu}?.textContent.includes('57.3°C') && ${ssd}?.textContent.includes('36.9°C')`);
  assert.match(await evaluate('document.querySelector(".sim-runtime-metrics").title'),/CPU 温度 57.3°C/);
  const shot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/jsbsim-temperatures.png',Buffer.from(shot.data,'base64'));
  await evaluate('window.__health.temperatures={cpuC:0,ssdC:null}');
  await until(`${cpu}?.textContent.includes('0.0°C') && ${ssd}?.textContent.includes('不可用')`);
  await evaluate('window.__health.temperatures={cpuC:200,ssdC:"42"}');
  await until(`${cpu}?.textContent.includes('不可用') && ${ssd}?.textContent.includes('不可用')`);
  await evaluate('window.__health.temperatures={cpuC:60,ssdC:45}; window.__health.healthAgeMs=5000');
  await until(`${cpu}?.textContent.includes('不可用') && ${ssd}?.textContent.includes('不可用')`);
  await evaluate('window.__health.healthAgeMs=10; window.__health.connected=false');
  await until(`${cpu}?.textContent.includes('不可用') && ${ssd}?.textContent.includes('不可用')`);
  await evaluate('window.__health.connected=true; delete window.__health.temperatures');
  await until(`${cpu}?.textContent.includes('不可用') && ${ssd}?.textContent.includes('不可用')`);
  await evaluate('window.__health.temperatures={cpuC:58,ssdC:38}');
  await until(`${cpu}?.textContent.includes('58.0°C') && ${ssd}?.textContent.includes('38.0°C')`);
  await evaluate('window.__failStatus=true');
  await until(`${cpu}?.textContent.includes('不可用') && ${ssd}?.textContent.includes('不可用')`);
  console.log('PASS: CPU/SSD values, zero, invalid readings, missing sensor, stale/disconnected and older firmware. Mocked telemetry.');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
