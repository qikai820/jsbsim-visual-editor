import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const dir=await mkdtemp('/tmp/flight-test-compiler-');
try{
 await build({stdin:{contents:`export * from './client/src/flight-test/model';export * from './client/src/flight-test/xml';export * from './client/src/flight-test/presets';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:dir+'/compiler.cjs',logLevel:'silent'});
 const {defaultDocument,compileTest,documentFromXml,validateDocument,copy,makeBlock,flatten,BUILTIN_TESTS,builtinDocument,SWEEP_POINTS,sweepPoints}=createRequire(import.meta.url)(dir+'/compiler.cjs');
 const pulse=(id,axis,value,duration)=>({id,type:'pulse',p:{axis,value,duration}}),wait=(id,duration)=>({id,type:'wait',p:{duration}});
 const parallel=(id,join,lanes,timeout=10)=>({id,type:'parallel',p:{join,timeout},lanes});
 const base=()=>({...defaultDocument(),aircraft:'ball',initialize:'reset00',blocks:[]});
 const altitude=(id,duration=50)=>({...makeBlock('altitude'),id,p:{...makeBlock('altitude').p,duration}});
 const angle=(id,p={})=>({...makeBlock('attitude'),id,p:{...makeBlock('attitude').p,...p}});
 const delta=(id,pitch)=>({...makeBlock('attitude_delta'),id,p:{...makeBlock('attitude_delta').p,pitch,hold:.1,settle:.1,timeout:5}});
 const recover=(id,reference='return')=>({...makeBlock('manual_recover'),id,p:{...makeBlock('manual_recover').p,reference}});
 const normal=()=>({...makeBlock('input_mode'),id:'binput',p:{input:'normal'}});
 const channel=(id,target,value,action='set')=>({id,type:'channel',p:{channel:target,value,action}});
 const cases={
  channels:[channel('bswitch','vector-switch',100),channel('baux','aux6',25),wait('bwait',.2),channel('bnormal','vector-switch',-100),wait('bwait2',.2),channel('brelease','vector-switch',0,'release'),channel('breleaseaux','aux6',0,'release'),wait('bwait3',.2)],
  channels_conflict:[channel('bswitch','vector-switch',100),channel('brc','rc8',-100),wait('bwait',1)],
  channels_aux_conflict:[channel('baux','aux1',0),parallel('bgroup','any',[[angle('bangle',{pitch:0})],[altitude('bheight',50)]],45)],
  channels_live:[channel('bswitch','vector-switch',100),channel('baux','aux6',25),wait('bwait',.3),channel('bnormal','vector-switch',-100),wait('bwait2',.3)],
  receiver_live:[channel('bswitch','vector-switch',100),channel('baux1','aux1',50),channel('baux2','aux2',-25),{id:'baxes',type:'axes',p:{roll:20,pitch:-10,yaw:15,throttle:70,duration:.3}}],
  all:[parallel('b1','all',[[pulse('b2','roll',20,3)],[pulse('b3','yaw',-15,1.5)]])],
  any:[parallel('b1','any',[[pulse('b2','roll',20,3)],[pulse('b3','yaw',-15,1.5)]])],
  staggered:[parallel('b1','all',[[pulse('b2','roll',20,1)],[wait('b3',2),pulse('b4','roll',-15,1)]])],
  conflict:[parallel('b1','all',[[pulse('b2','roll',20,2)],[pulse('b3','roll',-15,1)]])],
  nested:[parallel('b1','any',[[{id:'b2',type:'loop',p:{count:2},body:[pulse('b3','roll',20,3)]}],[wait('b4',1.5)],[parallel('b5','all',[[pulse('b6','yaw',15,5)],[wait('b7',8)]])]])],
  loop:[{id:'b1',type:'loop',p:{count:2},body:[parallel('b2','all',[[pulse('b3','roll',30,.1)],[pulse('b4','yaw',-20,.05)]])]}],
  branch:[{id:'b1',type:'branch',p:{field:'relative-alt-m',op:'ge',value:3},yes:[pulse('b2','roll',20,.2)],no:[pulse('b3','yaw',-20,.2)]}],
  timeout:[{id:'b1',type:'wait_state',p:{field:'relative-alt-m',op:'ge',value:100,timeout:.1}}],
  mode:[{id:'b1',type:'mode',p:{mode:'POSCTL',timeout:.25}}],
  live:[{id:'b1',type:'mode',p:{mode:'POSCTL',timeout:2}},parallel('b2','all',[[pulse('b3','roll',20,.4)],[pulse('b4','yaw',-15,.2)]])],
  long:[pulse('b1','roll',20,10)],
  axes:[{id:'b1',type:'axes',p:{roll:20,pitch:-10,yaw:15,throttle:70,duration:.2}}],
  escaped:[{id:'b1',type:'mark',p:{text:'中文 <tag> & "quoted"'}}],
  manual_takeoff:[{...makeBlock('manual_takeoff'),id:'bmanual',p:{...makeBlock('manual_takeoff').p,target:5}}],
  manual_recover:[normal(),parallel('bgroup','any',[[recover('borigin','capture'),wait('bgap',.02),recover('breturn')],[altitude('bheight',60)]],55)],
  manual_recover_capture:[normal(),parallel('bgroup','any',[[recover('borigin','capture')],[altitude('bheight',60)]],55)],
  manual_recover_increment:[normal(),parallel('bgroup','any',[[recover('borigin','capture'),{id:'bloop',type:'loop',p:{count:2},body:[delta('bdelta',5),recover('breturn')]}],[altitude('bheight',60)]],55)],
  heading:[normal(),parallel('bheading_group','any',[[{...makeBlock('heading'),id:'bheading',p:{...makeBlock('heading').p,target:30,hold:.2,settle:.2,timeout:5}}],[altitude('bheight',20)]],10)],
  altitude:[altitude('b1')],
  altitude_parallel:[parallel('b1','all',[[altitude('b2',3)],[pulse('b3','roll',20,3)]])],
  altitude_conflict:[parallel('b1','all',[[altitude('b2',3)],[pulse('b3','throttle',60,3)]])],
  altitude_cancel:[parallel('b1','any',[[altitude('b2')],[wait('b3',2)]])],
  altitude_live:[{...altitude('b1',.4),p:{...altitude('b1',.4).p,target:6}}],
  vector140:[{...makeBlock('input_mode'),id:'binput',p:{input:'vector'}},parallel('bgroup','any',[[angle('bangle',{pitch:140})],[altitude('bheight',50)]],45)],
  attitude:[parallel('bgroup','any',[[angle('bangle',{pitch:120})],[altitude('bheight',50)]],45)],
  attitude_live:[parallel('bgroup','any',[[angle('bangle',{pitch:0,hold:.1,settle:.1,timeout:1})],[altitude('bheight',2)]],1.5)],
  attitude_hold:[parallel('bgroup','any',[[angle('bangle',{pitch:0,hold:1,settle:.2,timeout:4})],[altitude('bheight',5)]],4.5)],
  attitude_timeout:[parallel('bgroup','any',[[angle('bangle',{pitch:120,hold:.1,settle:.1,timeout:.5})],[altitude('bheight',2)]],1)],
  attitude_increment:[parallel('bgroup','any',[[angle('bzero',{pitch:0,hold:.1,settle:.1,timeout:5}),{id:'bup',type:'loop',p:{count:2},body:[delta('bdelta_up',10)]},{id:'bdown',type:'loop',p:{count:2},body:[delta('bdelta_down',-10)]}],[altitude('bheight',20)]],19)],
 };
 const fixtures={};for(const [name,blocks]of Object.entries(cases)){const d={...base(),blocks,name:'fixture '+name};const xml=compileTest(d);assert.deepEqual(documentFromXml(xml),d);assert(!/<(?:parallel|loop|await)\b/.test(xml),'ordinary FGScript elements only');fixtures[name]=xml;}
 const d=defaultDocument();assert.deepEqual(documentFromXml(compileTest(d)),d);
 assert.equal(documentFromXml(compileTest(d).replace('value="0.2"','value="0.3"')),null,'edited XML cannot restore stale graph metadata');
 assert.throws(()=>documentFromXml('<!DOCTYPE runscript><runscript/>'),/DTD/);
 const invalid=copy(d);invalid.blocks[1].lanes[0][0].p.value=101;assert.throws(()=>compileTest(invalid),/越界/);
 const duplicate=copy(d);duplicate.blocks.push(copy(duplicate.blocks[0]));assert.throws(()=>validateDocument(duplicate),/标识/);
 const explosive=base();explosive.blocks=[{id:'b1',type:'loop',p:{count:20},body:[{id:'b2',type:'loop',p:{count:20},body:[{id:'b3',type:'loop',p:{count:20},body:[wait('b4',1)]}]}]}];assert.throws(()=>compileTest(explosive),/1024/);
 const parallelTrim=base();parallelTrim.blocks=[parallel('b1','all',[[{id:'b2',type:'throttle',p:{value:50}}],[]])];assert.throws(()=>compileTest(parallelTrim),/基准油门/);
 const parallelChannel=base();parallelChannel.blocks=[parallel('b1','all',[[channel('bchannel','aux6',100)],[]])];assert.throws(()=>compileTest(parallelChannel),/通道控制.*并行/);
 for(const [target,value,action] of [['rc0',0,'set'],['rc19',0,'set'],['aux7',0,'set'],['aux1',101,'set'],['rc1',0,'other']]){
  const bad=base();bad.blocks=[channel('bchannel',target,value,action)];assert.throws(()=>compileTest(bad),/通道|越界/);
 }
 const badAltitude=base();badAltitude.blocks=[altitude('b1')];badAltitude.blocks[0].p.min=60;assert.throws(()=>compileTest(badAltitude),/越界/);
 badAltitude.blocks[0].p.min=49;badAltitude.blocks[0].p.deadzone=6;assert.throws(()=>compileTest(badAltitude),/死区/);
 const badAngle=base();badAngle.blocks=[angle('b1',{pitch:141})];assert.throws(()=>compileTest(badAngle),/越界/);
 assert.equal(SWEEP_POINTS.length,49);assert.equal(sweepPoints(45,5).length,37);assert(SWEEP_POINTS.slice(1).every((p,i)=>Math.abs(p-SWEEP_POINTS[i])===10));
 for(const preset of BUILTIN_TESTS.filter(p=>!p.id.startsWith('xcd20_'))){const doc=builtinDocument(preset.id,15),all=flatten(doc.blocks);assert.deepEqual(documentFromXml(compileTest(doc)),doc);assert(all.filter(n=>n.type==='altitude').every(n=>n.p.target===15));}
 const full=builtinDocument('complete');const all=flatten(full.blocks);assert.equal(all.filter(n=>n.type==='attitude_delta').length,24);assert.equal(all.filter(n=>n.type==='altitude').length,14);assert.equal(full.onFinish,'land');
 assert.equal(all.filter(n=>n.type==='manual_recover').length,20);
 assert.equal(all.filter(n=>n.type==='manual_recover'&&n.p.reference==='capture').length,2);
 for(const preset of BUILTIN_TESTS.filter(n=>n.mode)){
  const blocks=flatten(builtinDocument(preset.id).blocks),manual=preset.mode==='MANUAL';
  assert(blocks.filter(n=>['attitude','attitude_delta'].includes(n.type)).every(n=>n.p.hold===(manual?2:10)));
  assert.equal(blocks.filter(n=>n.type==='manual_recover').length,manual?6:preset.mode==='POSCTL'?(preset.input==='normal'?3:1):0);
  if(manual)for(const loop of blocks.filter(n=>n.type==='loop'))assert.deepEqual(loop.body.map(n=>n.type),['attitude_delta','manual_recover']);
  assert.equal(blocks.find(n=>n.type==='channel'&&n.p.channel==='vector-switch').p.value,preset.input==='vector'?100:-100);
  if(preset.mode==='POSCTL'&&preset.input==='normal'){
   assert(!blocks.some(n=>['attitude','attitude_delta'].includes(n.type)),'normal POSCTL must not wait for a sustained angle');
   assert.deepEqual(blocks.filter(n=>n.type==='pulse').map(n=>[n.p.axis,n.p.value,n.p.duration]),[[preset.axis,60,2],[preset.axis,-60,2]]);
   assert.equal(blocks.filter(n=>n.type==='wait_state'&&n.p.field===preset.axis+'-abs-deg'&&n.p.op==='ge').length,2,'each pulse requires an actual tilt response');
   assert.equal(blocks.filter(n=>n.type==='manual_recover'&&n.p.reference==='stop').length,3,'entry and both directions use the shared recovery block');
  }
  if(preset.input==='vector')assert(blocks.filter(n=>n.type==='loop').every(n=>n.p.count===12));
 }
 const regression=builtinDocument('posctl_regression'),regressionBlocks=flatten(regression.blocks);
 assert.equal(regression.onFinish,'land');assert.equal(regressionBlocks.filter(n=>n.type==='pulse').length,4);
 assert(regressionBlocks.filter(n=>n.type==='loop').every(n=>n.p.count===1));
 assert.deepEqual(all.filter(n=>n.type==='mode').map(n=>n.p.mode),['MANUAL','MANUAL','MANUAL','MANUAL','ALTCTL','ALTCTL','POSCTL','POSCTL','POSCTL','POSCTL']);
 const ground=all.find(n=>n.id==='bground');assert.equal(ground.type,'branch');assert(ground.yes.some(n=>n.type==='arm'));assert(all.some(n=>n.type==='manual_takeoff'));assert(!all.some(n=>n.type==='takeoff'));assert(!ground.no.some(n=>n.type==='arm'||n.type==='takeoff'));
 assert(all.filter(n=>n.type==='input_mode').some(n=>n.p.input==='vector'));
 assert.throws(()=>builtinDocument('complete',0),/高度/);
 const four=builtinDocument('four_mode_complete'),fourBlocks=flatten(four.blocks);
 assert.deepEqual(four.requirements,{'manual-tilt-deg':35,'altitude-tilt-deg':35,'vector-tilt-deg':120});
 assert.equal(four.onAbort,'land');assert.equal(fourBlocks.filter(n=>n.type==='heading').length,52);
 assert.equal(fourBlocks.filter(n=>n.type==='manual_recover'&&n.p.reference==='capture').length,1,'one fixed origin for the whole plan');
 for(const group of ['manual','altctl']){
  const blocks=fourBlocks.filter(n=>n.id.startsWith('bfour_'+group+'_'));
  assert(blocks.filter(n=>n.type==='loop').every(n=>n.p.count===7));
  assert(blocks.filter(n=>['attitude','attitude_delta','heading'].includes(n.type)).every(n=>n.p.hold===2));
  assert.deepEqual(blocks.filter(n=>n.type==='heading').map(n=>n.p.target),sweepPoints(90,30));
  assert.equal(blocks.filter(n=>n.type==='manual_recover'&&n.p.reference==='return').length,24);
 }
 const output=process.argv[2]||'tests/fixtures/flight-test-xml.json';await writeFile(output,JSON.stringify(fixtures,null,2)+'\n');
 console.log(`PASS: compiler flow lowering, XML/metadata roundtrip, edited-source detection, limits and validation; ${Object.keys(fixtures).length} execution fixtures → ${output}`);
}finally{await rm(dir,{recursive:true,force:true});}
