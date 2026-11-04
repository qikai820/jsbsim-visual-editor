// Browser regression for committed live edits and continuous scope history; no hardware.
import assert from 'node:assert/strict';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const base=process.argv[2]||'http://127.0.0.1:5196';
const vite=process.argv[2]?null:spawn('npx',['vite','--host','127.0.0.1','--port','5196'],{stdio:'ignore'});
for(let attempt=0;attempt<100;attempt++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
const html=new URL('../client/.runtime-tuning-test.html',import.meta.url),module=new URL('../client/.runtime-tuning-test.tsx',import.meta.url);
await writeFile(html,'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/.runtime-tuning-test.tsx"></script></body></html>');
await writeFile(module,`
import React from 'react';import{createRoot}from'react-dom/client';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import RuntimeTuningPanel from './src/components/RuntimeTuningPanel';
import ScopeWindow from './src/components/monitor/ScopeWindow';
import {useFlowStore as flow} from './src/store/flowStore';
import {useRuntimeTuningStore as tuning} from './src/store/runtimeTuningStore';
import {useSignalMonitorStore as monitor,monitorRecord} from './src/store/signalMonitorStore';
import {componentParameterKey,expressionParameters}from'./src/sim/runtimeParameters';
import './src/App.css';import './src/components/monitor/monitor.css';
import {installDialogDragging}from'./src/utils/dialogDragging';installDialogDragging();
const channels=[{name:'Live',items:[{type:'pure_gain',name:'test/gain',componentProps:{input:{value:'test/input'},gain:{value:'2'},clipto_min:{value:'-10'},clipto_max:{value:'10'}}},{type:'constant',name:'test/constant',componentProps:{constant:{value:'3'}}}]}];
flow.getState().loadProject({aircraft:{name:'test'},nodes:[{id:'fcs',type:'aircraftComponent',position:{x:0,y:0},data:{label:'FCS',componentType:'flight_control',params:{name:'FCS',channels:JSON.stringify(channels)}}}],edges:[]});
window.__flow=flow;window.__tuning=tuning;window.__monitor=monitor;window.__record=monitorRecord;
window.__gainKey=componentParameterKey('test/gain','gain');window.__constantKey=expressionParameters('test/constant',{kind:'value',value:3})[0].key;
window.__values={[window.__gainKey]:2,[window.__constantKey]:3};
monitor.setState({revisions:{'01':1}});const scope=monitor.getState().addScope('module-live',{x:400,y:100},[{key:'test/gain',label:'gain'}]);monitor.setState({openScope:scope});
let tick=0;setInterval(()=>{tick++;monitor.getState().ingest({instance_id:'01',model:'test',tree_generation:1,timestamp:50+tick*.02,state:'running',monitor:{version:1,revision:1,sequence:tick,samples:{'test/gain':[window.__values[window.__gainKey]*2,50+tick*.02,false]}}});},20);
function Harness(){const nodes=flow(s=>s.nodes);return <><ModuleExpressionCanvas mode="signal" embedded modelId="module-live" title="实时调参测试" channels={JSON.parse(nodes[0].data.params.channels)} baselineChannels={channels} onBack={()=>{}} onChannelsChange={next=>flow.getState().updateNodeParams('fcs',{channels:JSON.stringify(next)})}/><RuntimeTuningPanel/><ScopeWindow/></>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
const profile=await mkdtemp(path.join(tmpdir(),'runtime-tuning-ui-'));
const chrome=spawn('/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let ws;
try {
 const endpoint=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(Error('Chrome timeout')),15000);chrome.stderr.on('data',chunk=>{stderr+=chunk;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
 const page=(await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json())).find(p=>p.type==='page');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 let next=0;const waiting=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const cb=waiting.get(message.id);waiting.delete(message.id);message.error?cb.reject(Error(JSON.stringify(message.error))):cb.resolve(message.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error(`Timeout ${expression}: ${await evaluate('JSON.stringify({state:window.__tuning?.getState(),calls:window.__calls,tauri:!!window.__TAURI_INTERNALS__,channels:window.__flow?.getState().nodes[0]?.data.params.channels,inputs:[...document.querySelectorAll(".comp-prop-panel input")].map(n=>n.value)})')} ${await evaluate('document.body.innerText')}`);};
 await send('Page.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`
 localStorage.setItem('jsbsim-language','zh-CN');window.__calls=[];window.__model='test';window.__reject='';window.__started=Date.now();
 const snapshot=()=>({model:window.__model,state:'running',timestamp:50+(Date.now()-window.__started)/1000,age_ms:0,tuning:{version:1,session:'0123456789abcdef',request:0,status:'',values:[]}});
 window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},invoke:async(command,args)=>{
  if(command==='sim_runtime_snapshot')return snapshot();
  window.__calls.push({command,args});
  if(command==='sim_runtime_apply'){if(window.__reject)throw window.__reject;for(const edit of args.edits)window.__values[edit.key]=edit.value;return {...snapshot(),tuning:{...snapshot().tuning,status:'applied',values:args.edits.map(e=>e.value)}};}
  throw Error('Unexpected IPC '+command);
 }};`});
 await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:`${base}/.runtime-tuning-test.html`});
 await until('Boolean(window.__tuning?.getState().snapshot) && Boolean(document.querySelector("[data-testid=scope-waveform]"))');
 await evaluate(`document.querySelector('.react-flow__node[data-id="c-0-0"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
 await until('Boolean(document.querySelector(".comp-prop-panel"))');
 const edit=async(value,blur=true)=>{
   await evaluate(`(()=>{const row=[...document.querySelectorAll('.comp-prop-panel .field-row')].find(row=>row.textContent.includes('增益 gain')),input=row.querySelector('input');input.focus();input.select();})()`);
   await send('Input.insertText',{text:String(value)});
   if(blur){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
 };
 assert.equal(await evaluate(`(()=>{const input=[...document.querySelectorAll('.comp-prop-panel .field-row')].find(row=>row.textContent.includes('增益 gain')).querySelector('input'),r=input.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input;})()`),true,'scope leaves the parameter panel interactive');
 const scopePosition=await evaluate(`(()=>{const r=document.querySelector('[data-testid=scope-window]').getBoundingClientRect();return{x:r.x,y:r.y};})()`);
 const handle=await evaluate(`(()=>{const r=document.querySelector('.monitor-window-grip').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 await send('Input.dispatchMouseEvent',{type:'mousePressed',...handle,button:'left',buttons:1,clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x+30,y:handle.y+25,button:'left',buttons:1});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x+30,y:handle.y+25,button:'left',buttons:0,clickCount:1});
 assert.ok(await evaluate(`document.querySelector('[data-testid=scope-window]').getBoundingClientRect().x>${scopePosition.x}+20`),'scope can be moved while recording');
 const first=await evaluate(`window.__record('01','test/gain').firstTime`);
 await edit(3,false);await new Promise(r=>setTimeout(r,350));
 assert.equal(await evaluate('window.__calls.length'),0,'typing a draft never changes the running model');
 await evaluate(`document.activeElement.blur()`);await until('window.__tuning.getState().applied===1');
 assert.equal(await evaluate('window.__values[window.__gainKey]'),3);
 assert.equal(await evaluate(`window.__record('01','test/gain').firstTime`),first,'live edits keep existing scope history');
 assert.equal(await evaluate(`window.__monitor.getState().running['01'].generation`),'test:1');
 await evaluate(`window.__monitor.setState({openScope:window.__monitor.getState().project.scopes[0].id})`);
 await until(`Boolean(document.querySelector('[data-testid=scope-waveform]'))`);
 const preview=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/jsbsim-runtime-tuning-ui.png',Buffer.from(preview.data,'base64'));
 await evaluate(`window.__monitor.setState({openScope:null})`);
 await evaluate(`document.querySelector('.runtime-tuning-panel input').click()`);await edit(4);await new Promise(r=>setTimeout(r,500));
 assert.equal(await evaluate('window.__calls.length'),1,'disabled live tuning retains edits without sending');
 await evaluate(`document.querySelector('.runtime-tuning-panel input').click()`);await edit(5);await until('window.__tuning.getState().applied===2');
 const select=async name=>{await evaluate(`(()=>{const node=[...document.querySelectorAll('.react-flow__node')].find(node=>node.querySelector('.diagram-block')?.title.startsWith(${JSON.stringify(name)}));node.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);};
 const setField=async(label,value)=>{await evaluate(`(()=>{const row=[...document.querySelectorAll('.comp-prop-panel .field-row')].find(row=>row.textContent.includes(${JSON.stringify(label)})),input=row.querySelector('input');input.focus();input.select();})()`);await send('Input.insertText',{text:String(value)});await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
 await select('test/constant');await setField('常数值',9);await until('window.__tuning.getState().applied===3');
 assert.equal(await evaluate('window.__values[window.__constantKey]'),9,'constant block commits live');
 await select('test/gain');await setField('限幅下限',-5);await until('window.__tuning.getState().applied===5');
 assert.equal(await evaluate('window.__calls.at(-1).args.edits.length'),2,'limit bounds share one transaction');
 await evaluate(`window.__flow.getState().addNode('environment',{x:10,y:10});const node=window.__flow.getState().nodes.find(n=>n.data.componentType==='environment');window.__flow.getState().updateNodeParams(node.id,{wind_north_fps:12})`);await until('window.__tuning.getState().applied===6');
 assert.equal(await evaluate(`window.__values['atmosphere/wind-north-fps']`),12,'environment card commits live');
 await evaluate(`window.__reject='invalid_limits'`);await edit(6);await until('window.__tuning.getState().error');
 assert.equal(await evaluate('window.__values[window.__gainKey]'),5,'rejected updates are not reported as applied');
 assert.equal(await evaluate(`JSON.parse(window.__flow.getState().nodes[0].data.params.channels)[0].items.find(item=>item.name==='test/gain').componentProps.gain.value`),'6','failed edits remain available to save or correct');
 await evaluate(`window.__model='other';window.__reject=''`);await until(`window.__tuning.getState().snapshot.model==='other'`);
 await edit(7);await until(`window.__tuning.getState().message.includes('不匹配')`);
 assert.equal(await evaluate('window.__calls.length'),6,'a different running model cannot be tuned accidentally');

 console.log('PASS: Enter/blur live gain, constant, paired limits, environment, scope continuity, disable, rejection, retained save values and model isolation');
}finally{ws?.close();chrome.kill('SIGTERM');vite?.kill('SIGTERM');await Promise.all([rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100}),rm(html,{force:true}),rm(module,{force:true})]);}
