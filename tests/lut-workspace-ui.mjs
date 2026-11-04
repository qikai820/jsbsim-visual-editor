// Real Chromium coverage of the LUT editor and its signal-canvas entry point.
// IPC is isolated; no simulator writes. Run against Vite with Node 20
// --experimental-websocket tests/lut-workspace-ui.mjs [base URL].
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5174';
const name = `.lut-workspace-test-${process.pid}`;
const entry = new URL(`../client/${name}.html`,import.meta.url);
const module = new URL(`../client/${name}.tsx`,import.meta.url);
const table = {kind:'table',tableType:'3D',var1:'aero/alpha-rad',var2:'fcs/elevator-pos-rad',var3:'velocities/mach',
  breakpoints1:[-.3,-.2,-.1,0,.1,.2,.3],breakpoints2:[-.5,-.25,0,.25,.5],breakpoints3:[0,.3,.6,.9],data:[]};
for(let z=0;z<4;z++) for(const x of table.breakpoints1) table.data.push(table.breakpoints2.map(y=>Number(((3*x+1.4*y)*(1+.3*z)+.9*x*y).toFixed(6))));
const plane={...table,tableType:'2D',var3:'',breakpoints3:[],data:table.data.slice(0,7)};
const expression={kind:'product',children:[{kind:'value',value:2},table,plane]};
await writeFile(entry,`<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
await writeFile(module,`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import LutTablePreview from './src/components/expression/LutTablePreview';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import {buildSignalGraph} from './src/utils/signalGraph';
import './src/App.css';
const initial=${JSON.stringify(expression)};
const channels=[{name:'LUT test',items:[{type:'function',name:'fcs/multiple-tables',expression:initial}]}];
const layout=Object.fromEntries(buildSignalGraph(channels).nodes.map(node=>[node.id,node.position]));
function Harness(){const[expr,setExpr]=useState(initial),[open,setOpen]=useState(true),[canvas,setCanvas]=useState(false),[version,setVersion]=useState(0);
window.__open=(expression=initial)=>{setCanvas(false);setExpr(expression);setVersion(value=>value+1);setOpen(true);};window.__canvas=()=>{setOpen(false);setCanvas(true);};
return canvas?<ModuleExpressionCanvas mode="signal" embedded title="LUT integration" channels={channels} initialLayout={layout}
 onBack={()=>{}} onChannelsChange={next=>{window.__channels=next;}}/>:<>{open&&<LutTablePreview key={version} title="aero/coefficient/CL · 多维插值数据" expression={expr}
onChange={next=>{window.__applied=next;setExpr(next);}} onClose={()=>setOpen(false)}/>}</>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
const profile=await mkdtemp(path.join(tmpdir(),'lut-ui-chrome-'));
const chrome=spawn('/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let ws;
try {
 const endpoint=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Chrome timeout')),15000);chrome.stderr.on('data',chunk=>{out+=chunk;const match=out.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
 const targets=await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json());
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 let sequence=0;const pending=new Map(),exceptions=[];
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout ${method}`));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,70));}throw Error(`UI timeout ${expression}\n${await evaluate('document.body.innerText')}`);};
 const input=async(selector,value)=>{
   await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
   await send('Input.insertText',{text:value});
   await evaluate(`document.querySelector(${JSON.stringify(selector)}).blur()`);
 };
 const select=async(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const click=async selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const screenshot=async file=>{const result=await send('Page.captureScreenshot',{format:'png'});await writeFile(file,Buffer.from(result.data,'base64'));};
 const cell='[data-lut-cell="0-0"]';
 await send('Page.enable');await send('Runtime.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('jsbsim-language','zh-CN');window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async()=>({})};`});
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:`${baseUrl}/${name}.html`});
 await until(`document.querySelector('[data-surface-face]')`);
 await screenshot('/tmp/jsbsim-lut-3d-editor.png');
 // A finite precision edit is local until Apply; switching layers shows actual data.
 await input(cell,'1.23456789012345e-5');
 assert.equal(await evaluate('window.__applied'),undefined);
 await select('[aria-label="当前切片"]',1);
 await until(`document.querySelector('${cell}').value === '${table.data[7][0]}'`);
 await select('[aria-label="固定切片轴"]',0);
 assert.equal(await evaluate(`document.querySelectorAll('.lut-edit-grid tbody tr').length`),5);
 assert.equal(await evaluate(`document.querySelectorAll('.lut-edit-grid tbody tr:first-child td').length`),4);
 // Editing a transposed view targets the correct original 3D coordinate.
 await input('[data-lut-cell="1-2"]','77.123456789');
 await select('[aria-label="固定切片轴"]',2);
 await select('[aria-label="当前切片"]',2);
 await until(`Math.abs(Number(document.querySelector('[data-lut-cell="0-1"]').value) - 77.123456789) < .001`);
 // Multi-cell clipboard paste and invalid-paste rejection.
 await evaluate(`(()=>{const el=document.querySelector('${cell}');const data=new DataTransfer();data.setData('text/plain','1e-3\\t2\\n3\\t4');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));})()`);
 await until(`document.querySelector('[data-lut-cell="1-1"]').value === '4'`);
 await evaluate(`(()=>{const el=document.querySelector('${cell}');const data=new DataTransfer();data.setData('text/plain','1\\tNaN');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));})()`);
 await until(`document.querySelector('.lut-paste-message').textContent.includes('失败')`);
 assert.equal(await evaluate(`document.querySelector('${cell}').value`),'0.001');
 // Header editing validates strict ordering before application.
 await input('[aria-label="行断点 2"]','-0.3');
 await until(`document.querySelector('.lut-validation')?.textContent.includes('严格递增')`);
 assert.equal(await evaluate(`document.querySelector('.lut-apply-button').disabled`),true);
 await input('[aria-label="行断点 2"]','-0.2');
 await click('[aria-label="添加行断点"]');
 assert.equal(await evaluate(`document.querySelectorAll('.lut-edit-grid tbody tr').length`),8);
 await click('[aria-label="删除选中行断点"]');
 assert.equal(await evaluate(`document.querySelectorAll('.lut-edit-grid tbody tr').length`),7);
 // Rotate using real pointer events, then switch to heatmap and select a cell.
 const camera=await evaluate(`(()=>{const r=document.querySelector('.lut-chart-svg').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 const beforeRotate=await evaluate(`document.querySelector('[data-surface-face]').getAttribute('points')`);
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:camera.x,y:camera.y,button:'left',clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:camera.x+65,y:camera.y+20,buttons:1});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:camera.x+65,y:camera.y+20,button:'left'});
 assert.notEqual(await evaluate(`document.querySelector('[data-surface-face]').getAttribute('points')`),beforeRotate);
 await evaluate(`[...document.querySelectorAll('.lut-view-tabs button')].find(el=>el.textContent==='热力图').click()`);
 await evaluate(`document.querySelectorAll('.lut-chart-svg g[role=button]')[6].dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
 await until(`document.querySelector('[data-selected=true] input').dataset.lutCell === '1-1'`);
 await screenshot('/tmp/jsbsim-lut-heatmap-editor.png');
 // Multiple tables retain their own edits and do not replace their siblings.
 await evaluate(`document.querySelectorAll('.lut-table-switcher button')[1].click()`);
 await input(cell,'-99.5');
 await evaluate(`document.querySelectorAll('.lut-table-switcher button')[0].click()`);
 await until(`document.querySelector('.lut-workspace-dimension').textContent.includes('3D')`);
 await click('.lut-apply-button');
 await until('window.__applied');
 const applied=await evaluate('window.__applied');
 assert.equal(applied.children[1].data[0][0],.0000123456789012345);
 assert.equal(applied.children[1].data[14][0],.001);
 assert.equal(applied.children[1].data[15][1],4);
 assert.equal(applied.children[2].data[0][0],-99.5);
 assert.equal(applied.children[0].value,2);
 // Frontend XML preserves the third variable and full precision too.
 const roundtrip=await evaluate(`(async()=>{const{expressionToXmlText,parseXmlText}=await import('/src/utils/expressionXml.ts');return parseXmlText(expressionToXmlText(window.__applied));})()`);
 assert.deepEqual(roundtrip,applied);
 // Invalid draft text cannot be applied; reset and Cancel never emit changes.
 await evaluate(`window.__open(${JSON.stringify(table)})`);
 await until(`document.querySelector('${cell}')`);
 await input(cell,'-');
 await input('[data-lut-cell="0-1"]','123');
 await click('.lut-apply-button');
 assert.ok(await evaluate(`document.querySelector('.lut-workspace-footer').textContent.includes('无效数值')`));
 await evaluate(`[...document.querySelectorAll('.lut-workspace-footer button')].find(el=>el.textContent==='重置修改').click()`);
 await until(`document.querySelector('.lut-apply-button').disabled`);
 assert.deepEqual(await evaluate('window.__applied'),applied);
 assert.equal(await evaluate(`document.querySelector('[aria-invalid=true]')`),null,'Reset also clears invalid text');
 await input(cell,'999');
 await evaluate(`[...document.querySelectorAll('.lut-workspace-footer button')].find(el=>el.textContent==='取消').click()`);
 assert.deepEqual(await evaluate('window.__applied'),applied);
 // The 1D replacement retains small coefficients and links curve points.
 const line={...table,tableType:'1D',var2:'',var3:'',breakpoints2:[],breakpoints3:[],data:table.breakpoints1.map((_,i)=>[i?i*.01:1.23456789e-8])};
 await evaluate(`window.__open(${JSON.stringify(line)})`);
 await until(`document.querySelector('.lut-chart-point')`);
 assert.equal(await evaluate(`document.querySelector('${cell}').value`),'1.23456789e-8');
 await evaluate(`document.querySelectorAll('.lut-chart-point')[2].dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
 await until(`document.querySelector('[data-selected=true] input').dataset.lutCell==='2-0'`);
 const constant={...plane,data:plane.data.map(row=>row.map(()=>5))};
 await evaluate(`window.__open(${JSON.stringify(constant)})`);
 await until(`document.querySelector('[data-surface-face]')`);
 assert.equal(await evaluate(`/NaN|Infinity/.test(document.querySelector('.lut-chart-svg').outerHTML)`),false);
 // Responsive dialog remains inside viewport with a single-column workspace.
 await evaluate('window.__open()');await until(`document.querySelector('[data-surface-face]')`);
 await send('Emulation.setDeviceMetricsOverride',{width:720,height:900,deviceScaleFactor:1,mobile:false});
 await until(`getComputedStyle(document.querySelector('.lut-workspace-content')).gridTemplateColumns.split(' ').length===1`);
 const bounds=await evaluate(`(()=>{const r=document.querySelector('.lut-workspace-dialog').getBoundingClientRect();return{x:r.x,right:r.right,bottom:r.bottom};})()`);
 assert.ok(bounds.x>=0&&bounds.right<=720&&bounds.bottom<=900);
 await screenshot('/tmp/jsbsim-lut-narrow-editor.png');
 // Actual graph entry: double-click the SECOND product table and edit only it.
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
 await evaluate('window.__canvas()');
 await until(`document.querySelector('[data-id="c-0-0/table-2"]')`);
 await evaluate(`document.querySelector('[data-id="c-0-0/table-2"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
 await until(`document.querySelector('.lut-workspace-dialog')`);
 assert.ok(await evaluate(`document.querySelector('.lut-workspace-dimension').textContent.includes('2D')`));
 await input(cell,'42.5');await click('.lut-apply-button');
 await until('window.__channels');
 const saved=await evaluate('window.__channels[0].items[0].expression');
 assert.equal(saved.children[2].data[0][0],42.5);
 assert.deepEqual(saved.children[1],table,'editing a derived LUT node preserves the first table');
 assert.deepEqual(exceptions,[],'No browser runtime exceptions');
 console.log('PASS: real 3D rotation, heatmap/grid linking, arbitrary-axis slices, precision edits, paste rejection, breakpoint validation, axis resize, Apply/Cancel, nested tables, frontend XML round-trip, narrow layout, and editing the correct canvas table.');
} finally {
 ws?.close();const stopped=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill('SIGTERM');await stopped;
 await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(entry,{force:true});await rm(module,{force:true});
}
