// Actual shared session + MCP event adapter with isolated Tauri IPC.
import assert from 'node:assert/strict';
import {uiBrowser} from './support/ui-browser.mjs';
const setup=`const callbacks=new Map();let next=0;window.events=new Map();window.calls=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__={transformCallback(fn){const id=++next;callbacks.set(id,fn);return id},unregisterCallback(id){callbacks.delete(id)},invoke(command,args){if(command==='plugin:event|listen'){window.events.set(args.event,callbacks.get(args.handler));return Promise.resolve(++next)}if(command==='plugin:event|unlisten')return Promise.resolve();return window.native(command,args)}};
window.emitMcp=id=>window.events.get('upper-mcp-request')?.({payload:{id}});`;
const source=`import React from'react';import{createRoot}from'react-dom/client';
import{useUpperMcp}from'./src/flight-test/mcp';import{useFlightTestStore,useFlightTestSession,startFlightTest,stopFlightTest}from'./src/flight-test/session';
window.store=useFlightTestStore;window.startUi=()=>startFlightTest(true);window.stopUi=()=>stopFlightTest();window.completed=[];window.requests={};window.claims=new Set();window.handover=0;
window.native=async(command,args)=>{window.calls.push({command,args});
 if(command==='mcp_bridge_status')return{enabled:true,endpointFile:'/fake/endpoint.json',audit:[]};
 if(command==='mcp_claim_request'){if(!window.requests[args.id]||window.claims.has(args.id))throw Error('expired');window.claims.add(args.id);return window.requests[args.id];}
 if(command==='mcp_complete_request'){window.completed.push(args);return;}
 if(command==='flight_test_status')return window.snapshot;
 if(command==='flight_test_start'){window.options=args.options;window.snapshot={...window.snapshot,id:window.snapshot.id+1,status:'running',name:'MCP mock run',dryRun:args.options.dryRun};return window.snapshot;}
 if(command==='flight_test_stop'){window.snapshot={...window.snapshot,status:'stopped',exitResult:'landed and disarmed'};return window.snapshot;}
 return null;
};
window.snapshot={id:0,status:'idle',dryRun:true,elapsed:0,realElapsed:0,name:'',rc:[0,0,0,0],activeBlocks:[],values:{},logs:[],exitResult:''};
window.link={alive:true,hilEnabled:true,target:{system:1,component:1},transport:{sessionId:12}};
window.context={link:window.link,instance:1,bidirectional:true,disabled:false,beforeRun:async()=>{window.handover++;}};
useFlightTestStore.setState({context:window.context,rcSource:{selected:1,actual:1,ready:true,supported:true,switching:false,idleSending:true,feedbackAgeMs:20,reason:''}});window.originalWorkspace=useFlightTestStore.getState().workspace;
function App(){const mcp=useUpperMcp(),s=useFlightTestSession();return <div>{mcp?.enabled?'MCP available':''} {s.snapshot?.status} {s.runOrigin}</div>};createRoot(document.getElementById('root')).render(<App/>);`;
const ui=await uiBrowser(source,{setup,port:5199});
const{ev,until}=ui;
const send=async(id,name,args)=>{
 await ev(`window.requests[${id}]=${JSON.stringify({name,arguments:args})};window.emitMcp(${id})`);
 await until(`window.completed.some(r=>r.id===${id})`);
 return ev(`window.completed.find(r=>r.id===${id})`);
};
try{
 await until(`window.events.has('upper-mcp-request')&&document.body.textContent.includes('MCP available')`);
 const starts=()=>ev(`window.calls.filter(c=>c.command==='flight_test_start').length`);
 const result=await send(1,'upper_start_test',{source:'<script/>',dryRun:true});
 assert.equal(result.error,null);assert.equal(await ev('window.handover'),1);
 assert.equal(await ev('window.store.getState().runOrigin'),'mcp');
 assert.equal(await ev('window.options.sessionId'),12);
 assert.equal(await ev('window.options.onAbort'),'land');
 assert(await ev('window.store.getState().workspace===window.originalWorkspace'),'MCP preserves edited workspace');
 assert.match(await ev(`window.startUi().then(()=>'',e=>String(e))`),/已有/);
 assert.match((await send(2,'upper_start_test',{source:'x',dryRun:true})).error,/已有/);
 assert.equal(await starts(),1);
 assert.match((await send(3,'upper_stop_test',{id:99})).error,/标识/);
 assert.equal(await ev('window.snapshot.status'),'running');
 await ev('window.emitMcp(999)');await new Promise(r=>setTimeout(r,100));
 assert.equal(await starts(),1,'Expired event cannot execute');
 await ev('window.stopUi()');await until(`window.store.getState().snapshot.status==='stopped'`);
 assert.equal(await ev('window.snapshot.exitResult'),'landed and disarmed','UI can stop MCP run');
 await ev(`window.store.setState({context:{...window.context,disabled:true}})`);
 assert.match((await send(4,'upper_start_test',{source:'x',dryRun:true})).error,/其他飞控操作/);
 assert.equal(await starts(),1);
 // Pending handover reserves the UI synchronously before awaiting shell close.
 await ev(`window.store.setState({context:{...window.context,beforeRun:()=>new Promise(resolve=>{window.releaseHandover=resolve})}});window.requests[5]={name:'upper_start_test',arguments:{source:'x',dryRun:true}};window.emitMcp(5);void 0`);
 await until('window.releaseHandover&&window.store.getState().starting');
 assert.match(await ev(`window.startUi().then(()=>'',e=>String(e))`),/已有/);
 await ev('window.releaseHandover()');await until('window.completed.some(r=>r.id===5)');
 assert.equal(await starts(),2);
 await send(6,'upper_stop_test',{id:2});
 assert.equal(await ev('window.store.getState().snapshot.status'),'stopped');
 assert.equal(await ev(`window.calls.filter(c=>['tool_transport_open','tool_transport_close'].includes(c.command)).length`),0,'MCP owns no device transport');
 console.log('PASS MCP shared UI: same runner, handover reservation, UI stop, busy/stale/expired guards, preserved workspace, no additional transport');
}finally{await ui.close();}
