import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {uiBrowser} from './support/ui-browser.mjs';
const root=process.cwd(),work=await mkdtemp('/tmp/retired-forwarder-');
let ui;
try {
 await writeFile(work+'/Cargo.toml',`[package]\nname="retired-forwarder-test"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="check"\npath=${JSON.stringify(root+'/tests/support/model-sync-backend.rs')}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
 const build=spawnSync('cargo',['build','--offline','--quiet','--manifest-path',work+'/Cargo.toml'],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);
 const backend=(command,args)=>{const r=spawnSync(work+'/target/debug/check',{input:JSON.stringify({command,args}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);assert.ok(!p.error,p.error);return p;};
 const legacy='<input type="MAVLINK_FORWARD" id="qgc" qgc_host="192.168.3.109" qgc_port="14550" enabled="true"/>';
 const original=`<?xml version="1.0"?>\n<fdm_config name="RelayTest" version="2.0">\n<!-- keep exact comment -->\n${legacy}\n<input type='MAVLINK_FORWARD' id='px4-toolbox' qgc_port='14553'></input>\n<input type="HIL_ACTUATOR_CONTROLS" transport="SERIAL" device="/dev/ttyACM0" baud="921600"><property>test/a</property></input>\n<property name="custom/value" value="1.2300"/>\n</fdm_config>`;
 const parsed=backend('parse_xml',{xml:original,files:[]});assert.ok(!parsed.nodes.some(n=>n.data.componentType==='mavlink_forwarder'));assert.ok(parsed.nodes.some(n=>n.data.params.type==='HIL_ACTUATOR_CONTROLS'||n.data.componentType==='serial_hil'));
 const node=id=>({id,type:'aircraftComponent',position:{x:0,y:0},data:{label:id,componentType:'mavlink_forwarder',params:{id}}});
 const graph={aircraft:{name:'RelayTest'},nodes:[node('qgc'),node('px4-toolbox')],edges:[]};assert.ok(!backend('generate_xml',{data:graph}).xml.includes('MAVLINK_FORWARD'));
 ui=await uiBrowser(`import React from 'react';import{createRoot}from'react-dom/client';import Palette from './src/components/Palette';import{useFlowStore}from'./src/store/flowStore';import{removeLegacyForwarderXml}from'./src/utils/legacyForwarder';import{commentOutXml}from'./src/utils/disabledXml';import{prepareModelXml}from'./src/utils/modelXmlSync';import './src/App.css';
window.original=${JSON.stringify(original)};window.cleaned=removeLegacyForwarderXml(window.original);window.disabled=removeLegacyForwarderXml('<fdm_config>'+commentOutXml(${JSON.stringify(legacy)})+'</fdm_config>');
const graph=${JSON.stringify(graph)};graph.nodes.push({id:'keep',type:'aircraftComponent',position:{x:20,y:20},data:{componentType:'fuselage',params:{}}});graph.edges=[{id:'obsolete',source:'qgc',target:'keep'},{id:'retained',source:'keep',target:'keep'}];useFlowStore.getState().loadProject(graph);window.flow=useFlowStore;
window.prepared=()=>prepareModelXml({...graph,nodes:graph.nodes.filter(n=>n.id==='keep'),xmlFiles:[{path:'aircraft/RelayTest/RelayTest.xml',category:'main',originalXml:window.original,currentXml:window.cleaned}]},{...graph,xmlFiles:[{path:'aircraft/RelayTest/RelayTest.xml',category:'main',originalXml:window.original,currentXml:window.original}]},'RelayTest',{generateXml:async()=>'<fdm_config name="RelayTest" version="2.0"/>'});
createRoot(document.getElementById('root')).render(<Palette collapsed={false} width={250} onToggle={()=>{}} onResizeStart={()=>{}} onDragStart={()=>{}}/>);`,{port:5193});
 await ui.until('document.querySelector(".palette")');
 assert.equal(await ui.ev('flow.getState().nodes.length'),1);assert.deepEqual(await ui.ev('flow.getState().edges.map(e=>e.id)'),['retained']);
 assert.ok(!await ui.ev('document.querySelector(".palette").textContent.includes("MAVLink 转发")'));
 const cleaned=await ui.ev('window.cleaned');assert.ok(!cleaned.includes('MAVLINK_FORWARD'));assert.ok(cleaned.includes('<!-- keep exact comment -->'));assert.ok(cleaned.includes('value="1.2300"'));assert.ok(cleaned.includes('type="HIL_ACTUATOR_CONTROLS"'));
 assert.equal(await ui.ev('window.disabled'),'<fdm_config></fdm_config>');
 const prepared=await ui.ev('window.prepared()');assert.ok(prepared[0].dirty);assert.equal(prepared[0].content,cleaned,'source-preserving save removes old inputs even without generated node deltas');
 console.log('PASS: retired forwarding modules absent from palette/import/generation; cache nodes/edges migrated; legacy XML removal preserves HIL, comments and numeric bytes.');
} finally {await ui?.close();await rm(work,{recursive:true,force:true});}
