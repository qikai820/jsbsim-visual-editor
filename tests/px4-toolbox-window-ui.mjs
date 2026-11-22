// Two real JS contexts with isolated Tauri window/event IPC, never device I/O.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const setup=`
const label=location.search.includes('mock-toolbox')?'px4-toolbox':'main';
window.label=label;const callbacks=new Map(),listeners=new Map();let next=0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__emit=(event,payload)=>{for(const item of listeners.get(event)||[])callbacks.get(item.handler)?.({event,id:item.id,payload});};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label},currentWebview:{label}},transformCallback(fn){const id=++next;callbacks.set(id,fn);return id;},unregisterCallback(id){callbacks.delete(id);},invoke(command,args){
 if(command==='plugin:event|listen'){const id=++next;listeners.set(args.event,[...(listeners.get(args.event)||[]),{id,handler:args.handler}]);return Promise.resolve(id);}
 if(command==='plugin:event|unlisten'){listeners.set(args.event,(listeners.get(args.event)||[]).filter(item=>item.id!==args.eventId));return Promise.resolve();}
 if(command==='plugin:event|emit_to'){const master=window.parent!==window?window.parent:window;const target=args.target.label==='main'?master:master.document.querySelector('iframe')?.contentWindow;queueMicrotask(()=>target?.__emit(args.event,structuredClone(args.payload)));return Promise.resolve();}
 return (window.parent!==window?window.parent:window).native(command,args,window.label);
}};
if(label==='main'){localStorage.clear();localStorage.setItem('jsbsim-language','zh-CN');localStorage.setItem('px4-toolbox-native-bounds-v1',JSON.stringify({x:2100,y:100,width:1000,height:750,maximized:false}));}
`;
const permissions={main:JSON.parse(await readFile('src-tauri/capabilities/default.json','utf8')).permissions,'px4-toolbox':JSON.parse(await readFile('src-tauri/capabilities/px4-toolbox.json','utf8')).permissions};
const source=`import React,{useState}from'react';import{createRoot}from'react-dom/client';
import Host,{NativePx4Toolbox}from'./src/components/Px4ToolboxWindow';import WindowControls from './src/components/WindowControls';
import{openTestToolbox,hideTestToolbox,useFlightTestStore,startFlightTest,stopFlightTest}from'./src/flight-test/session';
import{executeMcpRequest}from'./src/flight-test/mcp';import{useSignalMonitorStore}from'./src/store/signalMonitorStore';import{encode}from'./src/px4/protocol';
window.label=location.search.includes('mock-toolbox')?'px4-toolbox':'main';window.__TAURI_INTERNALS__.metadata={currentWindow:{label:window.label},currentWebview:{label:window.label}};
window.store=useFlightTestStore;window.openTesting=()=>openTestToolbox(true);window.startFromMain=()=>startFlightTest(true);window.stopFromMain=()=>stopFlightTest();window.mcp=executeMcpRequest;
if(window.label==='main'){
 window.calls=[];window.opens=0;window.sceneCalls=0;window.geometry={x:2100,y:100,width:1000,height:750};let channel,seq=0;
 window.snapshot={id:0,status:'idle',dryRun:true,name:'',elapsed:0,realElapsed:0,activeBlocks:[],values:{},rc:[0,0,0,.5],logs:[],exitResult:''};
 const heartbeat=()=>channel?.onmessage({kind:'data',sessionId:99,direction:'rx',peer:'127.0.0.1:40000',datagram:true,bytes:Array.from(encode(0,new Uint8Array([0,0,0,0,2,12,32,3,3]),seq++,7,1))});setInterval(heartbeat,500);
 window.px4Print=value=>{const p=new Uint8Array(54);p[0]=6;p.set(new TextEncoder().encode(value),1);channel.onmessage({kind:'data',sessionId:99,direction:'rx',peer:'127.0.0.1:40000',datagram:true,bytes:Array.from(encode(253,p,seq++,7,1))});};
 const monitor=x=>({name:'screen'+x,position:{x,y:0},size:{width:1920,height:1080},scaleFactor:1,workArea:{position:{x,y:0},size:{width:1920,height:1040}}});
 window.native=async(command,args,label)=>{
  window.calls.push({command,args,label});
  const restricted={'plugin:window|minimize':'core:window:allow-minimize','plugin:window|toggle_maximize':'core:window:allow-toggle-maximize','plugin:window|close':'core:window:allow-close'};
  if(restricted[command]&&!${JSON.stringify(permissions)}[label].includes(restricted[command]))throw Error('window permission denied');
  if(command==='plugin:window|get_all_windows')return window.opens?['main','px4-toolbox']:['main'];
  if(command==='plugin:window|available_monitors')return[monitor(0),monitor(1920)];
  if(command==='plugin:window|current_monitor')return monitor(0);
  if(command==='plugin:webview|create_webview_window'){window.opens++;window.options=args.options;const frame=document.createElement('iframe');frame.id='toolbox-frame';frame.style.cssText='position:fixed;left:320px;top:20px;width:1020px;height:880px;border:1px solid #999';frame.src=location.pathname+'?mock-toolbox=1';document.body.append(frame);return;}
  if(command==='plugin:window|hide'){document.querySelector('iframe').hidden=true;return;}
  if(command==='plugin:window|show'){document.querySelector('iframe').hidden=false;return;}
  if(command==='plugin:window|is_maximized')return !!window.maximized;
  if(command==='plugin:window|toggle_maximize'){window.maximized=!window.maximized;return;}
  if(command==='plugin:window|is_minimized')return false;
  if(command==='plugin:window|outer_position')return{x:window.geometry.x,y:window.geometry.y};
  if(command==='plugin:window|inner_size')return{width:window.geometry.width,height:window.geometry.height};
  if(command==='plugin:window|scale_factor')return 1;
  if(command.startsWith('plugin:window|'))return;
  if(command==='px4_router_read')return{simulator:'127.0.0.1',state:'running',config:{device:'/dev/ttyACM0',baud:921600,host:'127.0.0.1',qgc_port:14550,toolbox_port:14553},active_config:{device:'/dev/ttyACM0',baud:921600,host:'127.0.0.1',qgc_port:14550,toolbox_port:14553},routes:[]};
  if(command==='simulator_network_target_get')return'127.0.0.1';
  if(command==='tool_transport_open'){channel=args.onEvent;heartbeat();return{sessionId:99,path:'mock PX4'};}
  if(command==='tool_transport_pin_peer')return new Promise(resolve=>{window.finishPeerPin=()=>{window.peerReady=true;resolve();};});
  if(command==='flight_test_rc_source_status'){
   if(!window.peerReady||args.options.sessionId!==99||args.options.system!==7||args.options.component!==1)throw Error('仿真机转发会话、来源或固定回传目标已失效');
   return{mode:3,selected:null,actual:null,ready:false,supported:true,switching:false,idleSending:false,feedbackAgeMs:null,reason:'当前为自动／混合输入'};
  }
  if(command==='flight_test_status')return structuredClone(window.snapshot);
  if(command==='flight_test_start'){window.snapshot={...window.snapshot,id:window.snapshot.id+1,status:'running',name:'独立窗口测试',elapsed:10,dryRun:args.options.dryRun};return structuredClone(window.snapshot);}
  if(command==='flight_test_stop'){if(window.rejectStop)throw Error('退出确认失败');window.snapshot={...window.snapshot,status:'stopped',exitResult:'退出已确认'};return structuredClone(window.snapshot);}
  if(command==='flight_test_validate')return{events:10,properties:20};
  return null;
 };
 function Main(){const s=useFlightTestStore(),[count,setCount]=useState(0);return <div><button style={{position:'fixed',left:10,top:10}} onClick={()=>setCount(v=>v+1)}>主界面操作 {count}</button><div style={{position:'fixed',left:160,top:10}}><WindowControls/></div><Host visited={s.toolboxVisited} visible={s.toolboxVisible} onShowScene={()=>{window.sceneCalls++;hideTestToolbox();}}/></div>}
 createRoot(document.getElementById('root')).render(<Main/>);
}else createRoot(document.getElementById('root')).render(<NativePx4Toolbox/>);`;
const ui=await uiBrowser(source,{setup,port:5201,width:1380,height:1000});
const{ev,until,click,send}=ui;
const child=expression=>ev(`document.querySelector('iframe').contentWindow.eval(${JSON.stringify(expression)})`);
const childClick=async selector=>{
 await until(`document.querySelector('iframe')?.contentDocument.querySelector(${JSON.stringify(selector)})?.disabled===false`);
 return child(`document.querySelector(${JSON.stringify(selector)}).click()`);
};
const count=command=>ev(`window.calls.filter(c=>c.command===${JSON.stringify(command)}).length`);
try{
 await until('window.openTesting');await ev('window.openTesting()');
 await until(`document.querySelector('iframe')?.contentWindow.store?.getState().context?.link?.alive&&window.store.getState().context?.link?.alive`);
 assert.equal(await count('flight_test_rc_source_status'),0,'owner waits for native peer pin before source queries');
 await ev('window.finishPeerPin()');
 await until(`window.store.getState().rcSource?.mode===3`);
 assert.equal(await child(`document.body.innerText.includes('仿真机转发会话、来源或固定回传目标已失效')`),false);
 assert.equal(await ev('window.store.getState().rcSourceStatusError'),'');
 assert.equal(await ev('document.querySelector(".px4-toolbox-overlay")'),null,'main has no modal overlay');
 assert.equal(await count('tool_transport_open'),1);
 assert.equal(await ev(`window.calls.find(c=>c.command==='tool_transport_open').label`),'px4-toolbox');
 assert.equal(await ev('window.options.decorations'),false);assert.equal(await ev('window.options.resizable'),true);
 assert.equal(await ev('window.options.url'),'index.html?window=px4-toolbox');
 const focusBefore=await count('plugin:window|set_focus');await ev('window.openTesting()');
 await until(`window.calls.filter(c=>c.command==='plugin:window|set_focus').length>${focusBefore}`);
 assert.equal(await ev('window.opens'),1,'opening an already visible window brings it to the front');
 assert(await ev(`window.calls.some(c=>c.command==='plugin:window|set_position'&&JSON.stringify(c.args).includes('2100'))`),'saved second-monitor position restored');
 await click(`document.querySelector('#root button')`);assert.match(await ev('document.querySelector("#root button").textContent'),/1/,'main remains interactive');
 await childClick('[data-window-action="minimize"]');
 assert.equal(await count('plugin:window|minimize'),1);
 await childClick('[data-window-action="maximize"]');await until('window.maximized===true');
 assert.equal(await child(`document.querySelector('[data-window-action="maximize"]').getAttribute('aria-label')`),'还原窗口');
 await childClick('[data-window-action="maximize"]');await until('window.maximized===false');
 assert.equal(await count('plugin:window|toggle_maximize'),2);
 assert(await ev(`window.calls.filter(c=>['plugin:window|minimize','plugin:window|toggle_maximize'].includes(c.command)).every(c=>c.label==='px4-toolbox')`),'title buttons target the toolbox window');
 await childClick('#px4-tab-testing');
 const area=await child(`(()=>{const work=document.querySelector('.ft-workspace').getBoundingClientRect(),canvas=document.querySelector('.ft-canvas').getBoundingClientRect();return canvas.width/work.width;})()`);
 assert(area>.9,'default canvas uses over 90% of editor width');
 await childClick('[data-block=b3] .ft-pick');assert.equal(await child(`document.querySelector('.ft-details').hidden`),false);
 await child(`Array.from(document.querySelectorAll('.ft-canvas-toolbar button')).find(b=>b.textContent==='专注画布').click()`);
 assert.equal(await child(`getComputedStyle(document.querySelector('.px4-tabs')).display`),'none');
 await child(`Array.from(document.querySelectorAll('.ft-canvas-toolbar button')).find(b=>b.textContent==='退出专注').click()`);
 await child(`Array.from(document.querySelectorAll('.ft-toolbar button')).find(b=>b.textContent==='离线预演').click()`);
 await until('window.store.getState().snapshot?.status==="running"');
 assert.equal(await count('flight_test_start'),1);
 await childClick('[data-window-action="close"]');await until('!window.store.getState().toolboxVisible');
 assert.equal(await count('flight_test_stop'),0);assert.equal(await count('tool_transport_close'),0);
 assert.equal(await ev('document.querySelector("iframe").hidden'),true);
 await ev(`window.px4Print('Printed while toolbox was hidden')`);
 await ev('window.stopFromMain()');await until('window.store.getState().snapshot?.status==="stopped"');
 assert.equal(await count('flight_test_stop'),1,'scene stop executes once in the owner window');
 await ev('window.openTesting()');await until('!document.querySelector("iframe").hidden');assert.equal(await ev('window.opens'),1,'reopen reuses native window');
 await childClick('#px4-tab-messages');
 await until(`document.querySelector('iframe').contentDocument.querySelector('.px4-message-output').textContent.includes('Printed while toolbox was hidden')`);
 assert.equal(await count('tool_transport_open'),1,'hidden-window prints use the existing link');
 await childClick('#px4-tab-testing');
 await ev('window.startFromMain()');await until('window.store.getState().snapshot?.status==="running"');assert.equal(await count('flight_test_start'),2);
 await child(`window.__emit('tauri://close-requested',null)`);await until('document.querySelector("iframe").hidden');
 assert.equal(await count('plugin:window|destroy'),0,'OS close hides instead of destroying');
 await ev('window.stopFromMain()');
 await ev(`window.mcp({name:'upper_start_test',arguments:{source:'<script/>',dryRun:true}})`);assert.equal(await count('flight_test_start'),3);
 assert.equal(await ev('window.store.getState().runOrigin'),'mcp');await ev('window.stopFromMain()');
 const starts=await count('flight_test_start');
 await child(`window.__emit('px4-toolbox-bridge',{kind:'command',id:'expired',deadline:Date.now()-1,action:'start',dryRun:true})`);
 assert.equal(await count('flight_test_start'),starts,'expired control never executes later');
 await ev('window.openTesting()');await until('!document.querySelector("iframe").hidden');
 for(const width of[1040,736,390,320]){
  await ev(`document.querySelector('iframe').style.width='${width}px'`);await new Promise(r=>setTimeout(r,100));
  assert(await child(`document.querySelector('.flight-test').scrollWidth<=document.querySelector('.flight-test').clientWidth+1`),'editor fits '+width);
  assert(await child(`(()=>{const b=document.querySelector('.ft-stop'),r=b.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`),'stop reachable '+width);
 }
 await ev(`window.geometry={x:2300,y:150,width:800,height:700}`);await child(`window.__emit('tauri://move',{x:2300,y:150});window.__emit('tauri://resize',{width:800,height:700})`);
 await until(`JSON.parse(localStorage.getItem('px4-toolbox-native-bounds-v1')).width===800`);
 assert.equal(await ev(`JSON.parse(localStorage.getItem('px4-toolbox-native-bounds-v1')).x`),2300);
 await click(`document.querySelector('#root [data-window-action="minimize"]')`);
 await click(`document.querySelector('#root [data-window-action="maximize"]')`);await until('window.maximized===true');
 await click(`document.querySelector('#root [data-window-action="maximize"]')`);await until('window.maximized===false');
 await click(`document.querySelector('#root [data-window-action="close"]')`);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='plugin:window|close'&&c.label==='main').length`),1,'main close targets the main window');
 await ev(`document.querySelector('iframe').style.width='1020px'`);await new Promise(r=>setTimeout(r,100));
 await writeFile('/home/qikai820/tmp/px4-toolbox-native-window-ui.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 assert.equal(await count('tool_transport_open'),1);assert.equal(await count('tool_transport_close'),0);assert.deepEqual(ui.errors,[]);
 console.log('PASS native-window UI: independent JS context, main remains usable, one connection, close/reopen/OS close preserve run, hidden-window prints, cross-window UI/MCP start and stop, expired requests, multi-monitor bounds, focused/responsive editor.');
}catch(error){console.error(await ev(`({calls:window.calls?.map(c=>c.command),href:document.querySelector('iframe')?.contentWindow.location.href,frame:document.querySelector('iframe')?.contentDocument?.body?.innerText,childLabel:document.querySelector('iframe')?.contentWindow.label,error:document.querySelector('iframe')?.contentWindow.store?.getState().statusError})`));throw error;}finally{await ui.close();}
