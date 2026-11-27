// Real Toolbar, toolbox and flight scene with isolated IPC; no device I/O.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';
const document = { version:1, name:'视景并行姿态测试', aircraft:'MorphQuad', initialize:'reset', duration:120, rateHz:50, throttle:.5, clock:'realtime', onFinish:'hold', onAbort:'hold', blocks:[
  {id:'bm',type:'mode',p:{mode:'POSCTL',timeout:8}},
  {id:'bc',type:'assert',p:{field:'landed',op:'eq',value:0,timeout:3}},
  {id:'bp',type:'parallel',p:{join:'all',timeout:90},lanes:[[{id:'bl',type:'loop',p:{count:3},body:[{id:'ba',type:'attitude',p:{roll:0,pitch:10,hold:10,tolerance:3,rate:15,settle:.5,timeout:40}}]}],[{id:'bh',type:'altitude',p:{target:10,duration:60,tolerance:.2,hover:50,min:25,max:75,slew:25,response:8,damping:12,trim:1.5,deadzone:6}}]]},
  {id:'bw',type:'wait',p:{duration:10}},
] };
const setup = `localStorage.setItem('jsbsim-language','zh-CN');localStorage.setItem('px4-flight-test-workspace-v1',${JSON.stringify(JSON.stringify(document))});localStorage.setItem('jsbsim-scene-flight-test-display-v1','compact');
const callbacks=new Map();let callbackId=0;window.__events=new Map();window.__calls=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__={transformCallback(callback){const id=++callbackId;callbacks.set(id,callback);return id},unregisterCallback(id){callbacks.delete(id)},invoke:(command,args)=>{if(command==='plugin:event|listen'){const id=++callbackId;window.__events.set(args.event,{id,callback:callbacks.get(args.handler)});return Promise.resolve(id)}if(command==='plugin:event|unlisten'){return Promise.resolve()}return window.native(command,args)}};
window.__emit=(event,payload)=>{const item=window.__events.get(event);item?.callback({event,id:item.id,payload})};`;
const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Toolbar from './src/components/Toolbar';import FlightScene from './src/components/flight-scene/FlightScene';
import{openTestToolbox,useFlightTestStore}from'./src/flight-test/session';import{useSignalMonitorStore}from'./src/store/signalMonitorStore';import{encode}from'./src/px4/protocol';import './src/App.css';
window.store=useFlightTestStore;window.openTesting=()=>openTestToolbox(true);window.selectObserved=id=>useSignalMonitorStore.setState({instance:id});
window.router={simulator:'127.0.0.1',state:'running',config:{device:'/dev/ttyACM0',baud:921600,host:'127.0.0.1',qgc_port:14550,toolbox_port:14553},active_config:{device:'/dev/ttyACM0',baud:921600,host:'127.0.0.1',qgc_port:14550,toolbox_port:14553},routes:[]};
let channel,sessionId=0,seq=0,started=0;
window.snapshot={id:0,status:'idle',name:'',dryRun:true,elapsed:0,realElapsed:0,rc:[0,0,0,.5],activeBlocks:[],values:{},logs:[],exitResult:''};
const heartbeat=()=>{if(channel)channel.onmessage({kind:'data',sessionId,direction:'rx',timeMs:Date.now(),elapsedUs:1,peer:'127.0.0.1:40000',datagram:true,bytes:Array.from(encode(0,new Uint8Array([0,0,0,0,2,12,32,3,3]),seq++,7,1))});};setInterval(heartbeat,500);
window.native=async(command,args)=>{window.__calls.push({command,args});
 if(command==='flight_test_rc_source_status')return{selected:1,actual:1,ready:true,supported:true,switching:false,idleSending:true,feedbackAgeMs:20,reason:''};
 if(command==='px4_router_read')return structuredClone(window.router);
 if(command==='simulator_network_target_get')return '127.0.0.1';
 if(command==='sim_monitor_snapshot')return [];
 if(command==='telemetry_record_status')return{recording:false,written:0,dropped:0};
 if(command==='tool_transport_open'){channel=args.onEvent;sessionId++;heartbeat();return{sessionId,path:'mock PX4'}}
 if(command==='tool_transport_close'){window.snapshot.status='stopped';return;}
 if(command==='tool_transport_pin_peer'||command==='tool_transport_write')return;
 if(command==='flight_test_status'){if(window.snapshot.status==='running'){window.snapshot.elapsed=42+(performance.now()-started)/1000;window.snapshot.realElapsed=window.snapshot.elapsed;window.snapshot.runElapsed=window.snapshot.elapsed+5;}const value=structuredClone(window.snapshot);if(window.holdNextStatus){window.holdNextStatus=false;return new Promise(resolve=>{window.releaseStatus=()=>resolve(value);});}return value;}
 if(command==='flight_test_start'){window.started=args;started=performance.now();window.snapshot={...window.snapshot,id:window.snapshot.id+1,startedAtUnixMs:Date.now(),status:'running',name:'视景并行姿态测试',dryRun:args.options.dryRun,elapsed:42,runElapsed:47,binding:{sessionId,system:7,component:1,instance:args.options.instance,model:'MorphQuad',peer:'127.0.0.1:40000'},activeBlocks:['bp','ba','bh'],progress:{total:args.progressRoots.length,completedAt:[8,14],activeNodes:['bp_4','bl_6','ba_10','bh_14'],scriptStartedAt:5,scriptFinishedAt:null},values:{'test/attitude/active':1,'test/attitude/roll-target-deg':0,'test/attitude/pitch-target-deg':10,'test/attitude/held-s':3.2,'test/attitude/error-deg':.2,'test/altitude/active':1,'test/altitude/target-m':10,'test/fc/roll-deg':.2,'test/fc/pitch-deg':9.8,'test/fc/relative-alt-m':9.97},logs:[{time:39,level:'info',message:'姿态已到位，开始累计保持时间'}],exitResult:''};return structuredClone(window.snapshot);}
 if(command==='flight_test_stop'){if(window.rejectStop)throw Error('终止请求失败');window.snapshot.status='exiting';return new Promise(resolve=>{window.finishStop=()=>{window.snapshot.status='stopped';window.snapshot.activeBlocks=[];window.snapshot.exitResult='Hold 已确认';resolve(structuredClone(window.snapshot));};});}
 if(command==='flight_test_validate')return{events:10,properties:20};
 if(command==='sim_scene_document')return null;
 return null;
};
function Harness(){const[workspace,setWorkspace]=useState('editor');window.setWorkspace=setWorkspace;return <div style={{display:'flex',flexDirection:'column',height:'100vh'}}><Toolbar workspace={workspace} onSelectWorkspace={setWorkspace}/>{workspace==='scene'?<FlightScene slots={{'01':'MorphQuad','02':'voliro_t'}} onClose={()=>setWorkspace('editor')}/>:<div>模型编辑</div>}</div>}
createRoot(document.getElementById('root')).render(<Harness/>);`;
const ui=await uiBrowser(source,{setup,port:5197,width:1360,height:900});
const{ev,send,until,click}=ui;
const calls=command=>ev(`window.__calls.filter(c=>c.command===${JSON.stringify(command)}).length`);
try {
 await until('window.openTesting');await ev('window.openTesting()');
 await until(`document.getElementById('px4-tab-testing')?.getAttribute('aria-selected')==='true'`);
 await until(`!Array.from(document.querySelectorAll('.ft-toolbar button')).find(b=>b.textContent==='执行飞控测试').disabled`);
 await click(`Array.from(document.querySelectorAll('.ft-toolbar button')).find(b=>b.textContent==='执行飞控测试')`);
 await until(`window.store.getState().snapshot?.status==='running'`);
 assert.equal(await calls('flight_test_start'),1);
 assert.deepEqual(await ev('window.started.progressRoots'),['bm_2','bc_3','bp_4','bw_15']);
 assert.equal(await ev(`document.querySelector('.ft-progress [role=progressbar]').getAttribute('aria-valuenow')`),'50');
 assert.match(await ev(`document.querySelector('.ft-progress').textContent`),/第 2 \/ 3 轮/);
 await ev(`window.store.setState(s=>({timingHistory:{[s.runProgress.timingKey]:[{id:'last',total:100,scriptStart:5,scriptEnd:89,steps:[8,14,78,88]}]}}))`);
 await until(`/[0-9][–-][0-9]/.test(document.querySelector('.ft-progress .test-progress-metrics').textContent)`);
 const transportOpens=await calls('tool_transport_open'),transportCloses=await calls('tool_transport_close');
 await click(`Array.from(document.querySelectorAll('.ft-statusbar button')).find(b=>b.textContent==='视景观察')`);
 await until(`document.querySelector('.scene-test-panel')&&document.querySelector('.px4-toolbox-overlay').hidden`);
 assert.equal(await ev(`document.querySelector('.scene-test-panel').dataset.display`),'compact');
 assert.match(await ev(`document.querySelector('.scene-test-current').textContent`),/P \+10°/);
 assert.match(await ev(`document.querySelector('.scene-test-current').textContent`),/第 2 \/ 3 轮/);
 assert.equal(await ev(`document.querySelector('.scene-test-panel [role=progressbar]').getAttribute('aria-valuenow')`),'50');
 assert.match(await ev(`document.querySelector('.scene-test-parallel').textContent`),/油门控高/);
 assert.equal(await ev(`document.querySelector('.scene-test-hold progress').value`),3.2);
 assert.equal(await ev(`document.querySelector('.scene-test-hold progress').max`),10);
 await click(`document.querySelector('.scene-test-panel [aria-expanded]')`);
 assert(await ev(`!!document.querySelector('.scene-test-details')`));
 assert.equal(await ev(`document.querySelectorAll('.scene-test-steps [data-status="已完成"]').length`),2);
 assert.match(await ev(`document.querySelector('.scene-test-details').textContent`),/9.97 m/);
 // External/MCP heading tests have no editable run document; native metrics
 // must still label the action and populate scene heading feedback.
 await ev(`window.previousSnapshot=structuredClone(window.snapshot);window.previousRunDocument=window.store.getState().runDocument;window.store.setState({runDocument:null});window.snapshot.progress=null;window.snapshot.activeBlocks=['external_heading'];window.snapshot.values={'test/heading/active':1,'test/heading/relative-target-deg':30,'test/heading/target-deg':-160,'test/heading/error-deg':.4,'test/heading/held-s':2.5,'test/fc/yaw-deg':-160.4};`);
 await until(`document.querySelector('.scene-test-current')?.textContent.includes('航向步进')`);
 assert.equal(await ev(`document.querySelector('.scene-test-panel [role=progressbar]')`),null);
 assert.match(await ev(`document.querySelector('.scene-test-details').textContent`),/相对航向目标/);
 assert.match(await ev(`document.querySelector('.scene-test-details').textContent`),/-160.4°/);
 assert.match(await ev(`document.querySelector('.scene-test-hold').textContent`),/2.5/);
 await ev(`window.snapshot=window.previousSnapshot;window.store.setState({runDocument:window.previousRunDocument});`);
 await until(`document.querySelector('.scene-test-current')?.textContent.includes('P +10°')`);
 await writeFile('/home/qikai820/tmp/scene-flight-test-expanded.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await click(`document.querySelector('[aria-label="隐藏仿真测试"]:not(.scene-test-tool)')`);
 await until(`!document.querySelector('.scene-test-panel')&&document.querySelector('.scene-test-status .scene-test-stop')`);
 assert.match(await ev(`document.querySelector('.scene-test-status').textContent`),/50%.*剩余/);
 const elapsed=await ev('window.store.getState().snapshot.elapsed');
 await until(`window.store.getState().snapshot.elapsed>${elapsed}+.4`);
 assert.equal(await calls('flight_test_stop'),0,'hiding must not stop the runner');
 assert.equal(await calls('tool_transport_close'),transportCloses,'hiding toolbox must retain the pinned transport');
 // Changing the observed instance must not rebind the running toolbox lease.
 await ev(`window.selectObserved('02')`);await new Promise(r=>setTimeout(r,400));
 assert.equal(await ev('window.store.getState().context.instance'),1);
 assert.equal(await calls('tool_transport_open'),transportOpens);
 await ev(`window.setWorkspace('editor')`);await until(`!document.querySelector('[data-testid="flight-scene"]')`);
 await ev(`window.setWorkspace('scene')`);await until(`document.querySelector('.scene-test-status')`);
 assert.equal(await ev('window.snapshot.status'),'running');
 await click(`document.querySelector('.scene-test-status-open')`);
 await until(`document.querySelector('.scene-test-panel')`);
 await click(`document.querySelector('.scene-focus-toggle')`);
 await until(`!document.querySelector('.scene-test-panel')&&document.querySelector('.scene-test-status')`);
 await click(`document.querySelector('.scene-test-status-open')`);await until(`document.querySelector('.scene-test-panel')`);
 await ev(`window.openTesting()`);await until(`!document.querySelector('.px4-toolbox-overlay').hidden`);
 assert.match(await ev(`document.querySelector('.ft-results').textContent`),/执行中/);
 await click(`document.querySelector('[aria-label="关闭 PX4 工具箱"]')`);
 assert.equal(await calls('flight_test_stop'),0,'toolbox close must only hide');
 assert.equal(await calls('tool_transport_close'),transportCloses);
 assert.equal(await calls('flight_test_start'),1,'view changes must never start another run');
 // Delayed pre-command polling may not overwrite the result returned by stop.
 await click(`document.querySelector('[aria-label="隐藏仿真测试"]:not(.scene-test-tool)')`);
 await ev('window.holdNextStatus=true');await until('window.releaseStatus');
 await click(`document.querySelector('.scene-test-status .scene-test-stop')`);
 await until(`window.finishStop&&window.store.getState().stopping`);
 assert.match(await ev(`document.querySelector('.scene-test-status').textContent`),/确认退出/);
 assert.equal(await ev(`document.querySelector('.scene-test-status .scene-test-stop').disabled`),true);
 await ev('window.finishStop()');await until(`window.store.getState().snapshot.status==='stopped'&&!window.store.getState().stopping`);
 await ev('window.releaseStatus()');await new Promise(r=>setTimeout(r,100));
 assert.equal(await ev('window.store.getState().snapshot.status'),'stopped','stale in-flight poll cannot undo stop confirmation');
 assert.equal(await calls('flight_test_stop'),1);
 assert.equal(await ev(`document.querySelector('.scene-test-status .scene-test-stop')`),null);
 assert.match(await ev(`document.querySelector('.scene-test-status').textContent`),/已停止/);
 assert.match(await ev(`document.querySelector('.scene-test-status').textContent`),/50%/);
 await click(`document.querySelector('.scene-test-status-open')`);
 assert.match(await ev(`document.querySelector('.scene-test-current').textContent`),/Hold 已确认/);
 // Returning to an active run on a different aircraft keeps the original binding visible.
 await ev(`window.selectObserved('01')`);await until('window.store.getState().context.instance===1');
 await click(`document.querySelector('.scene-test-panel .scene-test-run')`);
 await until(`window.store.getState().snapshot.status==='running'`);
 assert.equal(await calls('flight_test_start'),2,'scene executes through the same shared session');
 await ev(`window.__emit('scene-frames',[{instance_id:'02',model:'voliro_t',state:'running',timestamp:5,latitude:31,longitude:121,altitude_m:20}])`);
 await until(`window.store.getState().snapshot.status==='running'`);
 await ev(`const select=document.querySelector('[aria-label="选择视景飞行器"]');select.value='02';select.dispatchEvent(new Event('change',{bubbles:true}));`);
 await until(`document.querySelector('.scene-test-notice')?.textContent.includes('当前观察 02')`);
 for(const width of [1024,736,375,320]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await new Promise(r=>setTimeout(r,150));
   const bounds=await ev(`(()=>{const panel=document.querySelector('.scene-test-panel').getBoundingClientRect(),view=document.querySelector('.scene-viewport').getBoundingClientRect(),stop=document.querySelector('.scene-test-panel .scene-test-stop').getBoundingClientRect();return{left:panel.left,right:panel.right,viewRight:view.right,stopBottom:stop.bottom,panelBottom:panel.bottom,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
   assert.equal(bounds.overflow,false,'no page overflow at '+width);assert(bounds.right<=bounds.viewRight+1);assert(bounds.stopBottom<=bounds.panelBottom+1,'stop remains visible at '+width);
   await click(`document.querySelector('.scene-test-panel [aria-expanded]')`);
   const detail=await ev(`(()=>{const panel=document.querySelector('.scene-test-panel').getBoundingClientRect(),stop=document.querySelector('.scene-test-panel .scene-test-stop').getBoundingClientRect();return{stop:stop.bottom,panel:panel.bottom}})()`);
   assert(detail.stop<=detail.panel+1,'expanded stop remains visible at '+width);
   await click(`document.querySelector('.scene-test-panel [aria-expanded]')`);
   await click(`document.querySelector('[aria-label="隐藏仿真测试"]:not(.scene-test-tool)')`);
   const footer=await ev(`(()=>{const stop=document.querySelector('.scene-test-status .scene-test-stop'),r=stop.getBoundingClientRect();return{right:r.right,bottom:r.bottom,hit:stop.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
   assert(footer.right<=width&&footer.bottom<=900&&footer.hit,'hidden footer stop is reachable at '+width);
   await click(`document.querySelector('.scene-test-status-open')`);
 }
 await writeFile('/home/qikai820/tmp/scene-flight-test-narrow.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await click(`document.querySelector('[aria-label="隐藏仿真测试"]:not(.scene-test-tool)')`);
 await ev('window.rejectStop=true');await click(`document.querySelector('.scene-test-status .scene-test-stop')`);
 await until(`window.store.getState().error.includes('终止请求失败')&&!window.store.getState().stopping`);
 assert.equal(await ev(`document.querySelector('.scene-test-status .scene-test-stop').disabled`),false,'failed stop leaves the retry action available');
 assert.match(await ev(`document.querySelector('.scene-test-status [role=alert]').textContent`),/终止请求失败/);
 await ev(`Object.assign(window.snapshot,{status:'exiting',elapsed:84,runElapsed:89});Object.assign(window.snapshot.progress,{completedAt:[8,14,78,88],activeNodes:[],scriptFinishedAt:89})`);
 await until(`document.querySelector('.scene-test-status')?.textContent.includes('100%')&&document.querySelector('.scene-test-status')?.textContent.includes('确认退出')`);
 await ev(`Object.assign(window.snapshot,{status:'passed',runElapsed:100,exitResult:'Hold 已确认'})`);
 await until(`JSON.parse(localStorage.getItem('px4-flight-test-timing-v1')||'{}')[window.store.getState().runProgress.timingKey]?.some(s=>s.id.endsWith('/2'))`);
 assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));
 console.log('PASS: actual toolbar/toolbox/scene share one test and transport; compact/details/hidden/focus; hidden elapsed advances; close/switch/reopen retain run; bound instance; footer termination and exit confirmation; responsive controls.');
} finally { await ui.close(); }
