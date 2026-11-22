// Real workbench/source button; all controller operations are isolated IPC mocks.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const setup=`window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(c,a)=>window.native(c,a)};`;
const source=`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import Workbench from './src/components/Px4FlightTest';import{useFlightTestStore}from'./src/flight-test/session';import './src/App.css';import './src/components/Px4Toolbox.css';
window.store=useFlightTestStore;window.calls=[];window.before=0;
window.statusFailure=true;window.forwardingReady=new Promise(resolve=>{window.finishPin=resolve;});
window.source={selected:0,actual:0,ready:true,supported:true,switching:false,idleSending:false,feedbackAgeMs:20,reason:'输入来源与健康已确认'};
window.snapshot={id:0,status:'idle',name:'',dryRun:true,elapsed:0,realElapsed:0,rc:[0,0,0,0],activeBlocks:[],values:{},logs:[],exitResult:''};
window.native=async(command,args)=>{window.calls.push({command,args});
 if(command==='flight_test_status')return {...window.snapshot};
 if(command==='flight_test_rc_source_status'){if(window.statusFailure)throw Error('仿真机转发会话、来源或固定回传目标已失效');return {...window.source};}
 if(command==='flight_test_rc_source_select'){if(window.rejectSwitch)throw Error('输入源切换未确认');return new Promise(resolve=>{window.finishSwitch=()=>{window.source={...window.source,selected:args.source,actual:args.source,ready:true,idleSending:args.source===1};resolve({...window.source});};});}
 if(command==='flight_test_start'){window.snapshot={...window.snapshot,id:window.snapshot.id+1,status:'running',dryRun:args.options.dryRun};return {...window.snapshot};}
 if(command==='flight_test_stop'){window.snapshot={...window.snapshot,status:'stopped'};return {...window.snapshot};}
 return null;
};
function App(){const[armed,setArmed]=useState(false);window.setArmed=setArmed;return <div className="px4-toolbox" style={{width:'100%',height:650}}><Workbench link={{alive:true,hilEnabled:true,armed,ready:window.forwardingReady,target:{system:7,component:1},transport:{sessionId:42}}} instance={1} bidirectional={true} disabled={false} beforeRun={async()=>{window.before++;}}/></div>;}createRoot(document.getElementById('root')).render(<App/>);`;
const ui=await uiBrowser(source,{setup,port:5205,width:1120,height:740});
const {ev,until,click,send}=ui;
const button=`document.querySelector('.ft-rc-source')`;
const run=`Array.from(document.querySelectorAll('.ft-toolbar button')).find(b=>b.textContent==='执行飞控测试')`;
try{
 await until(`!!window.store?.getState().context?.link`);
 await new Promise(r=>setTimeout(r,200));
 const queriesBeforePin=await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_status').length`);
 await ev('window.finishPin()');
 await until(`document.body.innerText.includes('仿真机转发会话、来源或固定回传目标已失效')`);
 await ev('window.statusFailure=false');
 await until(`${button}?.textContent.includes('实体遥控器')`);
 assert(!await ev(`document.body.innerText.includes('仿真机转发会话、来源或固定回传目标已失效')`),'successful source readback clears a recovered polling error');
 assert.equal(queriesBeforePin,0,'source query waits for the native UDP peer pin');
 assert(await ev(`${run}.disabled`));
 await click(button);await until(`typeof window.finishSwitch==='function'`);
 assert(await ev(`${button}.disabled&&${button}.textContent.includes('正在切换')&&${run}.disabled`));
 assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').length`),1);
 assert.equal(await ev(`window.calls.find(c=>c.command==='flight_test_rc_source_select').args.source`),1);
 await ev('window.finishSwitch()');await until(`!${run}.disabled`);
 assert(await ev(`${button}.textContent.includes('工具箱模拟')&&${button}.textContent.includes('已确认')`));
 const image=await send('Page.captureScreenshot',{format:'png'});await writeFile('/home/qikai820/tmp/hil-rc-source-work/actual-source-button.png',Buffer.from(image.data,'base64'));
 await click(run);await until(`${button}.disabled&&window.snapshot.status==='running'`);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').length`),1);
 await click(`Array.from(document.querySelectorAll('.ft-statusbar button')).find(b=>b.textContent==='终止')`);await until(`!${button}.disabled`);
 await ev('window.setArmed(true)');await until(`${button}.disabled&&${button}.title.includes('已解锁')`);
 await ev('window.setArmed(false)');await until(`!${button}.disabled`);
 await ev('window.rejectSwitch=true');await click(button);await until(`document.body.innerText.includes('输入源切换未确认')`);
 await new Promise(r=>setTimeout(r,650));
 assert(await ev(`document.body.innerText.includes('输入源切换未确认')`),'a successful status query preserves an actual failed switch');
 assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').length`),2,'a failed switch is never retried');
 assert(await ev(`${button}.textContent.includes('工具箱模拟')`),'failed physical selection must not claim physical control');
 await ev(`window.source={...window.source,ready:false,actual:null,feedbackAgeMs:2400,reason:'输入源反馈过期'}`);
 await until(`${button}.textContent.includes('反馈过期')&&${run}.disabled`);
 await ev(`window.source={...window.source,selected:null,supported:false,reason:'旧固件不支持'}`);
 await until(`${button}.disabled&&${button}.textContent.includes('读取中')`);
 await ev(`window.rejectSwitch=false;window.source={...window.source,selected:1,supported:true,ready:false,idleSending:false,feedbackAgeMs:null,reason:'MAVLink 已选，点击启动工具箱模拟输入'}`);
 await until(`!${button}.disabled&&${button}.textContent.includes('待启用')&&${button}.textContent.includes('▶')`);
 const beforeEnable=await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').length`);
 await click(button);
 await until(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').length===${beforeEnable+1}`);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select').at(-1).args.source`),1,'enabling a selected but inactive toolbox source must not select physical RC');
 await ev('window.finishSwitch()');await until(`${button}.textContent.includes('已确认')&&!${run}.disabled`);
 for(const width of [680,360]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:740,deviceScaleFactor:1,mobile:false});
  assert(await ev(`document.querySelector('.ft-toolbar').scrollWidth<=document.querySelector('.ft-toolbar').clientWidth+1`),'toolbar wraps at width '+width+' '+JSON.stringify(await ev(`Array.from(document.querySelectorAll('.ft-toolbar,.ft-document,.ft-run-actions,.ft-run-actions>button,.ft-name,.ft-view-switch')).map(e=>({class:e.className,text:e.textContent,width:e.getBoundingClientRect().width,scroll:e.scrollWidth,wrap:getComputedStyle(e).flexWrap,min:getComputedStyle(e).minWidth,padding:getComputedStyle(e).padding,gap:getComputedStyle(e).gap}))`)));
 }
 assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));
 console.log('PASS peer-ready query ordering, recovered status errors, preserved switch failures, source feedback, one-shot switching, execution gates, armed/run locks, stale/missing feedback, responsive toolbar');
}finally{await ui.close();}
