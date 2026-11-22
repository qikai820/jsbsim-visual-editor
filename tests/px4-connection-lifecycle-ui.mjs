// Real toolbox under the desktop's StrictMode, with isolated native I/O.
import assert from 'node:assert/strict';
import {uiBrowser} from './support/ui-browser.mjs';

const setup=`window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>window.native(command,args)};`;
const source=`import React from 'react';import{createRoot}from'react-dom/client';
import Toolbox from './src/components/Px4Toolbox';import{Px4Shell}from'./src/px4/shell';
import{encode}from'./src/px4/protocol';import{useFlightTestStore}from'./src/flight-test/session';import './src/App.css';
window.calls=[];window.store=useFlightTestStore;window.active=null;let sequence=0,next=0,revision=0;
const router={simulator:'127.0.0.1',state:'running',config:{device:'/dev/ttyACM0',baud:921600,host:'127.0.0.1',qgc_port:14550,toolbox_port:14553},routes:[]};router.active_config=router.config;
const heartbeat=()=>{const active=window.active;if(active)active.channel.onmessage({kind:'data',sessionId:active.id,direction:'rx',peer:'127.0.0.1:41000',datagram:true,bytes:Array.from(encode(0,new Uint8Array([0,0,0,0,2,12,32,3,3]),sequence++,7,1))});};
setInterval(heartbeat,300);
window.native=async(command,args)=>{window.calls.push({command,args});
 if(command==='px4_router_read')return router;
 if(command==='simulator_network_target_get')return'127.0.0.1';
 if(command==='tool_transport_open'){
  if(window.active)throw Error('调试助手已有打开的连接，请先断开');
  const id=++next;window.active={id,channel:args.onEvent};heartbeat();return{sessionId:id,path:'isolated toolbox'};
 }
 if(command==='tool_transport_close'){
  const active=window.active;
  if(active?.id!==args.sessionId)throw Error('串口会话已变化');
  window.active=null;active.channel.onmessage({kind:'status',sessionId:active.id,connected:false});return;
 }
 if(command==='flight_test_status')return{id:0,status:'idle',name:'',dryRun:true,elapsed:0,realElapsed:0,rc:[0,0,0,0],activeBlocks:[],values:{},logs:[],exitResult:''};
 if(command==='flight_test_rc_source_status'){
  if(args.options.sessionId!==window.active?.id)throw Error('仿真机转发会话、来源或固定回传目标已失效');
  return{mode:3,selected:null,actual:null,ready:false,supported:true,switching:false,idleSending:false,feedbackAgeMs:null,reason:'自动／混合输入'};
 }
 return null;
};
const close=Px4Shell.prototype.close;
Px4Shell.prototype.close=function(release=true){if(window.stallRelease&&release)return new Promise(()=>{});return close.call(this,release);};
const root=createRoot(document.getElementById('root'));
window.remount=()=>root.render(<React.StrictMode><Toolbox key={++revision} onClose={()=>{}}/></React.StrictMode>);
window.remount();`;

const ui=await uiBrowser(source,{setup,port:5211});
const{ev,until,click}=ui;
try{
 await until(`window.store?.getState().context?.link?.alive&&window.store.getState().rcSource?.supported`);
 const initial=await ev('window.active.id');
 for(const tab of ['testing','parameters','testing','messages','testing']){
  await click(`document.getElementById('px4-tab-${tab}')`);
  assert(await ev('window.store.getState().context.link.alive'),'switching to '+tab+' preserves heartbeat');
 }
 await new Promise(resolve=>setTimeout(resolve,2800));
 assert.equal(await ev('window.active.id'),initial,'tab selection keeps the sole receive session');
 assert.equal(await ev(`window.calls.filter(c=>c.command==='tool_transport_close').length`),0);
 assert.equal(await ev(`document.querySelector('.ft-rc-source').textContent.includes('未连接')`),false);
 // A lost shell IPC response during reload must never delay port cleanup.
 await ev('window.stallRelease=true;window.remount()');
 await until(`window.active?.id>${initial}&&window.store.getState().context?.link?.alive&&window.store.getState().rcSource?.supported`);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='tool_transport_close').length`),1);
 assert.equal(await ev(`document.body.innerText.includes('调试助手已有打开的连接')`),false);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_rc_source_select'||c.command==='flight_test_start').length`),0);
 assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));
 console.log('PASS StrictMode tab changes preserve heartbeat and source state; stalled shell release cannot retain the native session during remount.');
}finally{await ui.close();}
