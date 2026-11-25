import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {uiBrowser} from './support/ui-browser.mjs';
const setup=`window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(c,a)=>window.native(c,a)};window.change=(el,value)=>{Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};`;
const source=`import React from'react';import{createRoot}from'react-dom/client';import Workbench from './src/components/Px4FlightTest';import{useFlightTestStore}from'./src/flight-test/session';import'./src/App.css';import'./src/components/Px4Toolbox.css';
window.store=useFlightTestStore;window.calls=[];window.native=async(command,args)=>{window.calls.push({command,args});if(command==='flight_test_status')return{id:0,status:'idle',dryRun:true,activeBlocks:[],values:{},logs:[],rc:[0,0,0,0]};if(command==='flight_test_validate'){const d=new DOMParser().parseFromString(args.source,'application/xml');if(d.querySelector('parsererror'))throw Error('XML error');return{events:d.querySelectorAll('event').length,properties:d.querySelectorAll('run > property').length};}if(command==='flight_test_start')throw Error('UI validation must never start a test');return null;};
createRoot(document.getElementById('root')).render(<Workbench link={null} instance={1} bidirectional={false} disabled={false} beforeRun={async()=>{throw Error('No flight controls in this test');}}/>);`;
const ui=await uiBrowser(source,{setup,port:5208,width:1440,height:1000});
const{ev,until,click,send}=ui;
const button=text=>`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
try{
 await until('window.store&&document.querySelector(".flight-test")');
 const templateButton=`Array.from(document.querySelectorAll('.ft-toolbar button')).find(e=>e.textContent.trim()==='模板')`;
 // Use the same visible toolbar path as the user.
 await click(templateButton);await until('document.querySelector("[aria-label=选择内置测试]")');
 assert.equal(await ev(`document.querySelectorAll('optgroup[label="XCD20 起飞测试"] option').length`),2);
 for(const [id,count] of [['xcd20_normal_takeoff',3],['xcd20_rail_takeoff',1]]){
  await ev(`window.change(document.querySelector('[aria-label="选择内置测试"]'),${JSON.stringify(id)})`);
  assert.equal(await ev(`document.querySelector('[aria-label="内置测试目标高度"]').value`),'3');
  await click(button('载入脚本'));await until(`window.store.getState().workspace?.document?.requirements?.['xcd20-takeoff']===${count===3?0:1}`);
  assert.equal(await ev(`window.store.getState().workspace.document.aircraft`),'XCD20_FlightIdentified');
  assert.equal(await ev(`document.querySelectorAll('article.ft-arm').length`),count);
  assert(await ev(`document.querySelectorAll('article.ft-observe').length>10`));
  await click(button('JSBSim XML'));
  const before=await ev('window.calls.length');await click(button('校验 XML'));await until(`window.calls.length>${before}`);
  assert.equal(await ev(`window.calls.filter(c=>c.command==='flight_test_start').length`),0);
  await click(templateButton);
 }
 const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/home/qikai820/chatgpt_pro/formation/simulation/XCD20/test_scripts/toolbox_templates.png',Buffer.from(shot.data,'base64'));
 assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));
 console.log('PASS UI: XCD20 template group, both scripts load as editable blocks, 3 independent ordinary arms vs 1 rail arm, continuous checks visible, XML validation only, zero test-start calls.');
}finally{await ui.close();}
