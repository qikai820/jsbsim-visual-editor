import assert from 'node:assert/strict';
import {uiBrowser} from './support/ui-browser.mjs';
const directory='/home/qikai820/src/PX4-Autopilot/build/px4_sitl_default';
const setup=`window.calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>window.native(command,args)};window.change=(element,value)=>{Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};`;
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Sitl from './src/components/Px4Sitl';import './src/components/Px4Toolbox.css';
window.build={directory:${JSON.stringify(directory)},executable:${JSON.stringify(directory+'/bin/px4')},ready:false,issues:['缺少 bin/px4，请先编译 PX4 SITL'],airframes:[{id:10016,model:'none_iris',name:'Generic Iris Quadrotor SITL'},{id:10040,model:'sihsim_quadx',name:'SIH Quad'}]};
window.state={running:false,pid:null,exitCode:null,config:null,plan:null,logs:[]};
window.native=async(command,args)=>{window.calls.push({command,args});
if(command==='local_sim_get')return window.localSimulator||{active:false};
if(command==='simulator_network_target_get')return window.noBoard?null:'192.168.3.82';
if(command==='px4_sitl_inspect')return structuredClone(window.build);
if(command==='px4_sitl_pick')return window.cancelPick?null:structuredClone(window.build);
if(command==='px4_sitl_preview'){if(args.config.mode==='hil-udp'&&!args.config.host)throw Error('需要仿真机 IPv4');return{executable:window.build.executable,args:['-d','-i',String(args.config.instance)],environment:{PX4_SYS_AUTOSTART:String(args.config.airframe)},workDirectory:'/tmp/px4-sitl-test',notes:['仅进程运行，不代表传感器已就绪']};}
if(command==='px4_sitl_status')return structuredClone(window.state);
if(command==='px4_sitl_start'){if(window.failStart)throw Error('HIL UDP 14560 不可用：Address already in use');window.state={running:true,pid:12345,exitCode:null,config:args.config,plan:{executable:window.build.executable,args:['-d'],environment:{PX4_SYS_AUTOSTART:String(args.config.airframe)},workDirectory:'/tmp/px4-sitl-test',notes:[]},logs:[{sequence:1,stream:'stdout',text:'PX4 boot output'},{sequence:2,stream:'stderr',text:'Waiting for sensor input'}]};return structuredClone(window.state);}
if(command==='px4_sitl_stop'){window.state.running=false;window.state.pid=null;window.state.exitCode=0;return structuredClone(window.state);}
throw Error(command);};
let root=createRoot(document.getElementById('root'));const render=()=>root.render(<div className="px4-toolbox"><Sitl/></div>);render();window.remount=()=>{root.unmount();root=createRoot(document.getElementById('root'));render();};`;
const ui=await uiBrowser(source,{setup,port:5194});
const {ev,until,click}=ui;
const button=label=>`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)})`;
try {
  await until(`document.body.textContent.includes('缺少 bin/px4')`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 构建目录"]').value`),directory);
  assert.equal(await ev(`${button('启动软件飞控')}.disabled`),true);
  assert.equal(await ev(`window.calls.some(c=>c.command==='px4_sitl_start')`),false);
  await ev(`window.build.ready=true;window.build.issues=[]`);
  await click(button('重新检测'));
  await until(`!${button('启动软件飞控')}.disabled`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 仿真机地址"]').value`),'192.168.3.82');
  await click(button('启动软件飞控'));
  await until(`document.querySelector('.sitl-badge').textContent.includes('PID 12345')`);
  assert.equal(await ev(`document.querySelector('[aria-label="软件飞控机型"]').disabled||document.querySelector('[aria-label="软件飞控机型"]').closest('fieldset').disabled`),true);
  assert.ok(await ev(`document.querySelector('[aria-label="软件飞控运行日志"]').textContent.includes('[stderr] Waiting for sensor input')`));
  await ev(`window.remount()`);
  await until(`document.querySelector('.sitl-badge').textContent.includes('PID 12345')`);
  assert.equal(await ev(`window.calls.filter(c=>c.command==='px4_sitl_start').length`),1,'remount must not start another process');
  await click(button('停止软件飞控'));
  await until(`document.querySelector('.sitl-badge').textContent.includes('已停止')`);
  await until(`!${button('启动软件飞控')}.disabled`);
  await ev(`window.failStart=true`);
  await click(button('启动软件飞控'));
  await until(`document.querySelector('[role="alert"]')?.textContent.includes('Address already in use')`);
  assert.equal(await ev(`document.querySelector('.sitl-badge').textContent.includes('运行中')`),false);
  await ev(`window.change(document.querySelector('[aria-label="软件飞控启动模式"]'),'sih')`);
  await until(`document.querySelector('[aria-label="软件飞控机型"]').value==='10040'`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]')`),null);
  await ev(`window.remount()`);
  await until(`document.querySelector('[aria-label="软件飞控启动模式"]').value==='sih'`);
  await ev(`window.cancelPick=true`);
  await click(button('选择文件夹'));
  await until(`!${button('选择文件夹')}.disabled`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 构建目录"]').value`),directory,'cancel preserves the directory');
  // Local runtime must win over an available board and use its active port.
  await ev(`window.localSimulator={active:true,ready:true,activeConfig:{hilHost:'127.0.0.1',hilPort:14562}};localStorage.removeItem('px4-sitl-config-v1');window.remount()`);
  await until(`document.querySelector('[aria-label="PX4 仿真机地址"]').value==='127.0.0.1'`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]').value`),'14562');
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 远端端口"]').value`),'14560');
  await ev(`window.change(document.querySelector('[aria-label="软件飞控启动模式"]'),'sih')`);
  await until(`!document.querySelector('[aria-label="PX4 HIL 本地端口"]')`);
  await ev(`window.change(document.querySelector('[aria-label="软件飞控启动模式"]'),'hil-udp')`);
  await until(`document.querySelector('[aria-label="PX4 仿真机地址"]').value==='127.0.0.1'`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]').value`),'14562');
  // Existing external settings remain explicit, even when local services are on.
  await ev(`localStorage.setItem('px4-sitl-config-v1',JSON.stringify({mode:'hil-udp',host:'192.168.3.90',localPort:14600,remotePort:14601}));window.remount()`);
  await until(`document.querySelector('[aria-label="PX4 仿真机地址"]').value==='192.168.3.90'`);
  await until(`document.body.textContent.includes('电脑端模型服务已就绪')`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]').value`),'14600');
  await click(button('使用本机模型连接'));
  await until(`document.querySelector('[aria-label="PX4 仿真机地址"]').value==='127.0.0.1'`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]').value`),'14562');
  // A standalone local simulator also works when no board is discovered.
  await ev(`window.localSimulator={active:false};window.noBoard=true;localStorage.removeItem('px4-sitl-config-v1');window.remount()`);
  await until(`document.querySelector('[aria-label="PX4 仿真机地址"]').value==='127.0.0.1'`);
  assert.equal(await ev(`document.querySelector('[aria-label="PX4 HIL 本地端口"]').value`),'14561');
  // Reopening the page discovers an already running PX4 and restores its actual config.
  const starts=await ev(`window.calls.filter(c=>c.command==='px4_sitl_start').length`);
  await ev(`window.state={...window.state,running:true,pid:54321,external:true,config:{...window.state.config,airframe:10016,host:'127.0.0.1',localPort:14561,remotePort:14560}};window.localSimulator={active:true,ready:false,activeConfig:{hilHost:'127.0.0.1',hilPort:14561}};localStorage.setItem('px4-sitl-config-v1',JSON.stringify({airframe:4005,host:'192.168.3.90'}));window.remount()`);
  await until(`document.querySelector('.sitl-badge').textContent.includes('PID 54321')`);
  await until(`document.querySelector('[aria-label="软件飞控机型"]').value==='10016'`);
  assert.equal(await ev(`document.querySelector('.sitl-actions').children.length`),1);
  assert.equal(await ev(`${button('停止软件飞控')}.disabled`),false);
  assert.equal(await ev(`window.calls.filter(c=>c.command==='px4_sitl_start').length`),starts,'detection must not start another PX4');
  await ev(`window.localSimulator.ready=true`);
  await until(`document.body.textContent.includes('电脑端模型服务已就绪')`);
  await click(button('停止软件飞控'));
  await until(`!${button('启动软件飞控')}.disabled`);
  assert.equal(ui.errors.length,0);
  console.log('PX4 SITL UI PASS: detection, preview, start, logs, ownership, stop, errors, mode and preferences');
} finally {await ui.close();}
