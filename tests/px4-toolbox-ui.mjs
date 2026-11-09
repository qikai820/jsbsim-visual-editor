import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const f=JSON.parse(await readFile('tests/fixtures/px4-mavlink.json','utf8'));
const setup=`window.calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>window.native(command,args)};window.change=(element,value)=>{Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};`;
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Toolbox from './src/components/Px4Toolbox';import OriginalNsh from './src/components/NshConsoleDialog';import{useFlowStore}from'./src/store/flowStore';import{Parser,encode,view,crc32}from'./src/px4/protocol';import{Terminal}from'@xterm/xterm';import './src/App.css';
const original=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;return original.apply(this,args);};
const fixtures=${JSON.stringify(f)};const parser=new Parser();let seq=0,channel,session=0,line='';window.toolClosed=0;window.saved=[];window.shellInput='';
useFlowStore.setState({nodes:[{id:'relay',type:'aircraftComponent',position:{x:0,y:0},data:{componentType:'mavlink_forwarder',params:{id:'qgc',name:'仿真机 MAVLink',qgc_port:14550,enabled:true,bidirectional:true}}}]});
const metadata={version:1,parameters:[{name:'TEST_INT',category:'Standard',group:'Custom Firmware',shortDesc:'Custom mode',longDesc:'Firmware original description',type:'Int32',default:0,min:-20000,max:20000},{name:'MC_ROLLRATE_P',category:'Standard',group:'Multicopter Rate Control',shortDesc:'Roll rate P gain',longDesc:'Original firmware description',type:'Float',default:.15,min:.01,max:.5}]};
const text=new TextEncoder();const metaBytes=text.encode(JSON.stringify(metadata));const generalBytes=text.encode(JSON.stringify({version:1,metadataTypes:[{type:1,uri:'https://metadata.test/params.json',fileCrc:crc32(metaBytes)}]}));
const event=bytes=>channel.onmessage({kind:'data',sessionId:session,direction:'rx',timeMs:Date.now(),elapsedUs:1,peer:'127.0.0.1:40000',datagram:true,bytes:Array.from(bytes)});
const frame=(id,p)=>event(encode(id,p,seq++,7,1));
const shell=data=>{const b=text.encode(data);for(let i=0;i<b.length;i+=70){const p=new Uint8Array(81);p[6]=10;p[7]=1;p[8]=Math.min(70,b.length-i);p.set(b.subarray(i,i+70),9);frame(126,p);}};
const file=Uint8Array.from([85,76,111,103,1,18,53,1,...Array.from({length:172},(_,i)=>i%256)]);window.logBytes=Array.from(file);
const summary={path:'/tmp/px4-fixture.ulg',name:'px4-fixture.ulg',size:file.length,version:1,duration:1,topics:[{name:'vehicle_status',multiId:0,samples:3,frequency:2}],parameters:{TEST_INT:-12345},info:{ver_sw:'test firmware'},dropoutCount:0,dropoutMs:0,truncated:false};
window.native=async(command,args)=>{window.calls.push({command,args});
if(command==='simulator_network_target_get')return '127.0.0.1';
if(command==='tool_simulator_nsh_target')return{host:'127.0.0.1',port:23};
if(command==='nsh_execute')return 'legacy result: '+args.command+'\\n';
if(command==='tool_transport_open'&&args.owner==='nsh'){window.rawChannel=args.onEvent;window.rawEmit=bytes=>args.onEvent.onmessage({kind:'data',sessionId:100,direction:'rx',timeMs:Date.now(),elapsedUs:1,peer:'127.0.0.1:23',datagram:false,bytes:Array.from(bytes)});window.rawEmit(text.encode('nsh> '));return{sessionId:100,path:'simulator NSH'};}
if(command==='tool_transport_write'&&args.owner==='nsh'){const value=new TextDecoder().decode(Uint8Array.from(args.bytes));window.rawInput=(window.rawInput||'')+value;window.rawEmit(text.encode(value==='\\r'?'\\r\\nsimulator result\\r\\nnsh> ':value));return args.bytes.length;}
if(command==='tool_transport_open'){channel=args.onEvent;session++;event(Uint8Array.from(fixtures.heartbeatV2));return{sessionId:session,path:'simulator UDP'};}
if(command==='tool_transport_close'){window.toolClosed++;return;}
if(command==='tool_transport_pin_peer')return;
if(command==='px4_metadata_fetch')return Array.from(args.uri.endsWith('params.json')?metaBytes:generalBytes);
if(command==='px4_metadata_decode')return new TextDecoder().decode(Uint8Array.from(args.bytes));
if(command==='px4_parameters_save'){window.exported=args.text;return '/tmp/px4.params';}
if(command==='px4_log_begin'){window.job=(window.job||0)+1;window.saved=Array(file.length).fill(0);return window.job;}
if(command==='px4_log_write'){args.bytes.forEach((b,i)=>window.saved[args.offset+i]=b);return;}
if(command==='px4_log_finish'||command==='px4_log_inspect'||command==='px4_log_pick')return summary;
if(command==='px4_log_cancel'){window.cancelled=args.id;return;}
if(command==='tool_transport_write'){for(const m of parser.push(Uint8Array.from(args.bytes))){const p=m.payload,d=view(p);
 if(m.id===21){event(Uint8Array.from(fixtures.int32));event(Uint8Array.from(fixtures.float));}
 if(m.id===76){const requested=d.getFloat32(0,true);if(requested===397||requested===395){const r=new Uint8Array(108);view(r).setUint32(4,crc32(generalBytes),true);r.set(text.encode('https://metadata.test/general.json'),8);frame(397,r);}if(requested===148){const r=new Uint8Array(78);view(r).setBigUint64(0,16n,true);view(r).setBigUint64(8,1234n,true);view(r).setUint32(16,0x010f0300,true);frame(148,r);}}
 if(m.id===117){const r=new Uint8Array(14),v=view(r);v.setUint32(0,1700000000,true);v.setUint32(4,file.length,true);v.setUint16(8,42,true);v.setUint16(10,1,true);v.setUint16(12,42,true);frame(118,r);}
 if(m.id===119&&!window.holdLogs){const offset=d.getUint32(0,true),count=d.getUint32(4,true);for(let at=offset;at<Math.min(offset+count,file.length);at+=90){const b=file.subarray(at,Math.min(at+90,offset+count,file.length)),r=new Uint8Array(97);view(r).setUint32(0,at,true);view(r).setUint16(4,42,true);r[6]=b.length;r.set(b,7);frame(120,r);}}
 if(m.id===126&&p[7]!==0&&p[8]){const data=new TextDecoder().decode(p.subarray(9,9+p[8]));window.shellInput+=data;for(const c of data){if(c==='\\n'&&!line){shell('NSH ready\\r\\nnsh> ');}else if(c==='\\r'){shell('\\r\\nResult: '+line+'\\r\\nnsh> ');line='';}else if(c==='\\x03'){line='';shell('^C\\r\\nnsh> ');}else if(c==='\\x15'){line='';shell('\\r\\x1b[Knsh> ');}else{line+=c;shell(c);}}}
}return args.bytes.length;}
return null;};
window.unmount=()=>root.unmount();window.mountOriginal=mode=>{root.unmount();localStorage.setItem('jsbsim-simulator-transport',mode);root=createRoot(document.getElementById('root'));root.render(<OriginalNsh onClose={()=>root.unmount()}/>);};let root=createRoot(document.getElementById('root'));root.render(<Toolbox onClose={()=>root.unmount()}/>);`;
const ui=await uiBrowser(source,{setup});
const {ev,until,click,send}=ui;
try{
 await until('document.querySelector(".px4-status.connected")');
 await until('document.querySelector(".px4-metadata-status").textContent.includes("飞控匹配")');
 assert.equal(await ev(`Array.from(document.querySelectorAll('.px4-toolbox button')).some(b=>/^(连接|断开|连接设置|连接终端)$/.test(b.textContent))`),false,'no separate connection controls');
 assert.equal(await ev(`window.calls.find(c=>c.command==='tool_transport_open').args.network.localPort`),14550);
 assert.equal(await ev(`window.calls.find(c=>c.command==='tool_transport_open').args.serial`),null);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取全部')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===2');
 assert.ok(await ev('document.querySelector(".px4-param-table").textContent.includes("-12345")'));
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='导出当前组')`);
 await until('window.exported');assert.match(await ev('window.exported'),/TEST_INT\t-12345\t6/);
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'MC_ROLL')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===1');
 await click(`document.querySelector('.px4-param-pick')`);
 assert.ok(await ev('document.querySelector(".px4-details").textContent.includes("0.01")'));
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'')`);
 await click(`document.querySelector('.px4-new-group')`);
 await ev(`window.change(document.querySelector('[aria-label="新分组名称"]'),'Bench tuning')`);
 await click(`document.querySelector('.px4-groups form button')`);
 await until(`document.querySelector('[aria-label="参数分组方式"]').value==='custom'`);
 await click(`document.querySelector('.px4-assign button')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===1');
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-parameters.png',Buffer.from(r.data,'base64'));}
 await click(`document.getElementById('px4-tab-logs')`);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='刷新板载列表')`);
 await until('document.querySelectorAll(".px4-log-table tbody tr").length===1');
 await click(`document.querySelector('.px4-log-pick')`);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='下载此日志')`);
 await until('window.calls.some(c=>c.command==="px4_log_finish")');
 assert.deepEqual(await ev('window.saved'),await ev('window.logBytes'),'complete chunk coverage before finishing');
 await until('document.querySelector(".px4-log-detail-tabs")');
 await click(`Array.from(document.querySelectorAll('.px4-log-detail-tabs button')).find(b=>b.textContent==='参数快照')`);
 assert.ok(await ev('document.querySelector("#px4-panel-logs .px4-details").textContent.includes("TEST_INT")'));
 await ev('window.holdLogs=true');
 await click(`document.querySelector('[aria-label="选择日志 42"]')`);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('下载所选（1）'))`);
 await until('window.job===2');
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='取消下载')`);
 await until('window.cancelled===2');
 await click(`document.getElementById('px4-tab-nsh')`);
 await until('window.term && window.shellInput.includes("\\n")');
 const terminalText=`Array.from({length:window.term.buffer.active.length},(_,i)=>window.term.buffer.active.getLine(i)?.translateToString(true)||'').join('\\n')`;
 await until(`(${terminalText}).includes('nsh> ')`);
 await ev(`document.querySelector('#px4-panel-nsh .xterm-helper-textarea').focus()`);
 await send('Input.insertText',{text:'ver all'});await until(`(${terminalText}).includes('nsh> ver all')`);
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until(`(${terminalText}).includes('Result: ver all')`);
 await click(`Array.from(document.querySelectorAll('#px4-panel-nsh button')).find(b=>b.textContent==='Ctrl+C')`);
 await until('window.shellInput.includes("\\x03")');
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-nsh.png',Buffer.from(r.data,'base64'));}
 for(const width of[1050,768,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert.ok(await ev('document.querySelector(".px4-toolbox").getBoundingClientRect().right<=innerWidth+1'));}
 assert.deepEqual(ui.errors,[],'no unhandled browser errors');
 await ev('window.unmount()');await until('window.toolClosed>0');
 await ev('window.mountOriginal("usb")');
 await until('document.querySelector(".nsh-prompt input")');
 await ev(`window.change(document.querySelector('.nsh-prompt input'),'ver all');document.querySelector('.nsh-prompt input').focus()`);
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until('window.calls.some(c=>c.command==="nsh_execute"&&c.args.command==="ver all")');
 await until('document.querySelector(".nsh-terminal pre").textContent.includes("legacy result")');
 await ev('window.mountOriginal("network")');
 await until('window.rawChannel && document.querySelector(".nsh-console .xterm-helper-textarea")');
 await until(`(${terminalText}).includes('nsh> ')`);
 assert.ok(await ev('window.calls.some(c=>c.command==="tool_transport_open"&&c.args.owner==="nsh"&&c.args.network.mode==="tcpClient")'));
 await ev('window.unmount()');
 console.log('PASS: automatic simulator forwarding without connect controls, early heartbeat discovery, firmware metadata, integer parameters, export, search/custom grouping, complete log download, cancellation, real xterm keyboard/continuous shell path, responsive layouts and teardown.');
}finally{await ui.close();}
