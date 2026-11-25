import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const f=JSON.parse(await readFile('tests/fixtures/px4-mavlink.json','utf8'));
const setup=`window.calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>window.native(command,args)};window.change=(element,value)=>{Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};`;
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Toolbox from './src/components/Px4Toolbox';import OriginalNsh from './src/components/NshConsoleDialog';import ParameterEditor from './src/components/Px4ParameterEditor';import{useFlowStore}from'./src/store/flowStore';import{useSignalMonitorStore}from'./src/store/signalMonitorStore';import{Parser,encode,view,crc32}from'./src/px4/protocol';import{Px4Connection}from'./src/px4/connection';import{Terminal}from'@xterm/xterm';import './src/App.css';
const openConnection=Px4Connection.prototype.open;Px4Connection.prototype.open=async function(...args){window.latestPx4Connection=this;return openConnection.apply(this,args);};
const original=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.term=this;return original.apply(this,args);};
const fixtures=${JSON.stringify(f)};const parser=new Parser();let seq=0,channel,session=0,line='';window.toolClosed=0;window.saved=[];window.shellInput='';
useFlowStore.setState({nodes:[{id:'relay',type:'aircraftComponent',position:{x:0,y:0},data:{componentType:'mavlink_forwarder',params:{id:'qgc',name:'QGC MAVLink',qgc_port:14550,enabled:true,bidirectional:true}}},{id:'toolbox-relay',type:'aircraftComponent',position:{x:0,y:0},data:{componentType:'mavlink_forwarder',params:{id:'px4-toolbox',name:'PX4 工具箱转发',qgc_port:14553,enabled:true,bidirectional:true}}}]});
window.unloadModel=()=>{useFlowStore.setState({nodes:[]});useSignalMonitorStore.setState({instance:2});};
window.router={simulator:'127.0.0.1',state:'running',config:{device:'/dev/ttyACM0',baud:921600,host:'192.168.3.109',qgc_port:14550,toolbox_port:14553},active_config:{device:'/dev/ttyACM0',baud:921600,host:'192.168.3.109',qgc_port:14550,toolbox_port:14553},routes:[{name:'qgc',rx_bytes:1000,tx_bytes:20,errors:0,last_error:0},{name:'px4-toolbox',rx_bytes:1000,tx_bytes:30,errors:0,last_error:0}]};
const metadata={version:1,parameters:[{name:'TEST_INT',category:'Standard',group:'Custom Firmware',shortDesc:'Custom mode',longDesc:'Firmware original description',type:'Int32',default:0,min:-20000,max:20000,rebootRequired:true,values:[{value:-12345,description:'Original'},{value:-12346,description:'Updated'}]},{name:'MC_ROLLRATE_P',category:'Standard',group:'Multicopter Rate Control',shortDesc:'Roll rate P gain',longDesc:'Original firmware description',type:'Float',default:.15,min:.01,max:.3}]};
const text=new TextEncoder();const metaBytes=text.encode(JSON.stringify(metadata));const generalBytes=text.encode(JSON.stringify({version:1,metadataTypes:[{type:1,uri:'https://metadata.test/params.json',fileCrc:crc32(metaBytes)}]}));
const event=bytes=>channel.onmessage({kind:'data',sessionId:session,direction:'rx',timeMs:Date.now(),elapsedUs:1,peer:'127.0.0.1:40000',datagram:true,bytes:Array.from(bytes)});
const frame=(id,p)=>event(encode(id,p,seq++,7,1));
window.px4Print=(value,severity=6,id=0,chunk=0)=>{const p=new Uint8Array(54);p[0]=severity;p.set(new TextEncoder().encode(value).subarray(0,50),1);view(p).setUint16(51,id,true);p[53]=chunk;frame(253,p);};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedPrints=text;}}});

