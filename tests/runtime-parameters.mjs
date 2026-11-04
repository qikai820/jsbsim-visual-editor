import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const work=await mkdtemp(path.join(tmpdir(),'runtime-parameters-'));
try {
 const output=path.join(work,'params.cjs');
 await build({entryPoints:['client/src/sim/runtimeParameters.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {projectParameterChanges,componentParameterKey,expressionParameters,environmentFromProject}=createRequire(import.meta.url)(output);
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
 console.log('PASS: stable native parameter identities, numeric deltas, paired limits, constants, environment units and structural edit isolation');
} finally {await rm(work,{recursive:true,force:true});}
