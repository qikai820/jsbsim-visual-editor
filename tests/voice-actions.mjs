import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../client/src/voice/model.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {validateAction,validatePlan,checkPlan,contextFingerprint,runVoicePlan}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const context=()=>({binding:{instance:'01',selectedModel:'F450_PX4',busy:false},simulation:{connected:true,external:true,local:true,model:'F450_PX4',state:'running',running:true},models:['F450_PX4','ball'],scripts:['F450_PX4_lan.xml'],test:{id:1,status:'idle',name:'current',sourceHash:'original',pendingDraft:false,sourceError:'',sessionId:10},px4Config:{airframe:10016},catalogErrors:[],capturedAtMs:Date.now()});
const plan=actions=>({id:'test',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,reply:'待确认',actions});
for(const action of [{type:'shell',command:'bad'},{type:'stop',extra:'bad'},{type:'start_model',model:'../x'},{type:'start_test'},{type:'start_test',dryRun:'false'}])assert.throws(()=>validateAction(action));
assert.doesNotThrow(()=>validatePlan(plan([{type:'start_test',dryRun:false}])));
assert.throws(()=>checkPlan(plan([{type:'start_model',model:'missing'}]),context()),/不存在/);
assert.throws(()=>checkPlan(plan([{type:'start_model',model:'F450_PX4'}]),context()),/地面脚本/);
const expired=plan([{type:'stop'}]);expired.createdAtMs-=61000;expired.expiresAtMs-=61000;assert.throws(()=>checkPlan(expired,context()),/过期/);
const secondary=context();secondary.binding.instance='02';assert.throws(()=>checkPlan(plan([{type:'pause'}]),secondary),/实例 01/);
const baseline=context();const changed=structuredClone(baseline);changed.test.sourceHash='edited';assert.notEqual(contextFingerprint(baseline),contextFingerprint(changed));
const calls=[],results=[];let state=context(),cancelled=false;
const services={current:async()=>state,binding:()=>state.binding,execute:async action=>{calls.push(action.type);return action.type+' confirmed';},cancelled:()=>cancelled,onStep:r=>results.push(r)};
await runVoicePlan(plan([{type:'pause'}]),state,services);assert.deepEqual(calls,['pause']);assert.equal(results[0].ok,true);
calls.length=0;const prepared=structuredClone(state);state.test.sessionId=11;
await assert.rejects(runVoicePlan(plan([{type:'stop'}]),prepared,services),/已变化/);assert.equal(calls.length,0);
state=context();calls.length=0;cancelled=false;
await assert.rejects(runVoicePlan(plan([{type:'pause'},{type:'resume'}]),state,{...services,execute:async action=>{calls.push(action.type);cancelled=true;return 'ok';}}),/取消/);assert.deepEqual(calls,['pause']);
cancelled=false;calls.length=0;
await assert.rejects(runVoicePlan(plan([{type:'pause'},{type:'stop'}]),state,{...services,execute:async action=>{calls.push(action.type);throw Error('native failed');}}),/native failed/);assert.deepEqual(calls,['pause']);
console.log('Voice action tests PASS: strict actions, catalog checks, expiration, stale binding/script checks, cancellation, and no retries after failure');

for(const change of [c=>c.simulatorTarget='192.168.3.100',c=>c.test.sourceHash='different',c=>c.px4Config.airframe=10040,c=>c.simulation.flightController={network_peer:'other',board_id:99}]){
 const original=context();state=structuredClone(original);change(state);calls.length=0;
 await assert.rejects(runVoicePlan(plan([{type:'stop'}]),original,services),/已变化/);assert.equal(calls.length,0);
}
state=context();calls.length=0;cancelled=false;
const originalClock=Date.now,base=originalClock();let time=base;Date.now=()=>time;
try{await assert.rejects(runVoicePlan(plan([{type:'pause'},{type:'resume'}]),state,{...services,execute:async a=>{calls.push(a.type);time+=61000;return 'ok';}}),/过期/);assert.deepEqual(calls,['pause']);}finally{Date.now=originalClock;}
console.log('Voice plan integration PASS: peer/controller/script/config invalidation and expiration between steps');
