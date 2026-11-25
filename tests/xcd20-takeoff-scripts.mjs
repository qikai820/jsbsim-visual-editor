import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
const temp=await mkdtemp('/tmp/xcd20-template-check-');
try{
 await build({stdin:{contents:"export * from './client/src/flight-test/model';export * from './client/src/flight-test/xml';export * from './client/src/flight-test/presets';export * from './client/src/flight-test/xcd20Monitor';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:temp+'/test.cjs',logLevel:'silent'});
 const {builtinDocument,compileTest,documentFromXml,validateDocument,flatten,copy,DEFS,xcd20ObservationKeys}=createRequire(import.meta.url)(temp+'/test.cjs');
 const b=(id,type,p={})=>({id,type,p:{...DEFS[type].p,...p}});
 const tiny=(blocks,requirements)=>({version:1,name:'XCD20 validation fixture',aircraft:'XCD20_FlightIdentified',initialize:'current-instance',duration:5,rateHz:50,throttle:0,clock:'realtime',onFinish:'hold',onAbort:'hold',requirements,blocks});
 assert.deepEqual(xcd20ObservationKeys(null),[]);assert.deepEqual(xcd20ObservationKeys(tiny([],undefined)),[]);
 const fixtures={};
 for(const [id,file] of [['xcd20_normal_takeoff','XCD20_NormalTakeoff'],['xcd20_rail_takeoff','XCD20_RailTakeoff']]){
  const d=builtinDocument(id),all=flatten(d.blocks),xml=compileTest(d);
  assert.deepEqual(documentFromXml(xml),d);assert.equal(xml,await readFile('examples/flight-tests/xcd20-takeoff/'+file+'.xml','utf8'));
  assert.equal(all.filter(n=>n.type==='launch_reference').length,id.includes('normal')?3:1);
  assert(all.filter(n=>n.type==='parallel'&&n.p.join==='any').every(n=>n.lanes[0][0].type==='altitude'&&n.lanes[0][0].p.duration>n.p.timeout),'helper cannot win a timeout race and falsely pass');
  assert(!all.some(n=>n.type==='channel'||n.type==='attitude'||n.type==='heading'),'no vector/MorphQuad-only controller path');
  assert(all.filter(n=>n.type==='observe').every(n=>n.p.duration>0&&n.p.min<=n.p.max));
  if(id.includes('normal')){
   assert.equal(all.filter(n=>n.type==='takeoff').length,0);
   assert.deepEqual(all.filter(n=>n.type==='mode').map(n=>n.p.mode),['MANUAL','ALTCTL','POSCTL']);
   assert.equal(all.filter(n=>n.type==='disarm').length,3);assert.equal(all.filter(n=>n.type==='land').length,3);
   assert.equal(all.filter(n=>n.type==='manual_takeoff').length,1);
   assert.equal(all.filter(n=>n.type==='altitude').length,5);
  }else{
   assert.equal(d.onAbort,'hold');assert.equal(all.filter(n=>n.type==='altitude'||n.type==='manual_takeoff').length,0);
   const auto=all.findIndex(n=>n.type==='wait_state'&&n.p.field==='mode'&&n.p.value===4);
   const truth=all.findIndex(n=>n.type==='assert'&&n.p.field==='sim/rail-contact-mask'&&n.p.value===0);
   assert(auto>0&&truth>auto);assert(all.slice(truth).some(n=>n.type==='mode'&&n.p.mode==='POSCTL'));
   const takeoff=all.findIndex(n=>n.type==='takeoff'),pos=all.findIndex((n,i)=>i>truth&&n.type==='mode'&&n.p.mode==='POSCTL');
   assert(!all.slice(takeoff,auto).some(n=>n.type==='throttle'||n.type==='pulse'||n.type==='axes'||n.type==='neutral'));
   const center=all.findIndex((n,i)=>i>takeoff&&n.type==='throttle'&&n.p.value===50);assert(center>truth&&center>auto&&center<pos);
  }
  const keys=xcd20ObservationKeys(d);
  assert.deepEqual(keys,id.includes('normal')?['moving-platform/enabled']:['moving-platform/enabled','moving-platform/contact-mode','moving-platform/rail/contact-mask','moving-platform/rail/valid-mask','moving-platform/rail/released-mask','moving-platform/rail/travel-m','moving-platform/rail/travel-m[1]']);
  const moves=all.filter(n=>n.type==='pulse'&&Math.abs(n.p.value)!==20);
  assert.equal(moves.length,4);assert(moves.every(n=>Math.abs(n.p.value)===35&&n.p.duration===4));
  const gates=all.filter(n=>n.type==='wait_state'&&n.p.field==='groundspeed-mps'&&n.p.op==='ge');
  assert.equal(gates.length,4);assert(gates.every(n=>n.p.value===.5&&n.p.timeout===4));
  assert.throws(()=>builtinDocument(id,2),/高度/);assert.throws(()=>builtinDocument(id,11),/高度/);
 }
 fixtures.observe=compileTest(tiny([b('bobserve','observe',{field:'relative-alt-m',min:2.7,max:3.3,duration:1,reference:'absolute'})]));
 fixtures.relative=compileTest(tiny([b('bobserve','observe',{field:'local-x-m',min:-.7,max:.7,duration:1,reference:'start'})]));
 fixtures.launch=compileTest(tiny([b('blaunch','launch_reference'),b('bwait','wait',{duration:.05}),b('btakeoff','takeoff',{altitude:3,timeout:3})],{'xcd20-takeoff':0}));
 const invalid=tiny([b('bbad','observe',{min:2,max:1})]);assert.throws(()=>validateDocument(invalid),/范围/);
 const field=copy(invalid);field.blocks[0].p.min=0;field.blocks[0].p.field='arbitrary/property';assert.throws(()=>validateDocument(field),/字段/);
 const noGround=tiny([b('blaunch','launch_reference')]);assert.throws(()=>compileTest(noGround),/XCD20/);
 await writeFile('tests/fixtures/xcd20-validation.json',JSON.stringify(fixtures,null,2)+'\n');
 console.log('PASS XCD20: exactly two templates, three independent ordinary-mode launches, AUTO-to-POSCTL after physical exit, no auxiliary height hold in POSCTL checks, per-launch height, continuous observers, timeout-race rejection, validated metadata roundtrip.');
}finally{await rm(temp,{recursive:true,force:true});}
