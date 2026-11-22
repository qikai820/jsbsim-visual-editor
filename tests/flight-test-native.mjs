import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const runtime=path.resolve(process.argv[2]||'../jsbsim_realtime');
const library=process.argv[3]||runtime+'/build/orangepi-usb-model-native/src/libJSBSim.a';
const work=await mkdtemp('/tmp/flight-test-native-');
try{
 const compile=spawnSync('g++',['-std=c++17','-O2','-I'+runtime+'/src','tests/support/flight-test-native.cpp',library,'-lpthread','-ldl','-lexpat','-o',work+'/native'],{encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
 const fixtures=JSON.parse(await readFile('tests/fixtures/flight-test-xml.json','utf8'));
 for(const [name,times]of Object.entries({all:[0,1.5,3],any:[0,1.5],staggered:[0,1,2,3],nested:[0,1.5,9],loop:[0,.051,.101,.152,.202],altitude_cancel:[0,2]})){
  const file=work+'/'+name+'.xml';await writeFile(file,fixtures[name]);const run=spawnSync(work+'/native',[runtime+'/data/aviation',file,...times.map(String)],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const states=run.stdout.split('\n').filter(line=>line.startsWith('STATE ')).map(line=>line.split(' '));assert.equal(states.length,times.length);
  assert.equal(states[0][2],'0',name+' must initially be running');assert.equal(states.at(-1)[2],'1',name+' must finish at the expected boundary');assert.equal(states.at(-1).length,3,name+' leaves no active input leases');
  console.log('PASS actual JSBSim FGScript: '+name+' '+times.join(' → '));
 }
 const incremental=work+'/incremental.xml';await writeFile(incremental,fixtures.attitude_increment);
 const run=spawnSync(work+'/native',[runtime+'/data/aviation',incremental,'0','.02','.04','.06','.08','.10'],{encoding:'utf8',env:{...process.env,FLIGHT_TEST_ACK_ANGLES:'1'}});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 assert.deepEqual(run.stdout.split('\n').filter(s=>s.startsWith('ANGLE ')).map(s=>Number(s.split(' ')[2])),[0,10,20,10,0]);
 assert.equal(run.stdout.split('\n').filter(s=>s.startsWith('STATE ')).at(-1).split(' ')[2],'1');
 console.log('PASS actual JSBSim FGScript: relative angle accumulation across loops, endpoint and release');
 const recovery=work+'/manual-recover.xml';await writeFile(recovery,fixtures.manual_recover_increment);
 const recovered=spawnSync(work+'/native',[runtime+'/data/aviation',recovery,'0','.02','.04','.06','.08','.10'],{encoding:'utf8',env:{...process.env,FLIGHT_TEST_ACK_ANGLES:'1',FLIGHT_TEST_ACK_MANUAL:'1'}});
 assert.equal(recovered.status,0,recovered.stdout+'\n'+recovered.stderr);
 assert.deepEqual(recovered.stdout.split('\n').filter(s=>s.startsWith('ANGLE ')).map(s=>Number(s.split(' ')[2])),[5,10]);
 assert.deepEqual(recovered.stdout.split('\n').filter(s=>s.startsWith('RECOVER ')).map(s=>Number(s.split(' ')[1])),[1,2,2]);
 assert.equal(recovered.stdout.split('\n').filter(s=>s.startsWith('STATE ')).at(-1).split(' ')[2],'1');
 console.log('PASS actual JSBSim FGScript: fixed origin, excitation/recovery loop sequencing and release');
 const heading=work+'/heading.xml';await writeFile(heading,fixtures.heading);
 const headed=spawnSync(work+'/native',[runtime+'/data/aviation',heading,'0','.02','.04'],{encoding:'utf8',env:{...process.env,FLIGHT_TEST_ACK_HEADING:'1'}});
 assert.equal(headed.status,0,headed.stdout+'\n'+headed.stderr);
 assert.deepEqual(headed.stdout.split('\n').filter(s=>s.startsWith('HEADING ')).map(s=>Number(s.split(' ')[1])),[30]);
 assert.equal(headed.stdout.split('\n').filter(s=>s.startsWith('STATE ')).at(-1).split(' ')[2],'1');
 console.log('PASS actual JSBSim FGScript: heading request, controller acknowledgement, notification and input release');
}finally{await rm(work,{recursive:true,force:true});}
