import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const work=await mkdtemp(path.join(tmpdir(),'runtime-parameters-'));
try {
 const output=path.join(work,'params.cjs');
 await build({stdin:{contents:`export * from './client/src/sim/runtimeParameters';export {buildSignalGraph,graphToChannels} from './client/src/utils/signalGraph';`,resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {projectParameterChanges,componentParameterKey,expressionParameters,environmentFromProject,buildSignalGraph,graphToChannels}=createRequire(import.meta.url)(output);
 const node={id:'module',data:{componentType:'flight_control',params:{channels:JSON.stringify([{name:'FCS',items:[
  {type:'pure_gain',name:'fcs/gain',componentProps:{input:{value:'fcs/input'},gain:{value:'2'}},cliptoMin:'-2',cliptoMax:'2'},
  {type:'constant',name:'fcs/constant',componentProps:{constant:{value:'3'}}},
  {type:'fcs_function',name:'fcs/function',expression:{kind:'product',children:[{kind:'value',value:2},{kind:'value',value:3}]}}
 ]}])}}};
 const before={nodes:[node]},after=structuredClone(before);
 const channels=JSON.parse(after.nodes[0].data.params.channels);
 channels[0].items[0].componentProps.gain.value='4';
 channels[0].items[0].cliptoMin='10';channels[0].items[0].cliptoMax='20';
 channels[0].items[1].componentProps.constant.value='5';
 channels[0].items[2].expression.children[0].value=7;
 after.nodes[0].data.params.channels=JSON.stringify(channels);
 const edits=projectParameterChanges(before,after);
 assert.equal(edits.length,5);
 assert.deepEqual(edits.slice(0,3),[{key:componentParameterKey('fcs/gain','gain'),value:4},{key:componentParameterKey('fcs/gain','clip-min'),value:10},{key:componentParameterKey('fcs/gain','clip-max'),value:20}]);
 assert.equal(edits[3].key,expressionParameters('fcs/constant',{kind:'value',value:5})[0].key);
 const structural=structuredClone(after);const changed=JSON.parse(structural.nodes[0].data.params.channels);
 changed[0].items[2].expression.children.unshift({kind:'value',value:11});
 structural.nodes[0].data.params.channels=JSON.stringify(changed);
 const later=structuredClone(structural),lc=JSON.parse(later.nodes[0].data.params.channels);lc[0].items[2].expression.children[1].value=8;later.nodes[0].data.params.channels=JSON.stringify(lc);
 assert.deepEqual(projectParameterChanges(structural,later,before),[],'structural edit cannot later tune a shifted literal in the old runtime');
 const oneLimit=structuredClone(before),cl=JSON.parse(oneLimit.nodes[0].data.params.channels);cl[0].items[0].cliptoMin='-1';oneLimit.nodes[0].data.params.channels=JSON.stringify(cl);
 assert.deepEqual(projectParameterChanges(before,oneLimit).map(e=>e.value),[-1,2],'bounds are sent together');
 const env={nodes:[{id:'env',data:{componentType:'environment',params:{wind_north_fps:{value:3.048,unit:'M/SEC'},turbulence_type:'3'}}}]};
 assert.ok(Math.abs(environmentFromProject(env).windNorthFps-10)<1e-6);
 const env2=structuredClone(env);env2.nodes[0].data.params.wind_north_fps.value=6.096;
 assert.equal(projectParameterChanges(env,env2)[0].key,'atmosphere/wind-north-fps'); assert.ok(Math.abs(projectParameterChanges(env,env2)[0].value-20)<1e-6);
 const flatBefore=structuredClone(before),flatAfter=structuredClone(before);
 for(const project of [flatBefore,flatAfter]){const list=JSON.parse(project.nodes[0].data.params.channels),it=list[0].items[0];delete it.cliptoMin;delete it.cliptoMax;it.componentProps.clipto_min={value:'-2',attrs:{}};it.componentProps.clipto_max={value:'2',attrs:{}};project.nodes[0].data.params.channels=JSON.stringify(list);}
 const flat=JSON.parse(flatAfter.nodes[0].data.params.channels);flat[0].items[0].componentProps.clipto_max.value='1';flatAfter.nodes[0].data.params.channels=JSON.stringify(flat);
 assert.deepEqual(projectParameterChanges(flatBefore,flatAfter).map(e=>e.value),[1,-2],'parsed clipto_min/clipto_max fields map to the native pair');
 const normalized=structuredClone(after);const nc=JSON.parse(normalized.nodes[0].data.params.channels);nc[0].items[0].componentProps.gain.attrs={};nc[0].items[0].componentProps.input.attrs={};normalized.nodes[0].data.params.channels=JSON.stringify(nc);
 assert.deepEqual(projectParameterChanges(before,normalized),edits,'empty XML attribute maps do not look like structural edits');
 const importedChannels=[{name:'Pitch',attrs:{},items:[{type:'pure_gain',name:'vt_pitch_input_limit',expression:{kind:'value',value:0},componentProps:{
  input:{value:'fcs/voliro_t/pitch-cmd-norm',attrs:{}},gain:{value:'1',attrs:{}},clipto_min:{value:'-1',attrs:{}},clipto_max:{value:'1',attrs:{}},output:{value:'fcs/voliro_t/pitch-cmd-limited-norm',attrs:{}}
 }}]}];
 const project=channels=>({nodes:[{id:'actuators',data:{componentType:'system',params:{channels:JSON.stringify(channels)}}}]});
 const imported=project(importedChannels),graph=buildSignalGraph(importedChannels),gain=graph.nodes.find(node=>node.data.kind==='component');
 gain.data.compProps.clipto_max={value:'0.5',attrs:{}};
 const committed=project(graphToChannels(graph.nodes,graph.edges));
 assert.deepEqual(projectParameterChanges(imported,committed),[
  {key:componentParameterKey('vt_pitch_input_limit','clip-max'),value:.5},{key:componentParameterKey('vt_pitch_input_limit','clip-min'),value:-1}
 ],'first imported gain edit survives canvas serialization and sends both clip bounds');
 gain.data.compProps.clipto_max={value:'0.25',attrs:{}};
 const repeated=project(graphToChannels(graph.nodes,graph.edges));
 assert.equal(projectParameterChanges(committed,repeated,imported)[0].value,.25,'later edits still match the imported running baseline');
 gain.data.inputs=['other/input'];
 const rewired=project(graphToChannels(graph.nodes,[]));
 assert.deepEqual(projectParameterChanges(repeated,rewired,imported),[],'a real input rewire remains a structural change');
 const phantom=structuredClone(imported);const phantomItems=JSON.parse(phantom.nodes[0].data.params.channels);phantomItems[0].items[0].expression.value=9;phantom.nodes[0].data.params.channels=JSON.stringify(phantomItems);
 assert.deepEqual(projectParameterChanges(imported,phantom),[],'parser placeholder is never sent as a runtime constant');
 console.log('PASS: stable native parameter identities, numeric deltas, paired limits, constants, environment units and structural edit isolation');
} finally {await rm(work,{recursive:true,force:true});}
