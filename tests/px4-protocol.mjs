import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const dir=await mkdtemp('/tmp/px4-protocol-');
try{
 await build({stdin:{contents:`export * from './client/src/px4/protocol';export * from './client/src/px4/metadata';export * from './client/src/px4/services';export * from './client/src/px4/shell';export * from './client/src/px4/connection';`,resolveDir:process.cwd()},outfile:dir+'/test.cjs',bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {Parser,encode,view,parameterValue,parseMetadata,readParameters,readLogWindow,TelnetDecoder,Px4Connection}=createRequire(import.meta.url)(dir+'/test.cjs');
 const f=JSON.parse(await readFile('tests/fixtures/px4-mavlink.json','utf8'));
 const parser=new Parser();let out=[];
 for(const byte of [...f.heartbeatV1,...f.int32,...f.float])out.push(...parser.push(Uint8Array.of(byte)));
 assert.deepEqual(out.map(x=>x.id),[0,22,22]);assert.equal(parameterValue(out[1].payload),-12345);assert.equal(parameterValue(out[2].payload),Math.fround(.15));
 const request=new Uint8Array(20);view(request).setInt16(0,3,true);request[2]=7;request[3]=1;
 const encoded=encode(20,request,15);assert.deepEqual(Array.from(encoded),f.request,'independent pymavlink wire vector');
 const damaged=Uint8Array.from(f.int32);damaged[12]^=1;
 assert.equal(new Parser().push(Uint8Array.from([...damaged,...f.float])).length,1,'bad CRC is rejected and parser resynchronizes');
 const catalog=parseMetadata(await readFile('client/public/px4/PX4ParameterFactMetaData.json','utf8'),{kind:'bundled',label:'QGC',matched:false});
 assert.equal(catalog.get('MC_ROLLRATE_P').group,'Multicopter Rate Control');assert.equal(catalog.get('MC_ROLLRATE_P').min,.01);assert.equal(catalog.get('MC_ROLLRATE_P').shortDesc,'Roll rate P gain');assert.equal(catalog.get('UNKNOWN_CUSTOM'),undefined);
 const indexed=parseMetadata(JSON.stringify({version:1,parameters:[{name:'CAL_GYRO{n}_ID',shortDesc:'Gyro {n}',group:'Sensors'}]}),{kind:'vehicle',label:'test',matched:true});assert.equal(indexed.get('CAL_GYRO2_ID').shortDesc,'Gyro 2');
 const xml=parseMetadata('<parameters><group name="Custom"><parameter name="TEST_INT" type="INT32" default="-1"><short_desc>Test</short_desc><long_desc>Original</long_desc><values><value code="-1">Off</value></values></parameter></group></parameters>',{kind:'import',label:'x',matched:false});assert.equal(xml.get('TEST_INT').values[0].description,'Off');assert.equal(xml.get('TEST_INT').default,-1);
 assert.throws(()=>parseMetadata('<!DOCTYPE parameters><parameters/>',{kind:'import',label:'x',matched:false}),/DTD/);
 const telnet=new TelnetDecoder();assert.equal(telnet.push(Uint8Array.of(255,251)).bytes.length,0);const t=telnet.push(Uint8Array.of(1,110,115,104,62));assert.deepEqual(Array.from(t.reply),[255,253,1]);assert.equal(new TextDecoder().decode(t.bytes),'nsh>');
 class FakeLink{
  signal=new AbortController().signal;target={system:7,component:1};bytewise=true;listeners=new Set();sent=[];
  subscribe=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
  emit(frame){this.listeners.forEach(fn=>fn(frame));}
  async send(id,payload){this.sent.push([id,payload]);this.respond?.(id,payload);}
 }
 const fake=new FakeLink(), int=out[1], flt=out[2];
 fake.respond=(id)=>{if(id===21){fake.emit(int);fake.emit(int);}if(id===20)fake.emit(flt);};
 const params=await readParameters(fake,()=>{},new AbortController().signal);assert.equal(params.length,2);assert.equal(params[0].value,-12345);assert.ok(fake.sent.some(([id])=>id===20),'missing parameter index is retried');assert.equal(fake.listeners.size,0);
 const abort=new AbortController(), waiting=readParameters(new FakeLink(),()=>{},abort.signal);abort.abort();await assert.rejects(waiting,/取消/);
 const file=new FakeLink();const packet=(at,data)=>{const payload=new Uint8Array(97);view(payload).setUint32(0,at,true);view(payload).setUint16(4,42,true);payload[6]=data.length;payload.set(data,7);return{id:120,payload};};
 file.respond=(id,p)=>{if(id===119){const at=view(p).getUint32(0,true);if(at===0){file.emit(packet(0,[0,1,2,3]));file.emit(packet(0,[0,1,2,3]));}else file.emit(packet(at,Array.from({length:8-at},(_,i)=>i+at)));}};
 assert.deepEqual(Array.from(await readLogWindow(file,42,0,8,new AbortController().signal,()=>{})),[0,1,2,3,4,5,6,7]);assert.equal(file.listeners.size,0);
 const connection=new Px4Connection({system:7,component:1});let pinned='';connection.transport.pinPeer=async p=>{pinned=p;};connection.transport.onStatus(true);
 connection.transport.onPacket(Uint8Array.from(f.heartbeatV2),'127.0.0.1:10001',true);assert.equal(pinned,'127.0.0.1:10001');assert.ok(connection.alive);
 const first=connection.lastHeartbeat;connection.transport.onPacket(Uint8Array.from(f.heartbeatV2),'127.0.0.1:10002',true);assert.equal(connection.lastHeartbeat,first,'other UDP sources cannot replace the selected source');
 console.log('PASS: independent MAVLink vectors, integer union decoding, CRC/resync, QGC metadata and indexed/XML lookup, Telnet negotiation, parameter loss retry/cancel, duplicate/out-of-order log coverage, peer isolation.');
}finally{await rm(dir,{recursive:true,force:true});}
