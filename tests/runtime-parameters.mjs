import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const work=await mkdtemp(path.join(tmpdir(),'runtime-parameters-'));
try {
 const output=path.join(work,'params.cjs');
 await build({stdin:{contents:`export * from './client/src/sim/runtimeParameters';export {useFlowStore} from './client/src/store/flowStore';export {buildSignalGraph,graphToChannels} from './client/src/utils/signalGraph';`,resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {projectParameterChanges,projectParameterDiagnostics,componentParameterKey,expressionParameters,environmentFromProject,inertiaParameterKey,buildSignalGraph,graphToChannels,useFlowStore}=createRequire(import.meta.url)(output);
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
 assert.deepEqual(projectParameterDiagnostics(before,after),[],'numeric component edits leave channel structure unchanged');
 assert.deepEqual(edits.slice(0,3),[{key:componentParameterKey('fcs/gain','gain'),value:4},{key:componentParameterKey('fcs/gain','clip-min'),value:10},{key:componentParameterKey('fcs/gain','clip-max'),value:20}]);
 assert.equal(edits[3].key,expressionParameters('fcs/constant',{kind:'value',value:5})[0].key);
 const structural=structuredClone(after);const changed=JSON.parse(structural.nodes[0].data.params.channels);
 changed[0].items[2].expression.children.unshift({kind:'value',value:11});
 structural.nodes[0].data.params.channels=JSON.stringify(changed);
 assert.equal(projectParameterDiagnostics(after,structural,before).length,1,'changing expression structure still requires reloading');
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
 assert.deepEqual(projectParameterDiagnostics(imported,repeated),[],'an imported system gain edit is not a channel change');
 gain.data.inputs=['other/input'];
 const rewired=project(graphToChannels(graph.nodes,[]));
 assert.deepEqual(projectParameterChanges(repeated,rewired,imported),[],'a real input rewire remains a structural change');
 assert.equal(projectParameterDiagnostics(imported,rewired).length,1,'rewiring a system still requires reloading');
 const reordered=structuredClone(before), reorderedChannels=JSON.parse(reordered.nodes[0].data.params.channels);
 reorderedChannels[0].items.reverse();
 reordered.nodes[0].data.params.channels=JSON.stringify(reorderedChannels);
 assert.equal(projectParameterDiagnostics(before,reordered).length,1,'channel execution order is structural');
 const phantom=structuredClone(imported);const phantomItems=JSON.parse(phantom.nodes[0].data.params.channels);phantomItems[0].items[0].expression.value=9;phantom.nodes[0].data.params.channels=JSON.stringify(phantomItems);
 assert.deepEqual(projectParameterChanges(imported,phantom),[],'parser placeholder is never sent as a runtime constant');
 const mass={nodes:[{id:'inertia',data:{componentType:'inertia',params:{ixx:{value:2.71188,unit:'KG*M2'},iyy:3,izz:4}}}]};
 const heavier=structuredClone(mass);heavier.nodes[0].data.params.ixx.value=8.13564;
 const massEdits=projectParameterChanges(mass,heavier);
 assert.equal(massEdits.length,6,'one inertia edit sends the entire symmetric tensor');
 assert.deepEqual(massEdits.map(edit=>edit.key),['ixx','iyy','izz','ixy','ixz','iyz'].map(inertiaParameterKey));
 assert.ok(Math.abs(massEdits[0].value-6)<1e-12);assert.deepEqual(massEdits.slice(1).map(edit=>edit.value),[3,4,0,0,0]);
 const unitsOnly=structuredClone(mass);unitsOnly.nodes[0].data.params.ixx={value:2,unit:'SLUG*FT2'};
 assert.deepEqual(projectParameterChanges(mass,unitsOnly),[],'changing display units preserves physical inertia');
 const multiple=structuredClone(heavier);multiple.nodes.push({...multiple.nodes[0],id:'other'});
 assert.deepEqual(projectParameterChanges(mass,multiple),[],'ambiguous inertia nodes cannot target the same base tensor');
 const invalid=structuredClone(mass);invalid.nodes[0].data.params.ixx.value=NaN;
 assert.deepEqual(projectParameterChanges(mass,invalid),[],'nonfinite drafts are never sent');
 const physical={nodes:[{id:'mass',data:{componentType:'fuselage',params:{emptywt:{value:10,unit:'KG'},cg:{x:1,y:2,z:3,unit:'M'}}}},{id:'wing',data:{componentType:'wing',params:{wingarea:{value:2,unit:'M2'},chord:{value:1,unit:'M'}}}}]};
 const physicalChanged=structuredClone(physical);physicalChanged.nodes[0].data.params.emptywt.value=20;physicalChanged.nodes[0].data.params.cg.y=4;physicalChanged.nodes[1].data.params.wingarea.value=3;
 const physicalEdits=projectParameterChanges(physical,physicalChanged);
 assert.ok(Math.abs(physicalEdits.find(e=>e.key==='_tuning/mass/emptywt').value-20/.45359237)<1e-12,'mass matches the exact XML conversion');
 assert.equal(physicalEdits.find(e=>e.key==='_tuning/mass/cg-y').value,4*3.2808399*12);
 assert.equal(physicalEdits.length,3);
 const table={kind:'table',tableType:'2D',var1:'x',var2:'y',var3:'',breakpoints1:[0,10],breakpoints2:[0,20],breakpoints3:[],data:[[1,3],[5,7]]};
 const props={nodes:[{id:'prop',data:{componentType:'propeller',params:{file:'prop',_source_file:'prop',diameter:2,tables:[{name:'C_THRUST',expression:table}],_tables:[{name:'C_THRUST',data:[[0,20],[0,1,3],[10,5,7]]}]}}}]};
 const tableChanged=structuredClone(props);tableChanged.nodes[0].data.params.tables[0].expression.data[0][0]=9;
 assert.deepEqual(projectParameterChanges(props,tableChanged),[{key:'_tuning/table/thruster/i0/C_THRUST/table/data/n4',value:9}]);
 const resized=structuredClone(tableChanged);resized.nodes[0].data.params.tables[0].expression.data.push([9,9]);resized.nodes[0].data.params.tables[0].expression.breakpoints1.push(30);
 assert.deepEqual(projectParameterChanges(tableChanged,resized,props),[]);assert.equal(projectParameterDiagnostics(tableChanged,resized,props).length,1,'table resize is explicitly reported');
 const shared={aircraft:{name:'test'},nodes:[0,1].flatMap(i=>[
  {id:'eng'+i,type:'aircraftComponent',position:{x:0,y:0},data:{componentType:'engine',params:{engine_type:'electric',file:'motor',_source_file:'motor',power:100,location:{x:0,y:0,z:0,unit:'IN'}}}},
  {id:'prop'+i,type:'aircraftComponent',position:{x:0,y:0},data:{componentType:'propeller',params:{...structuredClone(props.nodes[0].data.params),location:{x:0,y:0,z:0,unit:'IN'}}}}
 ]),edges:[0,1].map(i=>({id:'link'+i,source:'eng'+i,target:'prop'+i}))};
 useFlowStore.getState().loadProject(shared);const sharedBefore=structuredClone(useFlowStore.getState().nodes);
 useFlowStore.getState().updateNodeParams('eng0',{power:200});
 const sharedNext=useFlowStore.getState();assert.equal(sharedNext.nodes.find(n=>n.id==='eng1').data.params.power,200,'a shared engine file updates every instance card');
 assert.deepEqual(projectParameterChanges({nodes:sharedBefore,edges:shared.edges},sharedNext).map(e=>e.key),['_tuning/engine/i0/power','_tuning/engine/i1/power']);
 useFlowStore.getState().updateNodeParams('eng1',{location:{x:12,y:0,z:0,unit:'IN'}});
 assert.equal(useFlowStore.getState().nodes.find(n=>n.id==='prop1').data.params.location.x,12,'engine location updates the real thruster owner');
 useFlowStore.getState().updateNodeParams('prop0',{_tables:JSON.stringify([{name:'C_THRUST',data:[[0,20],[0,9,3],[10,5,7]]}])});
 assert.equal(useFlowStore.getState().nodes.find(n=>n.id==='prop1').data.params.tables[0].expression.data[0][0],9,'raw table edits keep shared editable and saved representations consistent');
 const engineFunctions={nodes:[{id:'turbine',data:{componentType:'engine',params:{engine_type:'turbine',functions:[{name:'MilThrust',expression:{kind:'product',children:[{kind:'value',value:2},table]}}],tables:[{name:'',function_owner:'MilThrust',function_path:[0,1],expression:table}]}}}]};
 const fnChanged=structuredClone(engineFunctions);fnChanged.nodes[0].data.params.functions[0].expression.children[0].value=3;
 assert.deepEqual(projectParameterChanges(engineFunctions,fnChanged),[{key:expressionParameters('propulsion/engine[0]/MilThrust',fnChanged.nodes[0].data.params.functions[0].expression)[0].key,value:3}]);
 useFlowStore.getState().loadProject({...engineFunctions,aircraft:{name:'test'},edges:[]});
 const functions=structuredClone(engineFunctions.nodes[0].data.params.functions);functions[0].expression.children[1].data[0][0]=12;
 useFlowStore.getState().updateNodeParams('turbine',{functions});
 assert.equal(useFlowStore.getState().nodes[0].data.params.tables[0].expression.data[0][0],12,'function edits synchronize their nested table mirror');
 const mirrored=structuredClone(useFlowStore.getState().nodes[0].data.params.tables);mirrored[0].expression.data[0][0]=13;
 useFlowStore.getState().updateNodeParams('turbine',{tables:mirrored});
 assert.equal(useFlowStore.getState().nodes[0].data.params.functions[0].expression.children[1].data[0][0],13,'table edits synchronize their function body');
 console.log('PASS: stable native parameter identities, numeric deltas, paired limits, constants, environment units and structural edit isolation');
} finally {await rm(work,{recursive:true,force:true});}
