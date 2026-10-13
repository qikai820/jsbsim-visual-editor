// H7_Viztra.xml formula view and MathLive edit regression in real Chromium.
// Run after starting Vite: node --experimental-websocket tests/formula-notebook-ui.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5179';
const xml = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/H7/H7_Viztra.xml', import.meta.url), 'utf8');
const entry = new URL('../client/.formula-notebook-test.html', import.meta.url);
const module = new URL('../client/.formula-notebook-test.tsx', import.meta.url);
await writeFile(entry, '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/.formula-notebook-test.tsx"></script></body></html>');
await writeFile(module, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import {buildSignalGraph} from './src/utils/signalGraph';
import {useFlowStore} from './src/store/flowStore';
import './src/App.css';
const doc=new DOMParser().parseFromString(${JSON.stringify(xml)},'application/xml');
if(doc.querySelector('parsererror')) throw Error('H7 XML parser error');
const groups=new Set(['sum','product','and','or','min','max','avg','roundmultiple']);
const binary=new Set(['difference','quotient','pow','mod','gt','lt','ge','le','eq','nq']);
const parse=e=>{
  const kind=e.tagName,c=[...e.children].map(parse);
  if(kind==='value')return {kind,value:Number(e.textContent.trim())};
  if(kind==='property'||kind==='function_ref')return {kind,name:e.textContent.trim()};
  if(groups.has(kind))return {kind,children:c};
  if(binary.has(kind))return kind==='pow'?{kind,base:c[0],exponent:c[1]}:{kind,left:c[0],right:c[1]};
  if(kind==='atan2')return {kind,y:c[0],x:c[1]};
  if(kind==='ifthen')return {kind,cond:c[0],then:c[1],else:c[2]};
  if(kind==='switch')return {kind,index:c[0],cases:c.slice(1,-1),default:c.at(-1)};
  return c.length?{kind,child:c[0]}:{kind};
};
const funcs=[...doc.documentElement.children].filter(e=>e.tagName==='function');
const components=[...doc.documentElement.children].filter(e=>e.tagName==='channel').map(channel=>({
  name:channel.getAttribute('name'),items:[...channel.children].map(item=>({
    type:item.tagName,name:item.getAttribute('name'),componentProps:Object.fromEntries([...item.children].map(child=>[child.tagName,{value:child.textContent.trim(),attrs:{}}]))
  }))
}));
const channels=[...components,{name:'__JSBSIM_SYSTEM_TOP_LEVEL_FUNCTIONS__',items:funcs.map(f=>({type:'function',name:f.getAttribute('name'),expression:parse(f.children[0])}))}];
const original=buildSignalGraph(channels);
useFlowStore.setState({xmlFiles:[{id:'test',path:'systems/H7_Viztra.xml',category:'system',originalXml:${JSON.stringify(xml)},currentXml:${JSON.stringify(xml)},dirty:false}]});
window.__changes=0;window.__layouts=0;window.__originalPositions=Object.fromEntries(original.nodes.map(n=>[n.id,n.position]));
window.__xmlInputs=Object.fromEntries([
  ...funcs.map(f=>[f.getAttribute('name'),[...new Set([...f.querySelectorAll('property')].map(p=>p.textContent.trim()))]]),
  ...[...doc.querySelectorAll('channel > integrator')].map(e=>[e.getAttribute('name'),[e.querySelector('input')?.textContent.trim()]])
]);
createRoot(document.getElementById('root')).render(<ModuleExpressionCanvas mode="signal" embedded
  title="H7_Viztra.xml · 系统信号流" channels={channels} initialLayout={window.__originalPositions}
  onBack={()=>{}} onChannelsChange={chs=>{window.__changes++;window.__lastChannels=chs}} onLayoutChange={()=>window.__layouts++}/>);
`);
const profile = await mkdtemp(path.join(tmpdir(), 'formula-h7-chrome-'));
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], {stdio: ['ignore', 'ignore', 'pipe']});
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Chrome startup timeout')), 15000);
    let output = '';
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    chrome.once('exit', code => { clearTimeout(timeout); reject(Error(`Chrome exited ${code}`)); });
  });
  const targets = await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json());
  const page = targets.find(t => t.type === 'page');
  assert.ok(page);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once:true}));
  let serial = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') console.error(message.params.exceptionDetails);
    if (!pending.has(message.id)) return;
    const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  function send(method, params={}) {
    const id = ++serial;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {pending.delete(id); reject(Error(`CDP timeout ${method}`));}, 15000);
      pending.set(id,{resolve,reject,timer});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression) {
    const answer=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(answer.exceptionDetails)throw Error(JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  }
  async function until(expression) {
    for(let i=0;i<120;i++){
      if(await evaluate(`Boolean(${expression})`))return;
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error(`UI timeout: ${expression} ${await evaluate('document.body.innerText')}`);
  }
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1200,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:baseUrl+'/.formula-notebook-test.html'});
  await until('document.querySelectorAll(".react-flow__node").length > 60');
  const before=await evaluate('document.querySelectorAll(".react-flow__node").length');
  const positions=await evaluate(`Object.fromEntries([...document.querySelectorAll('.react-flow__node')].map(n=>[n.dataset.id,n.style.transform]))`);
  await evaluate('document.querySelector(".formula-view-toggle").click()');
  await until('document.querySelectorAll(".formula-sheet").length === 42');
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__node").length'),before,'Original canvas stays mounted');
  assert.equal(await evaluate('document.querySelector(".expr-editor-main--formula .react-flow") !== null'),true);
  const checks=await evaluate(`(() => {
    const cards=[...document.querySelectorAll('.formula-sheet')];
    const errors=[];
    for(const card of cards){
      const name=card.querySelector('.formula-path').textContent;
      const declared=window.__xmlInputs[name];
      const shown=[...card.querySelectorAll('.formula-inputs code')].map(x=>x.textContent);
      if(JSON.stringify(shown)!==JSON.stringify(declared))errors.push({name,shown,declared});
      if(!card.querySelector('.formula-line.result')||/undefined|NaN|∅/.test(card.querySelector('.formula-equations').textContent))errors.push({name,formula:'incomplete'});
    }
    const pitch=cards.find(card=>card.querySelector('.formula-path').textContent==='px4/viztra/camera-pitch-rad');
    return {count:cards.length,errors,pitchLines:pitch?.querySelectorAll('.formula-line').length,
      pitchText:pitch?.querySelector('.formula-equations').textContent,pitchInputs:pitch?.querySelectorAll('.formula-inputs code').length};
  })()`);
  assert.deepEqual(checks.errors,[],'Every H7 formula shows its complete original property references');
  assert.ok(checks.pitchLines>=7 && checks.pitchText.includes('π / 180'));
  assert.equal(checks.pitchInputs,3,'Repeated pitch-min-deg uses one named input twice');
  const firstShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/formula-h7-overview.png',Buffer.from(firstShot.data,'base64'));
  await evaluate(`(() => {const field=document.querySelector('#formula-search');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(field,'camera-pitch-rad');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".formula-sheet").length < 40');
  const filtered=await evaluate('document.querySelectorAll(".formula-sheet").length');
  assert.ok(filtered>0 && filtered<42,'Search narrows formulas');
  assert.equal(await evaluate(`[...document.querySelectorAll('.formula-sheet')].find(card=>card.querySelector('.formula-path')?.textContent==='px4/viztra/camera-pitch-rad')?.querySelector('.formula-sheet-number')?.textContent`),'18','Filtering retains XML formula numbering');
  await evaluate(`[...document.querySelectorAll('.formula-sheet')].find(card=>card.querySelector('.formula-path')?.textContent==='px4/viztra/camera-pitch-rad')?.scrollIntoView({block:'start'})`);
  const pitchShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/formula-h7-camera-pitch.png',Buffer.from(pitchShot.data,'base64'));
  await evaluate(`(() => {const field=document.querySelector('#formula-search');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(field,'position/h-sl-meters');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`document.querySelectorAll('.formula-sheet').length > 0 && [...document.querySelectorAll('.formula-sheet')].every(card => card.querySelector('.formula-input-match code')?.textContent === 'position/h-sl-meters')`);
  assert.ok(await evaluate('document.querySelectorAll(".formula-sheet").length') < 42,
    'Searching an existing input variable shows only formulas that reference it');
  await evaluate('document.querySelector(".formula-view-toggle").click()');
  await until('!document.querySelector(".formula-notebook")');
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__node").length'),before,'Switching back keeps canvas and nodes');
  assert.deepEqual(await evaluate(`Object.fromEntries([...document.querySelectorAll('.react-flow__node')].map(n=>[n.dataset.id,n.style.transform]))`),positions,'Switching views preserves every node position');
  assert.equal(await evaluate('window.__changes'),0,'Formula view never edits the model');
  await evaluate('document.querySelector(".formula-view-toggle").click()');
  await until('document.querySelector(".formula-create")');
  await evaluate('document.querySelector(".formula-create").click()');
  await until('document.querySelector(".formula-edit-card math-field")');
  assert.equal(await evaluate('customElements.get("math-field") !== undefined'),true,'MathLive custom element is loaded');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.formula-edit-card .mathlive-operator-toolbar button')].map(button=>button.textContent)`),
    ['+','−','×','分式','min','max','sin','⌨ 键盘'],'MathLive exposes the operator buttons and keyboard trigger');
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-keyboard-trigger').click()`);
  await until('document.querySelector(".mathlive-keyboard-popup:not([hidden]) .ML__keyboard.is-visible")');
  const keyboardPopup=await evaluate(`(() => {
    const popup=document.querySelector('.mathlive-keyboard-popup');
    const field=document.querySelector('.formula-edit-card math-field');
    const p=popup.getBoundingClientRect(), f=field.getBoundingClientRect();
    return {popup:{left:p.left,top:p.top,right:p.right,bottom:p.bottom,width:p.width},field:{top:f.top,bottom:f.bottom},
      keys:popup.querySelectorAll('.MLK__keycap').length,bodyPadding:document.body.style.paddingBottom};
  })()`);
  assert.ok(keyboardPopup.keys > 20,'The popup retains the complete MathLive keyboard');
  assert.ok(keyboardPopup.popup.width < 900 && keyboardPopup.popup.left >= 0 && keyboardPopup.popup.right <= 1920,
    'The keyboard is a bounded popup inside the viewport');
  assert.equal(keyboardPopup.bodyPadding,'','Opening the keyboard does not resize the page');
  const keyboardShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/formula-h7-keyboard-popup.png',Buffer.from(keyboardShot.data,'base64'));
  await evaluate(`document.querySelector('[aria-label="关闭公式键盘"]').click()`);
  await until('document.querySelector(".mathlive-keyboard-popup[hidden]")');
  await send('Emulation.setDeviceMetricsOverride',{width:1025,height:768,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-keyboard-trigger').click()`);
  await until('document.querySelector(".mathlive-keyboard-popup:not([hidden])")');
  const narrowPopup=await evaluate(`(() => {const r=document.querySelector('.mathlive-keyboard-popup').getBoundingClientRect();
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};})()`);
  assert.ok(narrowPopup.left >= 0 && narrowPopup.top >= 0 && narrowPopup.right <= 1025 && narrowPopup.bottom <= 768,
    'The popup stays inside a smaller desktop window');
  await evaluate(`document.querySelector('[aria-label="关闭公式键盘"]').click()`);
  await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1200,deviceScaleFactor:1,mobile:false});
  await evaluate(`(() => {const input=document.querySelector('.formula-edit-card .signal-path-input > input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,'test/new-formula');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-editor > button').click()`);
  await until('document.querySelectorAll(".formula-edit-card .mathlive-signals .signal-path-input").length === 1');
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-signals .signal-path-trigger').click()`);
  await until('document.querySelector(".signal-path-menu")');
  assert.ok(await evaluate('document.querySelectorAll(".signal-path-results > button").length') > 10,'Global XML signal index is populated');
  await evaluate(`(() => {const search=document.querySelector('.signal-path-menu input');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(search,'position/h-sl-meters');search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".signal-path-results > button").length > 0');
  await evaluate(`document.querySelector('.signal-path-results > button').click()`);
  await evaluate(`(() => {const field=document.querySelector('.formula-edit-card math-field');
    field.value='';document.querySelector('[aria-label="插入分式"]').click();})()`);
  assert.match(await evaluate('document.querySelector(".formula-edit-card math-field").value'),/\\frac/,
    'Fraction button inserts a MathLive template');
  await evaluate(`(() => {const field=document.querySelector('.formula-edit-card math-field');
    field.value='u_{1}';field.executeCommand('moveToMathfieldEnd');})()`);
  const plusPoint=await evaluate(`(() => {const r=document.querySelector('[aria-label="插入加"]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:plusPoint.x,y:plusPoint.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:plusPoint.x,y:plusPoint.y,button:'left',clickCount:1});
  await evaluate(`(() => {const field=document.querySelector('.formula-edit-card math-field');
    field.insert('2');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const editShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/formula-h7-mathlive-edit.png',Buffer.from(editShot.data,'base64'));
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-actions button:last-child').click()`);
  await until('window.__changes > 0');
  const created=await evaluate(`(() => {const all=window.__lastChannels.flatMap(ch=>ch.items);
    return all.find(item=>item.name==='test/new-formula') || null})()`);
  assert.deepEqual(created?.expression,{kind:'sum',children:[{kind:'property',name:'position/h-sl-meters'},{kind:'value',value:2}]});
  await until('!document.querySelector(".formula-edit-card")');
  await evaluate('document.querySelector(".formula-create").click()');
  await until('document.querySelector(".formula-edit-card math-field")');
  assert.ok(await evaluate('document.querySelectorAll(".formula-edit-card .mathlive-symbol-toolbar button").length') >= 16,
    'Common aviation Latin and Greek symbols are available');
  await evaluate(`document.querySelector('[aria-label="插入滚转角 φ"]').click()`);
  await until('document.querySelector(".formula-edit-card .mathlive-symbol-binding label")?.textContent === "φ"');
  await evaluate(`(() => {const field=document.querySelector('.formula-edit-card math-field');
    field.value=${JSON.stringify('\\phi+x')};field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".formula-edit-card .mathlive-symbol-binding").length === 2');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.formula-edit-card .mathlive-symbol-binding label')].map(label=>label.textContent)`),
    ['φ','x'],'Typed aviation symbols automatically get signal binding rows');
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-actions button:last-child').click()`);
  await until('document.querySelector(".formula-edit-card .mathlive-error")?.textContent.includes("φ")');
  await evaluate(`(() => {const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const name=document.querySelector('.formula-edit-card > .signal-path-input > input');
    setter.call(name,'test/aero-symbol');name.dispatchEvent(new Event('input',{bubbles:true}));
    const inputs=[...document.querySelectorAll('.formula-edit-card .mathlive-symbol-binding .signal-path-input > input')];
    for(const [input,value] of inputs.map((input,index)=>[input,['attitude/phi-rad','position/h-sl-meters'][index]])) {
      setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  const symbolsShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/formula-h7-aviation-symbols.png',Buffer.from(symbolsShot.data,'base64'));
  await evaluate(`document.querySelector('.formula-edit-card .mathlive-actions button:last-child').click()`);
  await until('window.__changes > 1');
  const aeroCreated=await evaluate(`window.__lastChannels.flatMap(ch=>ch.items).find(item=>item.name==='test/aero-symbol')?.expression`);
  assert.deepEqual(aeroCreated,{kind:'sum',children:[{kind:'property',name:'attitude/phi-rad'},{kind:'property',name:'position/h-sl-meters'}]},
    'Aviation symbols resolve to selected signal paths when saved');
  console.log(JSON.stringify({model:'H7_Viztra.xml',formulas:checks.count,functions:40,integrators:2,pitchLines:checks.pitchLines,shownPitchInputs:checks.pitchInputs,searchResults:filtered,canvasNodes:before,newFormula:created.name,aeroFormula:'test/aero-symbol',modelChanges:await evaluate('window.__changes')},null,2));
} finally {
  ws?.close(); chrome.kill('SIGTERM');
  if (chrome.exitCode === null) await new Promise(resolve => {
    chrome.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
  await Promise.all([rm(entry,{force:true}),rm(module,{force:true}),
    rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200})]);
}