window.paramWrites=[];const paramValues=new Map();
window.flight={hitl:0,runningHil:false,gps:201,armed:false,rebooting:false,bootTime:60000};window.rebootCommands=[];
window.flightHeartbeat=()=>{if(!window.flight.rebooting){const p=new Uint8Array([0,0,0,0,2,12,(window.flight.runningHil?32:0)|(window.flight.armed?128:0),3,3]);frame(0,p);const attitude=new Uint8Array(28);view(attitude).setUint32(0,window.flight.bootTime,true);frame(30,attitude);window.flight.bootTime+=700;}};
setInterval(()=>{if(channel)window.flightHeartbeat();},700);
const parameterReply=name=>{if(name==='SYS_HITL'||name==='GPS_1_CONFIG'){const r=new Uint8Array(25);view(r).setInt32(0,name==='SYS_HITL'?window.flight.hitl:window.flight.gps,true);view(r).setUint16(4,4,true);view(r).setUint16(6,name==='SYS_HITL'?2:3,true);r.set(text.encode(name),8);r[24]=6;return r;}return paramValues.get(name)||new Parser().push(Uint8Array.from(name==='TEST_INT'?fixtures.int32:fixtures.float))[0].payload;};
const shell=data=>{const b=text.encode(data);for(let i=0;i<b.length;i+=70){const p=new Uint8Array(81);p[6]=10;p[7]=1;p[8]=Math.min(70,b.length-i);p.set(b.subarray(i,i+70),9);frame(126,p);}};
window.shellOutput=shell;
const file=Uint8Array.from([85,76,111,103,1,18,53,1,...Array.from({length:172},(_,i)=>i%256)]);window.logBytes=Array.from(file);
const summary={path:'/tmp/px4-fixture.ulg',name:'px4-fixture.ulg',size:file.length,version:1,duration:1,topics:[{name:'vehicle_status',multiId:0,samples:3,frequency:2}],parameters:{TEST_INT:-12345},info:{ver_sw:'test firmware'},dropoutCount:0,dropoutMs:0,truncated:false};
window.native=async(command,args)=>{window.calls.push({command,args});
if(command==='px4_router_read')return structuredClone(window.router);
if(command==='px4_router_apply'){if(window.rejectRouter)throw Error('板端转发配置已变化，请刷新后重新编辑');window.router.config={...args.config};window.router.active_config={...args.config};return structuredClone(window.router);}
if(command==='px4_router_control'){window.router.state=args.action==='start'?'running':'stopped';return structuredClone(window.router);}
if(command==='simulator_network_target_get')return '127.0.0.1';
if(command==='tool_simulator_nsh_target')return{host:'127.0.0.1',port:23};
if(command==='nsh_execute')return 'legacy result: '+args.command+'\\n';
if(command==='tool_transport_open'&&args.owner==='nsh'){window.rawChannel=args.onEvent;window.rawEmit=bytes=>args.onEvent.onmessage({kind:'data',sessionId:100,direction:'rx',timeMs:Date.now(),elapsedUs:1,peer:'127.0.0.1:23',datagram:false,bytes:Array.from(bytes)});window.rawEmit(text.encode('nsh> '));return{sessionId:100,path:'simulator NSH'};}
if(command==='tool_transport_write'&&args.owner==='nsh'){const value=new TextDecoder().decode(Uint8Array.from(args.bytes));window.rawInput=(window.rawInput||'')+value;window.rawEmit(text.encode(value==='\\r'?'\\r\\nsimulator result\\r\\nnsh> ':value));return args.bytes.length;}
if(command==='tool_transport_open'){channel=args.onEvent;session++;window.flightHeartbeat();return{sessionId:session,path:'simulator UDP'};}
if(command==='tool_transport_close'){window.toolClosed++;return;}
if(command==='tool_transport_pin_peer')return;
if(command==='px4_metadata_fetch')return Array.from(args.uri.endsWith('params.json')?metaBytes:generalBytes);
if(command==='px4_metadata_decode')return new TextDecoder().decode(Uint8Array.from(args.bytes));
if(command==='px4_parameters_save'){window.exported=args.text;return '/tmp/px4.params';}
if(command==='px4_log_begin'){window.job=(window.job||0)+1;window.saved=Array(file.length).fill(0);return window.job;}
if(command==='px4_log_write'){args.bytes.forEach((b,i)=>window.saved[args.offset+i]=b);return;}
if(command==='px4_log_finish'||command==='px4_log_inspect'||command==='px4_log_pick')return summary;
if(command==='px4_log_cancel'){window.cancelled=args.id;return;}
if(command==='px4_log_relay'){window.relayProgress={staged:file.length/2,saved:0,copying:false};await new Promise(resolve=>setTimeout(resolve,500));window.relayProgress={staged:file.length,saved:file.length/2,copying:true};await new Promise(resolve=>setTimeout(resolve,500));window.saved=Array.from(file);return;}
if(command==='px4_log_relay_progress')return window.relayProgress;
if(command==='tool_transport_write'){for(const m of parser.push(Uint8Array.from(args.bytes))){const p=m.payload,d=view(p);
 if(m.id===21){event(Uint8Array.from(fixtures.int32));event(Uint8Array.from(fixtures.float));}
 if(m.id===23){const name=new TextDecoder().decode(p.subarray(6,22)).split('\\0')[0];window.paramWrites.push({name,value:p[22]===6?d.getInt32(0,true):d.getFloat32(0,true),bytes:Array.from(p)});const r=parameterReply(name).slice();if(!window.rejectParamWrites){r.set(p.subarray(0,4),0);if(name==='SYS_HITL')window.flight.hitl=d.getInt32(0,true);if(name==='GPS_1_CONFIG')window.flight.gps=d.getInt32(0,true);}paramValues.set(name,r);frame(22,r);}
 if(m.id===20){const name=new TextDecoder().decode(p.subarray(4,20)).split('\\0')[0];frame(22,parameterReply(name));}
 if(m.id===76){const requested=d.getFloat32(0,true);if(requested===397||requested===395){const r=new Uint8Array(108);view(r).setUint32(4,crc32(generalBytes),true);r.set(text.encode('https://metadata.test/general.json'),8);frame(397,r);}if(requested===148){const r=new Uint8Array(78);view(r).setBigUint64(0,16n,true);view(r).setBigUint64(8,1234n,true);view(r).setUint32(16,0x010f0300,true);frame(148,r);}}
 if(m.id===76&&d.getUint16(28,true)===246){window.rebootCommands.push(Array.from(p));const ack=new Uint8Array(10);view(ack).setUint16(0,246,true);ack[2]=window.rejectReboot?1:0;ack[8]=254;ack[9]=190;frame(77,ack);if(!window.rejectReboot){window.flight.rebooting=true;setTimeout(()=>{window.flight.rebooting=false;window.flight.bootTime=10;window.flight.runningHil=window.flight.hitl>0;if(window.flight.runningHil)window.flight.gps=0;window.flightHeartbeat();},window.rebootDelay??120);}}
 if(m.id===117){const r=new Uint8Array(14),v=view(r);v.setUint32(0,1700000000,true);v.setUint32(4,file.length,true);v.setUint16(8,42,true);v.setUint16(10,1,true);v.setUint16(12,42,true);frame(118,r);}
 if(m.id===119&&!window.holdLogs){const offset=d.getUint32(0,true),count=d.getUint32(4,true);for(let at=offset;at<Math.min(offset+count,file.length);at+=90){const b=file.subarray(at,Math.min(at+90,offset+count,file.length)),r=new Uint8Array(97);view(r).setUint32(0,at,true);view(r).setUint16(4,42,true);r[6]=b.length;r.set(b,7);frame(120,r);}}
 if(m.id===126&&p[7]!==0&&p[8]){const data=new TextDecoder().decode(p.subarray(9,9+p[8]));window.shellInput+=data;for(const c of data){if(c==='\\n'&&!line){shell('NSH ready\\r\\nnsh> ');}else if(c==='\\r'){const saved=line.match(/if param save; then echo (PX4S\\w+)0;/);shell('\\r\\n'+(saved?saved[1]+(window.failParamSave?'1':'0'):'Result: '+line)+'\\r\\nnsh> ');line='';}else if(c==='\\x03'){line='';shell('^C\\r\\nnsh> ');}else if(c==='\\x15'){line='';shell('\\r\\x1b[Knsh> ');}else{line+=c;shell(c);}}}
}return args.bytes.length;}
return null;};
window.unmount=()=>root.unmount();window.mountToolbox=()=>{root=createRoot(document.getElementById('root'));root.render(<Toolbox onClose={()=>root.unmount()}/>);};window.mountOriginal=mode=>{root.unmount();localStorage.setItem('jsbsim-simulator-transport',mode);root=createRoot(document.getElementById('root'));root.render(<OriginalNsh onClose={()=>root.unmount()}/>);};window.mountReadOnlyEditor=()=>{root=createRoot(document.getElementById('root'));root.render(<ParameterEditor parameter={{name:'TEST_INT',value:0,type:6,index:0}} meta={{...metadata.parameters[0],readOnly:true,values:[],bitmask:[]}} matched={true} connected={true} bidirectional={true} bytewise={true} busy={false} onWrite={()=>window.readOnlyWrite=true}/>);};let root=createRoot(document.getElementById('root'));root.render(<Toolbox onClose={()=>root.unmount()}/>);`;
const ui=await uiBrowser(source,{setup});
const {ev,until,click,send}=ui;
try{
 await until('document.querySelector(".px4-status.connected")');
 await until('document.querySelector(".px4-metadata-status").textContent.includes("飞控匹配")');
 assert.equal(await ev(`Array.from(document.querySelectorAll('.px4-toolbox button')).some(b=>/^(连接|断开|连接设置|连接终端)$/.test(b.textContent))`),false,'no separate connection controls');
 assert.equal(await ev(`window.calls.find(c=>c.command==='tool_transport_open').args.network.localPort`),14553);
 assert.equal(await ev(`window.calls.find(c=>c.command==='tool_transport_open').args.serial`),null);
 await ev(`window.px4Print('Ready before opening print page');window.px4Print('Preflight sensor warning',4);window.px4Print('Motor failure',3);`);
 await click(`document.getElementById('px4-tab-messages')`);
 await until(`document.querySelectorAll('.px4-message-row').length===3`);
 assert.equal(await ev(`document.querySelector('.px4-message-text').textContent`),'Ready before opening print page','other tabs continue receiving');
 assert.equal(await ev(`window.calls.some(c=>c.command==='tool_transport_write'&&new Uint8Array(c.args.bytes)[7]===126)`),false,'opening prints never opens NSH');
 await ev(`window.change(document.querySelector('[aria-label="PX4 打印级别"]'),'4')`);
 await until(`document.querySelectorAll('.px4-message-row').length===2`);
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 打印"]'),'motor')`);
 await until(`document.querySelectorAll('.px4-message-row').length===1`);
 await click(`Array.from(document.querySelectorAll('.px4-message-actions button')).find(b=>b.textContent==='复制显示内容')`);
 await until(`window.copiedPrints?.includes('Motor failure')`);
 assert.equal(await ev(`window.copiedPrints.includes('Ready before')`),false,'copy follows visible filter');
 await ev(`window.change(document.querySelector('[aria-label="PX4 打印级别"]'),'all');window.change(document.querySelector('[aria-label="搜索 PX4 打印"]'),'')`);
 await click(`Array.from(document.querySelectorAll('.px4-message-actions button')).find(b=>b.textContent==='暂停显示')`);
 await ev(`window.px4Print('Received while paused')`);
 await until(`document.querySelector('.px4-message-footer').textContent.includes('已接收 4 条')`);
 assert.equal(await ev(`document.querySelectorAll('.px4-message-row').length`),3);
 await click(`Array.from(document.querySelectorAll('.px4-message-actions button')).find(b=>b.textContent==='继续显示')`);
 await until(`document.querySelectorAll('.px4-message-row').length===4`);
 await ev(`window.px4Print('X'.repeat(50),4,71,0);window.px4Print(' long message tail',4,71,1);`);
 await until(`document.querySelectorAll('.px4-message-row').length===5`);
 assert.ok(await ev(`document.querySelector('.px4-message-row:last-child').textContent.includes('X'.repeat(50)+' long message tail')`));
 for(const width of[1050,768,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert.ok(await ev(`document.querySelector('.px4-messages').scrollWidth<=document.querySelector('.px4-messages').clientWidth+1`),'print page fits '+width);}
 await send('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
 await ev(`for(let i=0;i<80;i++)window.px4Print('Telemetry message '+i);`);
 await until(`document.querySelectorAll('.px4-message-row').length===85`);
 assert.ok(await ev(`(()=>{const el=document.querySelector('.px4-message-output');return el.scrollHeight-el.scrollTop-el.clientHeight<5;})()`),'auto-scroll follows latest');
 await ev(`document.querySelector('.px4-message-output').scrollTop=0`);
 await until(`!document.querySelector('.px4-message-filter input[type=checkbox]').checked`);
 await ev(`window.px4Print('Do not move viewport')`);
 await until(`document.querySelectorAll('.px4-message-row').length===86`);
 assert.equal(await ev(`document.querySelector('.px4-message-output').scrollTop`),0);
 await click(`document.querySelector('.px4-message-filter input[type=checkbox]')`);
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-prints.png',Buffer.from(r.data,'base64'));}
 await click(`Array.from(document.querySelectorAll('.px4-message-actions button')).find(b=>b.textContent==='清空打印')`);
 await until(`document.querySelectorAll('.px4-message-row').length===0`);
 await ev(`window.px4Print('After clear')`);await until(`document.querySelectorAll('.px4-message-row').length===1`);
 await click(`document.getElementById('px4-tab-testing')`);
 await until(`!document.getElementById('px4-panel-testing').hidden&&document.querySelector('[data-block=b3]')`);
 assert.equal(await ev(`Array.from(document.querySelectorAll('.ft-toolbar button')).find(b=>b.textContent==='执行飞控测试').disabled`),true,'tests require confirmed HIL');
 assert.ok(await ev(`document.querySelector('.ft-parallel-lanes').children.length===2`),'parallel editor is integrated in the shared toolbox');
 assert.equal(await ev(`window.calls.filter(c=>c.command==='tool_transport_open').length`),1,'test editor reuses the existing connection');
 await click(`document.getElementById('px4-tab-parameters')`);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='读取全部')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===2');
 assert.ok(await ev('document.querySelector(".px4-param-table").textContent.includes("-12345")'));
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='导出当前组')`);
 await until('window.exported');assert.match(await ev('window.exported'),/TEST_INT\t-12345\t6/);
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'MC_ROLL')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===1');
 await click(`document.querySelector('.px4-param-pick')`);
 assert.ok(await ev('document.querySelector(".px4-details").textContent.includes("0.01")'));
 await ev(`window.change(document.querySelector('[aria-label="参数新值"]'),'0.7')`);
 assert.equal(await ev(`document.querySelector('.px4-parameter-editor button[type="submit"]').disabled`),true,'matched firmware range prevents invalid writes');
 await ev(`window.change(document.querySelector('[aria-label="参数新值"]'),'0.3')`);
 assert.equal(await ev(`document.querySelector('.px4-parameter-editor button[type="submit"]').disabled`),false,'FLOAT32 rounded maximum remains valid');
 await ev(`window.change(document.querySelector('[aria-label="参数新值"]'),'0.2')`);
 await click(`document.querySelector('.px4-parameter-editor button[type="submit"]')`);
 await until(`document.querySelector('[role="status"]').textContent.includes('MC_ROLLRATE_P 已写入并回读确认')`);
 assert.equal(await ev('window.paramWrites[0].value'),Math.fround(.2));
 assert.equal(await ev(`document.querySelector('.px4-current-value strong').textContent`),'0.2');
 await click(`Array.from(document.querySelectorAll('.px4-parameter-editor button')).find(b=>b.textContent==='使用默认值')`);
 assert.equal(await ev(`document.querySelector('[aria-label="参数新值"]').value`),'0.15');
 assert.equal(await ev('window.paramWrites.length'),1,'using a default only stages the value');
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'TEST_INT')`);
 await click(`document.querySelector('.px4-param-pick')`);
 await ev(`window.change(document.querySelector('[aria-label="参数枚举值"]'),'-12346')`);
 await click(`document.querySelector('.px4-parameter-editor button[type="submit"]')`);
 await until(`document.querySelector('[role="status"]').textContent.includes('TEST_INT 已写入并回读确认')`);
 assert.ok(await ev(`document.querySelector('[role="status"]').textContent.includes('需重启飞控')`));
 assert.equal(await ev('window.paramWrites[1].value'),-12346,'integer write uses byte-wise signed representation');
 await ev(`window.change(document.querySelector('[aria-label="参数新值"]'),'-12346.5')`);
 assert.ok(await ev(`document.querySelector('.px4-parameter-editor').textContent.includes('必须为整数')`));
 assert.equal(await ev(`document.querySelector('.px4-parameter-editor button[type="submit"]').disabled`),true);
 await ev(`window.rejectParamWrites=true;window.change(document.querySelector('[aria-label="参数新值"]'),'-12347')`);
 await click(`document.querySelector('.px4-parameter-editor button[type="submit"]')`);
 await until(`document.querySelector('.px4-notice.error').textContent.includes('飞控返回 -12346')`);
 assert.equal(await ev(`document.querySelector('.px4-current-value strong').textContent`),'-12346','rejected value never replaces actual current value');
 await ev(`window.rejectParamWrites=false;window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'MC_ROLL')`);
 await click(`document.querySelector('.px4-param-pick')`);
 await click(`document.querySelector('[aria-label="关闭错误提示"]')`);
 await ev(`window.change(document.querySelector('[aria-label="搜索 PX4 参数"]'),'')`);
 await click(`document.querySelector('.px4-new-group')`);
 await ev(`window.change(document.querySelector('[aria-label="新分组名称"]'),'Bench tuning')`);
 await click(`document.querySelector('.px4-groups form button')`);
 await until(`document.querySelector('[aria-label="参数分组方式"]').value==='custom'`);
 await ev(`document.querySelector('.px4-assign button').scrollIntoView({block:'nearest'})`);
 await click(`document.querySelector('.px4-assign button')`);
 await until('document.querySelectorAll(".px4-param-table tbody tr").length===1');
 await ev(`document.querySelector('.px4-details').scrollTop=0`);
 if(process.env.PX4_UI_SCREENSHOTS){await ev(`window.change(document.querySelector('[aria-label="参数新值"]'),'0.25')`);const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-parameters.png',Buffer.from(r.data,'base64'));}
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
 await ev('window.router.log_cache=true');
 await until(`document.querySelector('[aria-label="PX4 日志下载路径"]')?.value==='relay'`);
 await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='下载所选（1）')`);
 await until(`document.querySelector('.px4-download').textContent.includes('接收到任务机')`);
 await until(`document.querySelector('.px4-download').textContent.includes('下载到电脑')`);
 await until(`window.calls.filter(c=>c.command==='px4_log_finish').length===2`);
 assert.deepEqual(await ev(`window.calls.find(c=>c.command==='px4_log_relay').args.request`),{
   simulator:'127.0.0.1',sessionId:1,system:7,component:1,hardwareUid:'4d2',logId:42,time:1700000000,size:180,
 });
 assert.deepEqual(await ev('window.saved'),await ev('window.logBytes'));
 await click(`document.getElementById('px4-tab-nsh')`);
 await until('window.term && window.shellInput.includes("\\n")');
 const terminalText=`Array.from({length:window.term.buffer.active.length},(_,i)=>window.term.buffer.active.getLine(i)?.translateToString(true)||'').join('\\n')`;
 await until(`(${terminalText}).includes('nsh> ')`);
 await ev(`document.querySelector('#px4-panel-nsh .xterm-helper-textarea').focus()`);
 await send('Input.insertText',{text:'ver all'});await until(`(${terminalText}).includes('nsh> ver all')`);
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await until(`(${terminalText}).includes('Result: ver all')`);
 const opens=await ev('window.calls.filter(c=>c.command==="tool_transport_open").length');
 await ev('window.unloadModel()');await new Promise(r=>setTimeout(r,150));
 assert.equal(await ev('window.calls.filter(c=>c.command==="tool_transport_open").length'),opens,'model unload and instance changes preserve the service session');
 assert.equal(await ev('window.toolClosed'),0);
 assert.ok(await ev(`(${terminalText}).includes('Result: ver all')`));
 await click(`Array.from(document.querySelectorAll('#px4-panel-nsh button')).find(b=>b.textContent==='Ctrl+C')`);
 await until('window.shellInput.includes("\\x03")');
 await ev(`new Promise(resolve=>window.term.write('',resolve))`);
 const listing=['nsh> ls','/:','  bin/','  dev/','  etc/','  fs/','  obj/','  proc/','  var/','nsh> '];
 const terminalLines=`Array.from({length:window.term.buffer.active.cursorY+1},(_,i)=>window.term.buffer.active.getLine(i).translateToString(true))`;
 for(const eol of ['\n','\r\n']){
  await ev(`new Promise(resolve=>{window.term.reset();window.shellOutput(${JSON.stringify(listing.join(eol))});window.term.write('',resolve);})`);
  assert.deepEqual(await ev(terminalLines),listing,`directory listing keeps its indentation with ${JSON.stringify(eol)}`);
  assert.equal(await ev('window.term.buffer.active.cursorX'),5,'prompt returns to the first column');
 }
 await ev(`new Promise(resolve=>{window.term.reset();window.shellOutput('nsh> test\\r');window.shellOutput('\\nold\\r\\x1b[Knew\\r');window.shellOutput('\\nnsh> ');window.term.write('',resolve);})`);
 assert.deepEqual(await ev(terminalLines),['nsh> test','new','nsh> '],'split CRLF has no extra lines and carriage return/ANSI erase still work');
 await ev(`new Promise(resolve=>{window.term.reset();window.shellOutput(${JSON.stringify(listing.join('\n'))});window.term.write('',resolve);})`);
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-nsh.png',Buffer.from(r.data,'base64'));}
 for(const width of[1050,768,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert.ok(await ev('document.querySelector(".px4-toolbox").getBoundingClientRect().right<=innerWidth+1'));}
 await send('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
 await click(`document.getElementById('px4-tab-forwarding')`);
 await until(`document.querySelector('.px4-router-settings').textContent.includes('当前固件仅支持 USB')`);
 await ev(`window.router.source='udp'`);
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='刷新状态')`);
 await until(`document.querySelector('.px4-router-settings').textContent.includes('飞控来源：主实例 UDP HIL')`);
 await until(`document.querySelector('[aria-label="转发 USB 设备"]').value==="/dev/ttyACM0"`);
 const beforeSettings=await ev('window.calls.filter(c=>c.command==="tool_transport_open").length');
 if(await ev(`!!document.querySelector('[aria-label="关闭状态提示"]')`))await click(`document.querySelector('[aria-label="关闭状态提示"]')`);
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-forwarding.png',Buffer.from(r.data,'base64'));}
 await ev(`window.change(document.querySelector('[aria-label="工具箱转发端口"]'),'14550')`);
 assert.ok(await ev(`document.querySelector('.px4-router-settings').textContent.includes('必须使用不同')`));
 assert.ok(await ev(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='保存并应用').disabled`));
 await ev(`window.change(document.querySelector('[aria-label="工具箱转发端口"]'),'14554')`);
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='保存并应用')`);
 await until('window.calls.some(c=>c.command==="tool_transport_open"&&c.args.network.localPort===14554)');
 await until(`document.querySelector('.px4-router-settings').textContent.includes('配置已保存')`);
 assert.equal(await ev('window.router.config.qgc_port'),14550);
 await ev(`window.rejectRouter=true;window.change(document.querySelector('[aria-label="转发目标电脑 IP"]'),'192.168.3.110')`);
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='保存并应用')`);
 await until(`document.querySelector('.px4-router-settings').textContent.includes('板端转发配置已变化')`);
 assert.equal(await ev('window.router.config.host'),'192.168.3.109','failed save does not fabricate a local configuration');
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='放弃修改')`);
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='停止服务')`);
 await until('window.router.state==="stopped"');
 await click(`Array.from(document.querySelectorAll('.px4-router-settings button')).find(b=>b.textContent==='启动服务')`);
 await until('window.router.state==="running"');
 for(const width of[768,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert.ok(await ev('document.querySelector(".px4-router-settings").scrollWidth<=document.querySelector(".px4-router-settings").clientWidth+1'));}
 await send('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
 const modeButton=`document.querySelector('.px4-simulationbar button')`;
 const enter=`Array.from(document.querySelectorAll('.px4-simulationbar button')).find(b=>b.textContent==='进入仿真')`;
 const exit=`Array.from(document.querySelectorAll('.px4-simulationbar button')).find(b=>b.textContent==='退出仿真')`;
 const rebootButton=`document.querySelector('.px4-simulationbar [aria-label="重启飞控"]')`;
 assert.equal(await ev(`document.querySelectorAll('.px4-simulationbar button').length`),2,'one mode action and one independent reboot action');
 assert.equal(await ev(`(${modeButton}).textContent`),'进入仿真','normal heartbeat selects entry');
 // Preserve a legacy connection across a UI update: it receives heartbeats without storing the new mode field.
 const beforeLegacy=await ev('window.calls.filter(c=>c.command==="tool_transport_open"&&c.args.owner==="px4").length');
 await ev(`window.legacyConnection=window.latestPx4Connection;const legacyPacket=window.legacyConnection.transport.onPacket;window.legacyConnection.transport.onPacket=(...args)=>{legacyPacket(...args);delete window.legacyConnection.heartbeatMode;};window.flightHeartbeat();`);
 await until(`(${modeButton}).textContent==='等待飞控状态'&&(${modeButton}).disabled`);
 assert.ok(await ev(`document.getElementById('px4-simulation-hint').textContent.includes('正在读取')`));
 await until(`window.calls.filter(c=>c.command==='tool_transport_open'&&c.args.owner==='px4').length>${beforeLegacy}`);
 await until(`(${modeButton}).textContent==='进入仿真'&&!(${modeButton}).disabled`);
 assert.equal(await ev('window.latestPx4Connection===window.legacyConnection'),false,'incompatible live connections are rebuilt automatically');
 await ev('window.flight.armed=true;window.flightHeartbeat()');
 await until(`(${enter}).disabled&&(${rebootButton}).disabled`);
 assert.ok(await ev(`document.querySelector('.px4-simulationbar').textContent.includes('已解锁')`));
 await ev('window.flight.armed=false;window.flightHeartbeat()');
 await until(`!(${enter}).disabled`);
 await click(enter);
 await until(`(${modeButton}).textContent==='正在切换…'&&(${modeButton}).disabled`);
 await until(`document.querySelector('.px4-notice[role="status"]')?.textContent.includes('已进入仿真模式')`);
 assert.equal(await ev(`(${modeButton}).textContent`),'退出仿真','HIL heartbeat selects exit after reboot verification');
 assert.equal(await ev('window.rebootCommands.length'),1);
 assert.equal(await ev('window.flight.gps'),0);
 assert.equal(await ev(`JSON.parse(localStorage.getItem('px4-hitl-gps-backup-v1:4d2')).gps1Config`),201);
 assert.ok(await ev(`document.querySelector('.px4-simulationbar b').textContent.includes('仿真模式')`));
 await ev('window.unmount()');await until('window.toolClosed>0');await ev('window.mountToolbox()');
 await until(`document.querySelector('.px4-simulationbar b')?.textContent.includes('仿真模式')`);
 await click(exit);
 await until(`document.querySelector('.px4-notice[role="status"]')?.textContent.includes('已退出仿真模式')`);
 assert.equal(await ev(`(${modeButton}).textContent`),'进入仿真','normal mode restores entry action');
 assert.equal(await ev('window.flight.gps'),201,'GPS backup survives toolbox close/reopen');
 assert.equal(await ev(`localStorage.getItem('px4-hitl-gps-backup-v1:4d2')`),null);
 assert.equal(await ev('window.rebootCommands.length'),2);
 await ev('window.failParamSave=true');await click(enter);
 await until(`document.querySelector('.px4-notice.error')?.textContent.includes('保存失败')`);
 assert.equal(await ev('window.rebootCommands.length'),2,'failed persistence never sends reboot');
 assert.ok(await ev(`!!localStorage.getItem('px4-hitl-gps-backup-v1:4d2')`));
 await ev('window.failParamSave=false');await click(enter);
 await until(`document.querySelector('.px4-notice[role="status"]')?.textContent.includes('已进入仿真模式')`);
 await click(exit);await until(`document.querySelector('.px4-notice[role="status"]')?.textContent.includes('已退出仿真模式')`);
 assert.equal(await ev('window.flight.gps'),201);
 const writesBeforeReboot=await ev('window.paramWrites.length'),rebootsBefore=await ev('window.rebootCommands.length');
 await ev('window.rebootDelay=2800');
 await click(rebootButton);
 await until(`(${rebootButton}).textContent==='正在重启…'&&(${rebootButton}).disabled&&(${modeButton}).disabled`);
 await until(`document.querySelector('.px4-notice[role="status"]')?.textContent.includes('飞控已重启并重新连接')`);
 assert.equal(await ev('window.paramWrites.length'),writesBeforeReboot,'standalone reboot does not write parameters');
 assert.equal(await ev('window.rebootCommands.length'),rebootsBefore+1);
 assert.equal(await ev(`(${modeButton}).textContent`),'进入仿真','standalone reboot retains normal mode');
 await ev('window.rebootDelay=120');
 await ev('window.rejectReboot=true');await click(rebootButton);
 await until(`document.querySelector('.px4-notice.error')?.textContent.includes('拒绝重启')`);
 assert.equal(await ev(`(${rebootButton}).disabled`),false,'rejected reboot releases the operation lock');
 assert.equal(await ev('window.paramWrites.length'),writesBeforeReboot);
 await ev('window.rejectReboot=false');
 for(const width of[768,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert.ok(await ev('document.querySelector(".px4-simulationbar").scrollWidth<=document.querySelector(".px4-simulationbar").clientWidth+1'));}
 await send('Emulation.setDeviceMetricsOverride',{width:1360,height:900,deviceScaleFactor:1,mobile:false});
 if(process.env.PX4_UI_SCREENSHOTS){const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(process.env.PX4_UI_SCREENSHOTS+'-simulation.png',Buffer.from(r.data,'base64'));}
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
 await ev('window.mountReadOnlyEditor()');
 await until(`document.querySelector('[aria-label="参数新值"]')`);
 assert.equal(await ev(`document.querySelector('[aria-label="参数新值"]').disabled`),true,'firmware read-only parameter cannot be edited');
 assert.equal(await ev(`document.querySelector('.px4-parameter-editor button[type="submit"]').disabled`),true);
 await ev('window.unmount()');
 console.log('PASS: automatic forwarding, parameters/logs/NSH, passive PX4 prints with filters/pause/copy/clear/chunks/auto-scroll, heartbeat-driven mode action plus independent reboot, progress and mutual exclusion, standalone reboot/rejection without parameter writes, legacy recovery, HITL switching, GPS restoration, armed refusal, responsive layouts and teardown.');
}finally{await ui.close();}
