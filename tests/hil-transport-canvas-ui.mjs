// Exercise real ReactFlow HIL nodes and the property editor; no hardware I/O.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';
const source = `
import React from 'react';import{createRoot}from'react-dom/client';
import{ReactFlow}from'@xyflow/react';import'@xyflow/react/dist/style.css';
import AircraftNode from './src/components/nodes/AircraftNode';
import PropertyPanel from './src/components/PropertyPanel';
import{useFlowStore}from'./src/store/flowStore';import{restoreHilTransport}from'./src/utils/restoreHilTransport';window.__restore=restoreHilTransport;import'./src/App.css';
const nodes=[['input','HIL_ACTUATOR_CONTROLS','AUTO'],['output','HIL_SENSOR','AUTO'],['output','HIL_GPS','AUTO'],['output','HIL_SENSOR','SERIAL'],['output','HIL_GPS','UDP']].map(([componentType,type,transport],i)=>({id:'hil-'+i,type:'aircraftComponent',position:{x:20+i*190,y:30},data:{label:'PX4',componentType,params:{type,transport,name:componentType==='input'?'0.0.0.0':'PX4',device:'/dev/ttyACM0',baud:'921600',host:'192.168.101.100',port:14560,rate:250}}}));
useFlowStore.setState({nodes,edges:[],selectedNodeId:'hil-0'});window.__nodes=()=>useFlowStore.getState().nodes;
function Harness(){const nodes=useFlowStore(s=>s.nodes);return <div style={{display:'flex',height:'100vh'}}><div style={{width:1000,height:550}}><ReactFlow nodes={nodes} edges={[]} nodeTypes={{aircraftComponent:AircraftNode}} minZoom={1} maxZoom={1}/></div><div style={{width:360,height:'100vh',overflow:'auto'}}><PropertyPanel/></div></div>};createRoot(document.getElementById('root')).render(<Harness/>);`;
const ui=await uiBrowser(source,{port:5197,width:1400,height:800});
const {ev,until,send}=ui;
try {
 await until(`document.querySelectorAll('.node-hil-transport').length===5`);
 const rows=await ev(`Array.from(document.querySelectorAll('.aircraft-node')).map(n=>({title:n.querySelector('.node-label').textContent,badge:n.querySelector('.node-hil-transport').textContent,text:n.textContent}))`);
 for(const row of rows.slice(0,3)){
  assert.equal(row.badge,'USB / 网口自动');assert.ok(row.text.includes('/dev/ttyACM0'));assert.ok(row.text.includes('USB 设备'));assert.ok(row.text.includes('14560'));assert.ok(!row.text.includes('网口 UDP'));
 }
 assert.equal(rows[0].title,'PX4 执行器输入');assert.equal(rows[1].title,'PX4 传感器输出');assert.equal(rows[2].title,'PX4 GPS 输出');assert.equal(rows[3].badge,'USB 串口');assert.equal(rows[4].badge,'网口 UDP');
 await until(`Array.from(document.querySelectorAll('select')).some(s=>s.value==='AUTO')`);
 const select=`Array.from(document.querySelectorAll('select')).find(s=>Array.from(s.options).some(o=>o.value==='AUTO'))`;
 assert.ok(await ev(`Array.from(document.querySelectorAll('select')).some(s=>s.value==='/dev/ttyACM0')`));
 await ev(`(()=>{const s=${select};s.value='UDP';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until(`document.querySelector('[data-id="hil-0"] .node-hil-transport').textContent==='网口 UDP'`);
 assert.ok(!await ev(`Array.from(document.querySelectorAll('select')).some(s=>s.value==='/dev/ttyACM0')`));
 await ev(`(()=>{const s=${select};s.value='AUTO';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until(`document.querySelector('[data-id="hil-0"] .node-hil-transport').textContent==='USB / 网口自动'`);
 assert.ok(await ev(`Array.from(document.querySelectorAll('select')).some(s=>s.value==='/dev/ttyACM0')`));
 const recovered=await ev(`(()=>{const nodes=window.__nodes().slice(0,3).map((n,i)=>({...n,position:{x:21+i,y:83+i},data:{...n.data,params:{...n.data.params,transport:undefined,device:undefined,baud:undefined,rate:123}}}));const xml='<fdm_config>'+nodes.map(n=>'<'+n.data.componentType+' name="'+n.data.params.name+'" type="'+n.data.params.type+'" transport="AUTO" device="/dev/ttyACM0" baud="921600"/>').join('')+'</fdm_config>';const project={nodes,edges:[],aircraft:{name:'MorphQuad'},xmlFiles:[{category:'main',path:'main.xml',currentXml:xml,originalXml:xml}],xmlEditBaseline:{nodes,edges:[],aircraft:{name:'MorphQuad'}}};const out=window.__restore(project);return{nodes:out.nodes,baseline:out.xmlEditBaseline.nodes,explicit:window.__restore({...project,nodes:[{...nodes[0],data:{...nodes[0].data,params:{...nodes[0].data.params,transport:'UDP'}}}]}).nodes[0].data.params.transport}})()`);
 for(const [i,n] of recovered.nodes.entries()){assert.equal(n.data.params.transport,'AUTO');assert.equal(n.data.params.device,'/dev/ttyACM0');assert.equal(n.data.params.baud,'921600');assert.equal(n.data.params.rate,123);assert.deepEqual(n.position,{x:21+i,y:83+i});assert.equal(recovered.baseline[i].data.params.transport,'AUTO');}
 assert.equal(recovered.explicit,'UDP');
 await send('Page.captureScreenshot',{format:'png'}).then(r=>writeFile('/home/qikai820/tmp/morphquad-auto-hil-20261117/canvas-display/hil-transport-canvas.png',Buffer.from(r.data,'base64')));
 console.log('PASS: three AUTO HIL nodes expose USB and UDP, serial/UDP labels remain distinct, property changes update the canvas, and legacy cached graphs recover missing endpoints without overwriting edits');
}finally{await ui.close();}
