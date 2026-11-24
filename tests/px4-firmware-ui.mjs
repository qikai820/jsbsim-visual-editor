// Real React rendering with mocked IPC; no serial or simulator I/O.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const source=`import React from 'react';import{createRoot}from'react-dom/client';import Px4Firmware from './src/components/Px4Firmware';import './src/components/Px4Toolbox.css';
const target={simulator:'192.0.2.1',path:'/dev/ttyACM0',vid:9900,pid:17,serialNumber:'TEST-FC',label:'/dev/ttyACM0 · PX4 · TEST-FC'};
const local={id:1,name:'cuav-test.px4',source:'/tmp/cuav-test.px4',boardId:7000,boardRevision:0,imageSize:1780848,description:'CUAV 7 Nano 自定义固件',gitIdentity:'test-build'};
window.snapshot={id:0,running:false,stage:'',completed:0,total:0,message:'',canCancel:false,target:null,firmware:null,board:null};window.calls=[];window.locked=false;
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.calls.push({command,args});
 if(command==='px4_firmware_status')return structuredClone(window.snapshot);
 if(command==='px4_firmware_ports')return[target];
 if(command==='px4_firmware_pick')return window.pickCancelled?null:local;
 if(command==='usb_file_storage')return[{volume:'data',mountPath:'/mnt/home',totalBytes:1000000000}];
 if(command==='usb_file_list'){if(window.listFailure)throw Error('仿真机暂不可用');return{files:args.path==='/mnt/home'?[{name:'firmware',directory:true,size:0},{name:'ignore.bin',directory:false,size:100}]:[{name:'remote.px4',directory:false,size:1500000},{name:'notes.txt',directory:false,size:20}]};}
 if(command==='px4_firmware_remote')return{...local,id:2,name:'remote.px4',source:'仿真机 192.0.2.1 · '+args.path};
 if(command==='px4_firmware_start'){window.snapshot={...window.snapshot,id:window.snapshot.id+1,running:true,stage:'waiting',message:'等待所选飞控 Bootloader：请重新插拔该飞控 USB',canCancel:true,target:args.target,firmware:args.selectionId===2?{...local,id:2,name:'remote.px4'}:local};return structuredClone(window.snapshot);}
 if(command==='px4_firmware_cancel'){window.snapshot={...window.snapshot,running:false,stage:'cancelled',canCancel:false,message:'已取消等待；未擦除飞控'};return structuredClone(window.snapshot);}
 throw Error('Unexpected IPC '+command);
}};
createRoot(document.getElementById('root')).render(<div className='px4-toolbox-overlay' style={{padding:0}}><div className='px4-toolbox' style={{width:'100%',height:'100%',borderRadius:0}}><Px4Firmware beforeOperation={async()=>{window.locked=true;}} onBusyChange={value=>{window.locked=value;}}/></div></div>);`;
const ui=await uiBrowser(source,{port:5207,width:1150,height:920,setup:'window.__TAURI_INTERNALS__={};'});const{ev,until,click,send}=ui;
const button=text=>`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`;
const clickText=text=>click(button(text));
const count=cmd=>ev(`window.calls.filter(c=>c.command===${JSON.stringify(cmd)}).length`);
try{
 await until(`document.querySelector('select')?.options.length===2`);
 assert.equal(await ev(`${button('开始升级')}.disabled`),true);
 assert.equal(await ev(`document.body.innerText.includes('飞控 USB 插在仿真机上')`),true);
 assert.equal(await ev(`document.body.innerText.includes('直连电脑')`),false);
 await clickText('从本地选择');await until(`document.body.innerText.includes('cuav-test.px4')`);assert.equal(await count('px4_firmware_start'),0,'choosing firmware cannot flash');
 await ev(`document.querySelector('select').value='/dev/ttyACM0';document.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))`);
 await click(`document.querySelector('input[type=checkbox]')`);await until(`${button('开始升级')}.disabled===false`);
 const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/px4-firmware-ui.png',Buffer.from(shot.data,'base64'));
 await clickText('开始升级');await until(`document.body.innerText.includes('等待所选飞控 Bootloader')`);
 assert.equal(await ev('window.locked'),true);assert.equal(await ev(`${button('从本地选择')}.disabled`),true);
 const request=await ev(`window.calls.find(c=>c.command==='px4_firmware_start').args`);assert.equal(request.target.simulator,'192.0.2.1');assert.equal(request.selectionId,1);
 await clickText('取消等待');await until(`document.body.innerText.includes('未擦除飞控')`);assert.equal(await ev('window.locked'),false);
 await clickText('从仿真机选择');await until(`document.querySelector('.firmware-browser')?.innerText.includes('/mnt/home')`);await until(`${button('上一级')}.disabled===true`);
 assert.equal(await ev(`document.querySelector('.firmware-browser').innerText.includes('ignore.bin')`),false);
 await click(`document.querySelector('.firmware-file-list button')`);await until(`document.querySelector('.firmware-file-list')?.innerText.includes('remote.px4')`);
 assert.equal(await ev(`document.querySelector('.firmware-file-list').innerText.includes('notes.txt')`),false);
 await click(`document.querySelector('.firmware-file-list button')`);await until(`document.body.innerText.includes('192.0.2.1')`);
 assert.equal(await ev(`window.calls.find(c=>c.command==='px4_firmware_remote').args.path`),'/mnt/home/firmware/remote.px4');
 assert.equal(await ev('document.querySelector("input[type=checkbox]").checked'),false,'new firmware needs acknowledgement');
 await click(`document.querySelector('input[type=checkbox]')`);await until(`${button('开始升级')}.disabled===false`);await clickText('开始升级');
 await ev(`window.snapshot={...window.snapshot,stage:'program',completed:500,total:1000,canCancel:false,message:'正在写入固件',board:{boardId:7000,boardRevision:1,protocol:5,flashSize:1966080}}`);
 await until(`document.querySelector('progress')?.value===500`);assert.equal(await ev(`${button('取消等待')}===undefined`),true);
 await ev(`window.snapshot={...window.snapshot,running:false,stage:'error',message:'CRC 校验失败；未启动固件，请重新升级'}`);await until(`document.body.innerText.includes('CRC 校验失败')`);assert.equal(await ev('window.locked'),false);
 await clickText('从仿真机选择');await until(`document.querySelector('.firmware-browser')`);await ev('window.listFailure=true');await clickText('刷新目录');await until(`document.body.innerText.includes('仿真机暂不可用')`);await ev('window.listFailure=false');await clickText('刷新目录');await until(`!document.body.innerText.includes('仿真机暂不可用')`);
 await send('Emulation.setDeviceMetricsOverride',{width:650,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await ev(`document.querySelector('.px4-firmware').scrollWidth<=document.querySelector('.px4-firmware').clientWidth`),true,'narrow window has no horizontal overflow');
 assert.equal(await ev(`getComputedStyle(document.querySelector('.firmware-grid')).gridTemplateColumns.split(' ').length`),1,'narrow window uses one column');
 const narrow=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/px4-firmware-ui-narrow.png',Buffer.from(narrow.data,'base64'));
 assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));console.log('PX4 firmware UI passed: local/simulator selection, port pinning, cancellation, write lock, CRC failure, directory retry and narrow layout.');
}finally{await ui.close();}
