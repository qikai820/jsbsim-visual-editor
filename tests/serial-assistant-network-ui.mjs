// Run with node --experimental-websocket on Node 20. Socket IO is covered by
// cargo test --test serial_assistant; this test exercises the actual React UI.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp('/tmp/serial-network-ui-');
const name = `.serial-network-${process.pid}`;
const entry = `${root}/client/${name}.html`, module = `${root}/client/${name}.tsx`;
let vite, chrome, ws;
try {
  await writeFile(entry, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
  await writeFile(module, `import React from 'react';import{createRoot}from'react-dom/client';import Assistant from './src/components/SerialAssistantDialog';import './src/App.css';import{installDialogDragging}from'./src/utils/dialogDragging';installDialogDragging();createRoot(document.getElementById('root')).render(<Assistant onClose={()=>{}}/>);`);
  vite = spawn(`${root}/node_modules/.bin/vite`, ['--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, stdio: 'ignore' });
  chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 15000);
    chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once('exit', code => { clearTimeout(timer); reject(Error(`Chrome exited ${code}`)); });
  });
  const target = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  ws.addEventListener('message', event => { const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return; clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(Error(`CDP timeout ${method}`)), 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const until = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(r => setTimeout(r, 50)); } throw Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`); };
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:5199/${name}.html`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  // Real pointer events exercise focus, hover and the portaled popup. DOM
  // element.click() alone misses placement and hit-testing failures.
  const pointerClick = async expression => {
    const point = await evaluate(`(()=>{const element=(${expression}),r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,receivesPointer:element.contains(document.elementFromPoint(x,y))};})()`);
    assert.ok(point.receivesPointer, `pointer target is visible above its window: ${expression}`);
    const { x, y } = point;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if(!localStorage.getItem('local-serial-assistant-settings-v1'))localStorage.setItem('local-serial-assistant-settings-v1',JSON.stringify({config:{path:'/dev/ttyMOCK',baudRate:123456}}));
    window.__calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args)=>{
      window.__calls.push({command,args});
      if(command==='serial_assistant_list_ports')return Array.from({length:32},(_,index)=>({path:'/dev/ttyS'+index,label:'/dev/ttyS'+index}));
      if(command==='serial_assistant_network_open'||command==='serial_assistant_open'){
        if(window.__fail)throw Error('mock connection refused');
        window.__emit=event=>args.onEvent.onmessage({sessionId:1,...event});
        if(command==='serial_assistant_network_open')window.__emit({kind:'endpoint',localAddr:'127.0.0.1:9001',peerAddr:args.config.mode==='tcpClient'?'127.0.0.1:9000':null});
        return {sessionId:1,path:'mock endpoint'};
      }
      if(command==='serial_assistant_pick_capture')return '/tmp/mock.serialcap';
      if(command==='serial_assistant_write'){
        window.__emit({kind:'data',direction:'tx',timeMs:Date.now(),elapsedUs:1000,bytes:args.bytes,peer:'127.0.0.1:9000'});return args.bytes.length;
      }
      if(command==='serial_assistant_export')return '/tmp/mock.json';
      return null;
    }};
    window.el=label=>document.querySelector('[aria-label="'+label+'"]');
    window.change=(element,value)=>{Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement?HTMLSelectElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
    window.mode=()=>document.querySelector('[data-mode][aria-pressed=true]')?.dataset.mode;
    window.chooseMode=mode=>document.querySelector('[data-mode='+mode+']').click();
    window.modesLocked=()=>Array.from(document.querySelectorAll('[data-mode]')).every(button=>button.disabled);
    window.connect=()=>document.querySelector('.serial-assistant-connect>.serial-assistant-primary');
    window.sendButton=()=>document.querySelector('.serial-assistant-send-input>.serial-assistant-primary');
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:5199/${name}.html` });
  await until('el("调试方式")');
  assert.equal(await evaluate('document.querySelectorAll("[data-mode]").length'), 4);
  assert.equal(await evaluate('el("选择或输入波特率").value'), '123456', 'old serial settings retained');
  await until('document.querySelector(".serial-assistant-port label")?.textContent.includes("32")');
  await until('Number(document.querySelector(".serial-assistant-overlay").style.zIndex)>11000');
  for (const zoom of [1, 0.85, 1.25, 1.6]) {
    await evaluate(`document.documentElement.style.zoom=${zoom}`);
    await pointerClick('el("展开本机串口列表")');
    await until('document.querySelectorAll(".serial-assistant-combo-options [role=option]").length===32');
    const geometry = await evaluate('(()=>{const popup=document.querySelector(".serial-assistant-combo-menu").getBoundingClientRect(),input=el("本机串口或设备路径").getBoundingClientRect();return {left:popup.left,inputLeft:input.left,top:popup.top,inputBottom:input.bottom,bottom:popup.bottom,viewportHeight:innerHeight};})()');
    assert.ok(Math.abs(geometry.left - geometry.inputLeft) < 1, `popup stays aligned at zoom ${zoom}`);
    assert.ok(geometry.top >= geometry.inputBottom && geometry.bottom <= geometry.viewportHeight, `popup stays visible at zoom ${zoom}`);
    for (const index of [2, 31]) {
      if (index === 31) {
        await pointerClick('el("展开本机串口列表")');
        await until('document.querySelector(".serial-assistant-combo-menu")');
      }
      await evaluate(`document.querySelectorAll(".serial-assistant-combo-options [role=option]")[${index}].scrollIntoView({block:"nearest"})`);
      await pointerClick(`document.querySelectorAll(".serial-assistant-combo-options [role=option]")[${index}]`);
      await until(`el("本机串口或设备路径").value==="/dev/ttyS${index}" && !document.querySelector(".serial-assistant-combo-menu")`);
      assert.equal(await evaluate('JSON.parse(localStorage.getItem("local-serial-assistant-settings-v1")).config.path'), `/dev/ttyS${index}`);
    }
  }
  await evaluate('document.documentElement.style.zoom=""');
  await pointerClick('el("展开波特率列表")');
  await until('document.querySelectorAll(".serial-assistant-combo-options [role=option]").length===22');
  const baudPreset = 'Array.from(document.querySelectorAll(".serial-assistant-combo-options [role=option]")).find(option=>option.textContent.trim()==="921600")';
  await evaluate(`(${baudPreset}).scrollIntoView({block:"nearest"})`);
  await pointerClick(baudPreset);
  await until('el("选择或输入波特率").value==="921600"');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("local-serial-assistant-settings-v1")).config.baudRate'), 921600);
  await evaluate('change(el("选择或输入波特率"),"0")');
  await until('connect().disabled && el("选择或输入波特率").getAttribute("aria-invalid")==="true"');
  await evaluate('change(el("选择或输入波特率"),"115")');
  await evaluate('el("选择或输入波特率").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
  await evaluate('el("选择或输入波特率").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await until('el("选择或输入波特率").value==="115200"');
  await evaluate('change(el("选择或输入波特率"),"123456")');
  await evaluate('el("选择或输入波特率").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await until('!connect().disabled');
  assert.equal(await evaluate('document.querySelectorAll(".serial-assistant-connect [role=combobox]").length'), 2, 'port and baud rate each use one editable combobox');
  await evaluate(`chooseMode('tcpClient')`);
  await until('el("目标地址")');
  assert.equal(await evaluate('!!el("DTR 电平")'), false);
  assert.equal(await evaluate('!!el("本地 IP")'), false);
  await evaluate(`change(el('目标地址'),'');connect().click()`);
  await until('document.querySelector("[role=alert]")');
  assert.equal(await evaluate('window.__calls.some(c=>c.command==="serial_assistant_network_open")'), false);
  await evaluate(`change(el('目标地址'),'127.0.0.1');change(el('目标端口'),'9000');window.__fail=true;connect().click()`);
  await until('document.querySelector("[role=alert]")?.textContent.includes("mock connection refused")');
  assert.equal(await evaluate('window.modesLocked()'), false);
  await evaluate('window.__fail=false;connect().click()');
  await until('connect().textContent==="断开"');
  assert.equal(await evaluate('window.modesLocked()'), true);
  assert.match(await evaluate('document.querySelector(".serial-assistant-status").textContent'), /127.0.0.1:9000/);
  await evaluate(`window.__emit({kind:'data',direction:'rx',timeMs:Date.now(),elapsedUs:100,bytes:[0,255,85],peer:'127.0.0.1:9000',streamId:0})`);
  await until('document.querySelector(".serial-assistant-row")?.textContent.includes("00 FF 55")');
  assert.match(await evaluate('document.querySelector(".serial-assistant-row").textContent'), /127.0.0.1:9000/);
  await evaluate(`change(el('发送内容'),'AA 00 FF');sendButton().click()`);
  await until('window.__calls.some(c=>c.command==="serial_assistant_write")');
  assert.deepEqual(await evaluate('window.__calls.find(c=>c.command==="serial_assistant_write").args.bytes'), [170,0,255]);
  await evaluate(`change(el('发送格式'),'text');change(el('发送内容'),'hello');change(el('换行方式'),'crlf')`);
  await evaluate('sendButton().click()');
  await until('window.__calls.filter(c=>c.command==="serial_assistant_write").length===2');
  assert.deepEqual(await evaluate('window.__calls.filter(c=>c.command==="serial_assistant_write")[1].args.bytes'), [104,101,108,108,111,13,10]);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='开始记录').click()`);
  await until('window.__calls.some(c=>c.command==="serial_assistant_record_start")');
  await evaluate(`change(el('导出当前窗口数据'),'json')`);
  await until('window.__calls.some(c=>c.command==="serial_assistant_export")');
  const exported = await evaluate(`JSON.parse(new TextDecoder().decode(Uint8Array.from(window.__calls.find(c=>c.command==='serial_assistant_export').args.bytes)))`);
  assert.ok(exported.some(frame=>frame.peer==='127.0.0.1:9000' && frame.hex==='00 FF 55'));
  await evaluate('connect().click()'); await until('!window.modesLocked()');
  await evaluate(`chooseMode('tcpServer')`); await until('el("本地 IP")');
  assert.equal(await evaluate('!!el("目标地址")'), false);
  await evaluate(`change(el('本地端口'),'0');connect().click()`);
  await until('connect().textContent==="停止"');
  assert.equal(await evaluate('sendButton().disabled'), true);
  assert.match(await evaluate('document.querySelector(".serial-assistant-status").textContent'), /等待客户端连接/);
  await evaluate(`window.__emit({kind:'endpoint',localAddr:'127.0.0.1:9001',peerAddr:'127.0.0.1:50000'})`);
  await until('!sendButton().disabled');
  await evaluate(`window.__emit({kind:'endpoint',localAddr:'127.0.0.1:9001',peerAddr:null})`);
  await until('sendButton().disabled');
  await evaluate('connect().click()'); await until('!window.modesLocked()');
  await evaluate(`chooseMode('udp')`); await until('el("目标地址") && el("本地 IP")');
  await evaluate(`change(el('目标地址'),'')`); await until('el("目标端口").disabled');
  await evaluate('connect().click()'); await until('connect().textContent==="停止"');
  assert.equal(await evaluate('sendButton().disabled'), true);
  await evaluate(`window.__emit({kind:'data',direction:'rx',timeMs:Date.now(),elapsedUs:10,bytes:[1,2],peer:'127.0.0.1:45678',datagram:true});window.__emit({kind:'data',direction:'rx',timeMs:Date.now(),elapsedUs:11,bytes:[3],peer:'127.0.0.1:45679',datagram:true})`);
  await until('!sendButton().disabled && document.querySelectorAll(".serial-assistant-row").length===2');
  assert.match(await evaluate('document.querySelector(".serial-assistant-status").textContent'), /127.0.0.1:45679/);
  await evaluate(`Array.from(document.querySelectorAll('[role=tab]'))[1].click()`);
  await until('document.querySelectorAll(".serial-assistant-frame-row").length===2');
  assert.match(await evaluate('document.querySelector(".serial-assistant-analysis").textContent'), /UDP 报文/);
  if (process.env.SERIAL_NETWORK_SCREENSHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.SERIAL_NETWORK_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await evaluate('connect().click()'); await until('!window.modesLocked()');
  await send('Page.reload');
  await until('window.mode()==="udp" && el("目标地址")?.value===""');
  await evaluate(`chooseMode('serial')`);
  await until('el("DTR 电平")');
  assert.equal(await evaluate('el("选择或输入波特率").value'), '123456');
  await evaluate('connect().click()');
  await until('connect().textContent==="断开"');
  assert.equal(await evaluate('window.__calls.find(c=>c.command==="serial_assistant_open").args.config.baudRate'), 123456, 'custom baud rate reaches the backend as a number');
  assert.equal(await evaluate('el("选择或输入波特率").disabled && el("本机串口或设备路径").disabled'), true);
  await evaluate('connect().click()');
  await until('!window.modesLocked()');
  if (process.env.SERIAL_WORKBENCH_SCREENSHOT) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    const takeScreenshot = async suffix => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`${process.env.SERIAL_WORKBENCH_SCREENSHOT}${suffix}.png`, Buffer.from(shot.data, 'base64'));
    };
    await takeScreenshot('-serial');
    await evaluate('el("展开波特率列表").click()');
    await until('document.querySelector(".serial-assistant-combo-menu")');
    await takeScreenshot('-baud');
    await evaluate('el("选择或输入波特率").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
    await takeScreenshot('-compact');
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await takeScreenshot('-narrow');
    const layout = await evaluate('(()=>{const body=document.querySelector(".serial-assistant-body");return {width:body.clientWidth,scroll:body.scrollWidth};})()');
    assert.ok(layout.scroll <= layout.width + 1, 'narrow workbench contains its controls');
  }
  console.log('PASS: production window stacking, pointer hit-testing, real pointer serial dropdown at 85/100/125/160% zoom, 32-port scrolling, editable baud presets/custom validation, serial settings, TCP client/server, UDP, endpoint events, HEX/text send, capture/export, datagram frames, errors, control locking and persistence. IPC mocked.');
} finally {
  ws?.close(); chrome?.kill('SIGTERM'); vite?.kill('SIGTERM');
  await Promise.all([rm(entry,{force:true}),rm(module,{force:true})]);
  await rm(work,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
