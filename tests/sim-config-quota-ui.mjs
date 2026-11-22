// Real configuration dialog and property browser in a full browser profile.
// All simulator IPC is mocked: this test never connects to a controller/board.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';

const setup = `
localStorage.setItem('jsbsim-language','en-US');
localStorage.setItem('jsbsim-project','preserved project');
localStorage.setItem('jsbsim-remote-baseline:MorphQuad','preserved baseline');
// Use the browser's actual quota, rather than a mock exception alone.
for(let size=1024*1024;size>=1;size=Math.floor(size/2)){
  let index=0;try{while(true)localStorage.setItem('quota-filler:'+size+':'+index++,'x'.repeat(size));}catch(error){if(error.name!=='QuotaExceededError')throw error;}
}
window.__quotaFailures=0;const store=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){try{return store.call(this,key,value)}catch(error){window.__quotaFailures++;throw error}};
const callbacks=new Map();let callbackId=0;window.__events=new Map();window.__calls=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(event,id){window.__events.get(event)?.delete(id)}};
window.__TAURI_INTERNALS__={transformCallback(callback){const id=++callbackId;callbacks.set(id,callback);return id},unregisterCallback(id){callbacks.delete(id)},invoke:(command,args)=>{if(command==='plugin:event|listen'){const id=++callbackId;if(!window.__events.has(args.event))window.__events.set(args.event,new Map());window.__events.get(args.event).set(id,callbacks.get(args.handler));return Promise.resolve(id)}if(command==='plugin:event|unlisten')return Promise.resolve();return window.native(command,args)}};
window.__emit=(event,payload)=>{for(const[id,callback]of window.__events.get(event)||[])callback({event,id,payload})};
window.confirm=()=>true;`;
const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import SimulationConfigDialog from './src/components/SimulationConfigDialog';import PropertyTree from './src/components/PropertyTree';import './src/App.css';
window.native=async(command,args)=>{window.__calls.push({command,args});
 if(command==='get_sim_status')return{connected:true,latest:{model:'MorphQuad','/attitude/phi-deg':12}};
 if(command==='sim_instance_snapshot')return{instance_id:args.instanceId,model:args.instanceId==='01'?'MorphQuad':'voliro_t',properties:window.snapshotProperties||{}};
 if(command==='ftp_download_sim_config')return{content:window.savedConfig||JSON.stringify({version:1,mcap:{selectedVariables:['/fcs/selected'],criticalVariables:['/fcs/selected']}})};
 if(command==='ftp_upload_sim_config'){window.savedConfig=args.content;return{path:args.path,saved:true}};
 if(command==='ftp_get_simulator_version')return{version:{product:'JSBSim Realtime',version:'quota-test'}};
 if(command==='sim_network_read')return[{name:'eth0',address:'192.168.144.82',netmask:'255.255.255.0',gateway:'0.0.0.0'}];
 if(command==='plotjuggler_set_rate')return{rateHz:args.rateHz};
 return null;
};
class Boundary extends React.Component{state={error:''};static getDerivedStateFromError(error){return{error:error.message}}render(){return this.state.error?<div id="fatal">{this.state.error}</div>:this.props.children}}
function Harness(){const[open,setOpen]=useState(true),[instance,setInstance]=useState('01'),[tree,setTree]=useState(null);window.setTree=setTree;return <Boundary><button id="open" onClick={()=>setOpen(true)}>Open configuration</button>{open&&<SimulationConfigDialog key={instance} instanceId={instance} model={instance==='01'?'MorphQuad':'voliro_t'} slots={{'01':'MorphQuad','02':'voliro_t'}} onSelectInstance={setInstance} onClose={()=>setOpen(false)}/>}<div style={{display:'none'}}><PropertyTree telemetry={tree} pinnedPaths={[]} onPin={()=>{}} onUnpin={()=>{}} unitSystem="imperial"/></div></Boundary>}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);`;
const ui = await uiBrowser(source, { setup, port: 5198 });
const { ev, until, click, send } = ui;
const tab = label => `[...document.querySelectorAll('.sim-config-layout nav button')].find(button=>button.textContent===${JSON.stringify(label)})`;
const variables = `document.querySelector('.mcap-variable-list')?.textContent`;
try {
  await until(`document.querySelector('.sim-config-dialog footer')?.textContent.includes('Current configuration')`);
  await click(tab('MCAP Logging'));
  await until(`${variables}?.includes('/attitude/phi-deg')`);
  assert.ok(await ev('window.__quotaFailures > 0'), 'live telemetry exercised a real quota failure');
  assert.equal(await ev(`document.getElementById('fatal')?.textContent||''`), '');
  await ev(`window.__emit('telemetry',{model:'MorphQuad','/velocities/vt-fps':42})`);
  await until(`${variables}?.includes('/velocities/vt-fps')`);
  await ev(`window.snapshotProperties={'/attitude/theta-deg':3};window.setTree({'/position/lat-gc-deg':34})`);
  await until(`${variables}?.includes('/attitude/theta-deg')`);
  await until(`window.__quotaFailures >= 3`);
  assert.ok(await ev(`document.querySelector('.mcap-selected-variables').textContent.includes('/fcs/selected')`), 'persisted model selections survive cache failures');
  // Device writes must succeed independently of preference/cache persistence.
  await click(tab('Runtime & Time'));
  await ev(`(()=>{const input=document.getElementById('sim-config-plot-rate');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'75');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click(`document.querySelector('.sim-config-plotjuggler button')`);
  await until(`document.querySelector('.sim-config-plotjuggler').textContent.includes('Applied; preference not saved')`);
  assert.ok(await ev(`document.querySelector('.sim-config-plotjuggler').textContent.includes('Current: 75 Hz')`));
  await click(`document.querySelector('.simulator-version-card button:nth-of-type(2)')`);
  await click(`[...document.querySelectorAll('.sim-config-version-actions button')].find(button=>button.textContent==='Save snapshot')`);
  await until(`document.querySelector('.sim-config-version-manager [role=status]')?.textContent.includes('Snapshot not saved')`);
  assert.ok(await ev(`document.querySelector('.sim-config-version-list').textContent.includes('No version snapshots')`), 'failed snapshots are never reported as saved');
  await click(`document.querySelector('.sim-config-version-manager header button')`);
  await click(tab('MCAP Logging'));
  const rate = `[...document.querySelectorAll('.sim-config-field')].find(el=>el.textContent.includes('State and critical field rate')).querySelector('input')`;
  await ev(`(()=>{const input=${rate};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'40');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await click(`document.querySelector('.sim-config-dialog footer .primary')`);
  await until(`document.querySelector('.sim-config-dialog footer').textContent.includes('Saved and verified')`);
  assert.equal(await ev('JSON.parse(window.savedConfig).mcap.rateHz'), 40);
  assert.deepEqual(await ev('JSON.parse(window.savedConfig).mcap.selectedVariables'), ['/fcs/selected']);
  await click(`document.querySelector('.sim-config-dialog > header > button')`);
  await click(`document.getElementById('open')`);
  await until(`document.querySelector('.sim-config-dialog')`);
  await click(tab('MCAP Logging'));
  await until(`${rate}.value==='40'`);
  await ev(`window.snapshotProperties={'/02/jsbsim/propulsion/engine/rpm':123};const select=document.querySelector('.sim-config-instance-picker select');select.value='02';select.dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('.sim-config-instance-picker select').value==='02'`);
  await click(tab('MCAP Logging'));
  await until(`${variables}?.includes('/propulsion/engine/rpm')`);
  assert.equal(await ev(`document.getElementById('fatal')?.textContent||''`), '');
  assert.equal(await ev(`localStorage.getItem('jsbsim-project')`), 'preserved project');
  assert.equal(await ev(`localStorage.getItem('jsbsim-remote-baseline:MorphQuad')`), 'preserved baseline');
  assert.equal(ui.errors.length, 0, JSON.stringify(ui.errors));
  await writeFile('/home/qikai820/tmp/jsbsim-config-quota-fixed.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('PASS: real full-storage dialog open/update/reopen, live and snapshot variables, property tree, instance switch, snapshot error, applied PlotJuggler rate and verified simulator save. IPC mocked; project/baseline preserved.');
} finally { await ui.close(); }
