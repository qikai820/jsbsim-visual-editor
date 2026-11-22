import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {XMLParser, XMLValidator} from 'fast-xml-parser';

// Exercise the production IPC adapter and shared test store. Only the native
// service replies and browser XML parser are substituted; no ports or devices.
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
globalThis.crypto??=webcrypto;
storage.set('jsbsim-simulator-transport','network');
globalThis.DOMParser=class {
 parseFromString(xml){const valid=XMLValidator.validate(xml)===true;const parsed=valid?new XMLParser({ignoreAttributes:false,attributeNamePrefix:''}).parse(xml):null;
  return{querySelector:selector=>selector==='parsererror'?(valid?null:{}):selector==='use'&&parsed?.runscript?.use?{getAttribute:name=>parsed.runscript.use[name]??null}:null};}
};
let simulation,target,overrides,calls;
const snapshot=(id,status)=>({id,status,name:'current',dryRun:true,elapsed:0,realElapsed:0,rc:[],activeBlocks:[],values:{},logs:[],exitResult:status==='stopped'?'测试退出已确认':''});
async function native(command,args){
 calls.push({command,args});if(overrides.has(command))return overrides.get(command)(args);
 switch(command){
  case 'sim_status':return {...simulation};
  case 'simulator_network_target_get':return target;
  case 'sim_list_models':return{models:[{name:'ball'},{name:'F450_PX4'}]};
  case 'sim_list_tests':return{tests:[{file:'F450_PX4_lan.xml'}]};
  case 'ftp_download_script':return{xml:'<runscript><use aircraft="F450_PX4" initialize="initGrnd"/></runscript>'};
  case 'sim_start':simulation={...simulation,running:true,state:'running',model:args.model};return{running:true};
  case 'sim_pause':return{running:true,paused:true};
  case 'sim_resume':return{running:true,paused:false};
  case 'sim_stop':return{running:false};
  case 'sim_restart':return{running:true};
  case 'px4_sitl_preview':return{args:[]};
  case 'px4_sitl_start':return{running:true};
  case 'px4_sitl_stop':return{running:false};
  case 'flight_test_start':return snapshot(301,'running');
  case 'flight_test_stop':return snapshot(args.id,'stopped');
  default:throw Error('Unexpected IPC '+command);
 }
}
globalThis.window={__TAURI_INTERNALS__:{invoke:(command,args)=>native(command,args),transformCallback:()=>1}};
const compiled=await build({stdin:{contents:`export * from './client/src/voice/runtime';export{useFlightTestStore}from'./client/src/flight-test/session';export{runVoicePlan}from'./client/src/voice/model';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty'}});
const {collectVoiceContext,readVoiceContext,executeVoiceAction,useFlightTestStore,runVoicePlan}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const initial=useFlightTestStore.getState();let synced;
const host={binding:()=>({instance:'01',selectedModel:'ball',busy:false}),syncModel:async()=>{synced++;},selectModel:async()=>{},openToolbox:()=>{},showScene:()=>{},showLogs:()=>{}};
function reset(){simulation={external:true,local:true,connected:true,running:false,model:'ball',state:'stopped'};target='127.0.0.1';overrides=new Map();calls=[];synced=0;useFlightTestStore.setState(initial,true);}
const count=name=>calls.filter(c=>c.command===name).length;
const context=()=>readVoiceContext(host,{models:['ball','F450_PX4'],scripts:['F450_PX4_lan.xml'],errors:[]});
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
reset();simulation.connected=false;
const disconnected=await collectVoiceContext(host);
assert.equal(count('sim_list_models'),0);assert.equal(count('sim_list_tests'),0);assert.equal(count('simulator_network_target_get'),0);assert.ok(disconnected.catalogErrors.length);

reset();let c=await collectVoiceContext(host);assert.equal(c.simulatorTarget,'127.0.0.1');assert.ok(c.models.includes('ball'));
await executeVoiceAction({type:'start_script',model:'F450_PX4',script:'F450_PX4_lan.xml'},c,host);
assert.deepEqual(calls.find(v=>v.command==='sim_start').args,{model:'F450_PX4',script:'F450_PX4_lan.xml'});

reset();c=await context();overrides.set('ftp_download_script',()=>({xml:'<runscript><use aircraft="other"/></runscript>'}));
await assert.rejects(executeVoiceAction({type:'start_script',model:'F450_PX4',script:'F450_PX4_lan.xml'},c,host),/不一致/);assert.equal(count('sim_start'),0);assert.equal(synced,0);

reset();c=await context();let cancelled=false;const statusGate=deferred();overrides.set('sim_status',()=>statusGate.promise);
const cancelledStart=executeVoiceAction({type:'start_model',model:'ball'},c,host,()=>!cancelled);cancelled=true;statusGate.resolve(simulation);
await assert.rejects(cancelledStart,/取消/);assert.equal(synced,0);assert.equal(count('sim_start'),0);

reset();c=await context();const changedTargetHost={...host,syncModel:async()=>{target='192.168.3.100';}};
await assert.rejects(executeVoiceAction({type:'start_model',model:'ball'},c,changedTargetHost),/地址已变化/);assert.equal(count('sim_start'),0);

reset();c=await context();const competingStart={...host,syncModel:async()=>{simulation.running=true;simulation.model='other';}};
await assert.rejects(executeVoiceAction({type:'start_model',model:'ball'},c,competingStart),/另一个模型/);assert.equal(count('sim_start'),0);

reset();c=await context();const testDuringSync={...host,syncModel:async()=>useFlightTestStore.setState({snapshot:snapshot(20,'running')})};
await assert.rejects(executeVoiceAction({type:'start_model',model:'ball'},c,testDuringSync),/测试正在运行/);assert.equal(count('sim_start'),0);

for(const [type,response]of [['pause',{running:true,paused:false}],['resume',{running:false}],['stop',{running:true}],['restart',{running:false}]]){
 reset();c=await context();overrides.set('sim_'+type,()=>response);
 await assert.rejects(executeVoiceAction({type},c,host),/未确认/);
}

reset();storage.set('px4-sitl-config-v1',JSON.stringify({airframe:10016,instance:0}));c=await context();
overrides.set('px4_sitl_preview',()=>{storage.set('px4-sitl-config-v1',JSON.stringify({airframe:10040,instance:0}));return{};});
await assert.rejects(executeVoiceAction({type:'start_px4'},c,host),/配置已变化/);assert.equal(count('px4_sitl_start'),0);

reset();c=await context();await assert.rejects(executeVoiceAction({type:'start_test',dryRun:false},c,host),/HIL/);assert.equal(count('flight_test_start'),0);
useFlightTestStore.setState({context:{instance:1,disabled:false,bidirectional:false,link:null,beforeRun:async()=>{}}});
await executeVoiceAction({type:'start_test',dryRun:true},c,host);assert.equal(calls.find(v=>v.command==='flight_test_start').args.options.dryRun,true);
c=await context();await executeVoiceAction({type:'stop_test'},c,host);assert.equal(useFlightTestStore.getState().snapshot.status,'stopped');
console.log('Voice runtime integration PASS: IPC routing, offline status, script association, cancellation, target/config changes, concurrent starts, native acknowledgements, shared dry-run and test exit');

reset();useFlightTestStore.setState({context:{instance:1,disabled:false,bidirectional:false,link:null,beforeRun:async()=>{}}});
c=await context();const now=Date.now();
await runVoicePlan({id:'compound',createdAtMs:now,expiresAtMs:now+60000,reply:'test',actions:[{type:'start_test',dryRun:true},{type:'stop_test'}]},c,{
 current:context,binding:host.binding,cancelled:()=>false,onStep:()=>{},execute:(a,current)=>executeVoiceAction(a,current,host)
});
assert.equal(count('flight_test_start'),1);assert.equal(count('flight_test_stop'),1);assert.equal(useFlightTestStore.getState().snapshot.status,'stopped');
console.log('Voice compound workflow PASS: later steps use the newly started test ID');

reset();simulation.flightController={network_peer:'127.0.0.1:14561',board_id:11};c=await context();
await assert.rejects(executeVoiceAction({type:'start_model',model:'ball'},c,{...host,syncModel:async()=>{simulation.flightController.board_id=22;}}),/飞控标识已变化/);assert.equal(count('sim_start'),0);
console.log('Voice controller identity PASS: controller replacement during model preparation cannot submit a start');
