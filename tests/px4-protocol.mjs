import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const dir=await mkdtemp('/tmp/px4-protocol-');
try{
 await build({stdin:{contents:`export * from './client/src/px4/protocol';export * from './client/src/px4/metadata';export * from './client/src/px4/services';export * from './client/src/px4/shell';export * from './client/src/px4/connection';`,resolveDir:process.cwd()},outfile:dir+'/test.cjs',bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {Parser,encode,view,crc32,parameterValue,normalizeParameterValue,parameterSetPayload,parseMetadata,readParameters,writeParameter,readLogWindow,loadVehicleMetadata,TelnetDecoder,Px4Connection,FtpReader}=createRequire(import.meta.url)(dir+'/test.cjs');
 assert.equal(crc32(new TextEncoder().encode('123456789')),0x2dfd2d88,'independent MAVLink CRC32 check value (init=0, xorout=0)');
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
 assert.equal(parseMetadata(JSON.stringify({version:1,parameters:[{name:'LOCKED',readOnly:true}]}),{kind:'vehicle',label:'test',matched:true}).get('LOCKED').readOnly,true);
 const telnet=new TelnetDecoder();assert.equal(telnet.push(Uint8Array.of(255,251)).bytes.length,0);const t=telnet.push(Uint8Array.of(1,110,115,104,62));assert.deepEqual(Array.from(t.reply),[255,253,1]);assert.equal(new TextDecoder().decode(t.bytes),'nsh>');
 class FakeLink{
  signal=new AbortController().signal;target={system:7,component:1};bytewise=true;alive=true;listeners=new Set();sent=[];
  subscribe=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
  wait=Px4Connection.prototype.wait;
  emit(frame){this.listeners.forEach(fn=>fn(frame));}
  async send(id,payload){this.sent.push([id,payload]);this.respond?.(id,payload);}
 }
 const setPayload=parameterSetPayload({system:7,component:1},'TEST_INT',6,-12346);
 assert.deepEqual(Array.from(encode(23,setPayload,16)),[253,23,0,0,16,254,190,23,0,0,198,207,255,255,7,1,84,69,83,84,95,73,78,84,0,0,0,0,0,0,0,0,6,129,68],'independent pymavlink PARAM_SET byte-wise INT32 vector');
 assert.equal(view(parameterSetPayload({system:7,component:1},'TEST',5,4294967295)).getUint32(0,true),4294967295);
 assert.equal(view(parameterSetPayload({system:7,component:1},'TEST',6,-42,false)).getFloat32(0,true),-42);
 assert.equal(normalizeParameterValue(.2,9),Math.fround(.2));
 for(const [value,type] of [[1.5,6],[2147483648,6],[-1,5],[NaN,9],[Infinity,9],[1e39,9],[1e-100,9],[1,10]])assert.throws(()=>normalizeParameterValue(value,type));
 assert.throws(()=>normalizeParameterValue(16777217,6,false),/精确/);
 const parameter={name:'TEST_INT',type:6,value:-12345,index:0};
 const paramReply=(value,type=6,name='TEST_INT')=>{const payload=new Uint8Array(25);if(type===9)view(payload).setFloat32(0,value,true);else view(payload).setInt32(0,value,true);view(payload).setUint16(4,1,true);payload.set(new TextEncoder().encode(name),8);payload[24]=type;return{id:22,payload};};
 const writer=new FakeLink();let sets=0;const confirmed=[];
 writer.respond=(id,p)=>{
  if(id===23){sets++;if(sets===1)return;writer.emit(paramReply(-12346,6,'OTHER'));writer.emit(paramReply(-12346,9));writer.emit(paramReply(-12346));}
  if(id===20){assert.equal(view(p).getInt16(0,true),-1);assert.equal(new TextDecoder().decode(p.subarray(4)).split('\0')[0],'TEST_INT');writer.emit(paramReply(-12346));}
 };
 assert.equal((await writeParameter(writer,parameter,-12346,new AbortController().signal,p=>confirmed.push(p.value))).value,-12346);
 assert.equal(sets,2,'lost PARAM_SET acknowledgement retries');assert.deepEqual(writer.sent.map(([id])=>id),[23,23,20],'write acknowledgement is followed by an independent named read');assert.deepEqual(confirmed,[-12346,-12346]);assert.equal(writer.listeners.size,0);
 const rejected=new FakeLink();rejected.respond=()=>rejected.emit(paramReply(-12345));let actual;
 await assert.rejects(writeParameter(rejected,parameter,-12346,new AbortController().signal,p=>actual=p.value),/飞控返回 -12345/);assert.equal(actual,-12345);assert.equal(rejected.listeners.size,0);
 const changedBack=new FakeLink();changedBack.respond=id=>changedBack.emit(paramReply(id===23?-12346:-12345));
 await assert.rejects(writeParameter(changedBack,parameter,-12346,new AbortController().signal,()=>{}),/飞控返回 -12345/);
 const floatWrite=new FakeLink();floatWrite.respond=()=>floatWrite.emit(paramReply(.2,9,'TEST_FLOAT'));
 assert.equal((await writeParameter(floatWrite,{name:'TEST_FLOAT',type:9,value:.1,index:0},.2,new AbortController().signal,()=>{})).value,Math.fround(.2));
 const noAck=new FakeLink();
 await assert.rejects(writeParameter(noAck,parameter,-12346,new AbortController().signal,()=>{}),/结果未确认/);assert.equal(noAck.sent.length,3);assert.equal(noAck.listeners.size,0);
 const cancelledWrite=new FakeLink(),cancelWrite=new AbortController();const pendingWrite=writeParameter(cancelledWrite,parameter,-12346,cancelWrite.signal,()=>{});cancelWrite.abort();await assert.rejects(pendingWrite,/取消/);assert.equal(cancelledWrite.listeners.size,0);
 const brokenWrite=new FakeLink();brokenWrite.respond=()=>{throw Error('transport closed');};await assert.rejects(writeParameter(brokenWrite,parameter,-12346,new AbortController().signal,()=>{}),/transport closed/);assert.equal(brokenWrite.listeners.size,0);
 const ftpBytes=Uint8Array.from({length:600},(_,i)=>i%251), decoder=new TextDecoder();
 const ftpServer=expectedPath=>{
  const link=new FakeLink();let lastReply;
  link.respond=(id,p)=>{
   if(id!==110)return;
   // PX4 treats a repeated sequence as a retry, even when the requested path changed.
   if(lastReply&&view(p).getUint16(3,true)+1===view(lastReply).getUint16(3,true)){link.emit({id:110,payload:lastReply});return;}
   const r=new Uint8Array(254),opcode=p[6],offset=view(p).getUint32(11,true);
   r[1]=254;r[2]=190;view(r).setUint16(3,(view(p).getUint16(3,true)+1)&65535,true);r[5]=3;r[6]=128;r[8]=opcode;view(r).setUint32(11,offset,true);
   if(opcode===4){
    const path=decoder.decode(p.subarray(15,15+p[7]-1));
    if(path!==expectedPath){r[6]=129;r[7]=1;r[15]=10;}
    else{r[7]=4;view(r).setUint32(15,ftpBytes.length,true);}
   }else if(opcode===5){const bytes=ftpBytes.subarray(offset,offset+p[7]);r[7]=bytes.length;r.set(bytes,15);}
   lastReply=r[7]<=4?r:undefined;link.emit({id:110,payload:r});
  };
  return link;
 };
 for(const [uri,path] of [
  ['mftp://etc/extras/component_general.json.xz','etc/extras/component_general.json.xz'],
  ['mftp:///etc/extras/parameters.json.xz','/etc/extras/parameters.json.xz'],
  ['mftp://parameters.json','parameters.json'],
  ['mftp://etc/extras/custom%20parameters.json','etc/extras/custom parameters.json'],
 ]){
  const ftp=ftpServer(path);
  assert.deepEqual(await new FtpReader(ftp).read(uri),ftpBytes,`MAVLink FTP preserves the complete path: ${uri}`);
  assert.equal(ftp.sent.at(-1)[1][6],1,'close the FTP session after the last chunk');assert.equal(ftp.listeners.size,0);
 }
 const missing=ftpServer('etc/extras/present.json');
 await assert.rejects(new FtpReader(missing).read('mftp://etc/extras/missing.json'),error=>/文件或目录不存在/.test(error.message)&&/10/.test(error.message)&&error.message.includes('mftp://etc/extras/missing.json'));
 assert.equal(missing.listeners.size,0);
 assert.deepEqual(await new FtpReader(missing).read('mftp://etc/extras/present.json'),ftpBytes,'a fresh metadata reader must not replay the previous file-not-found response');
 const metadataFixture=JSON.parse(await readFile('tests/fixtures/px4-metadata.json','utf8'));
 const previousWindow=globalThis.window,previousStorage=globalThis.localStorage,cache=new Map(),downloads=[];
 let generalCrc=metadataFixture.general.crc;
 globalThis.localStorage={getItem:key=>cache.get(key)??null,setItem:(key,value)=>cache.set(key,value),removeItem:key=>cache.delete(key)};
 globalThis.window={__TAURI_INTERNALS__:{invoke:async(command,args)=>{
  if(command==='px4_metadata_fetch'){const file=Object.values(metadataFixture).find(value=>value.uri===args.uri);assert.ok(file,'metadata fixture URI');downloads.push(args.uri);return Array.from(Buffer.from(file.compressedBase64,'base64'));}
  if(command==='px4_metadata_decode'){const file=Object.values(metadataFixture).find(value=>value.compressedBase64===Buffer.from(args.bytes).toString('base64'));assert.ok(file,'valid compressed metadata fixture');return file.text;}
  throw Error('unexpected native call '+command);
 }}};
 try{
  const metadataLink=new FakeLink();metadataLink.requestMessage=async()=>{const payload=new Uint8Array(108);view(payload).setUint32(4,generalCrc,true);payload.set(new TextEncoder().encode(metadataFixture.general.uri),8);metadataLink.emit({id:397,payload});};
  const matched=await loadVehicleMetadata(metadataLink,new AbortController().signal);
  assert.equal(matched.source.kind,'vehicle');assert.equal(matched.source.matched,true);assert.equal(matched.get('TEST_CUSTOM').group,'Custom Firmware');
  assert.deepEqual(downloads,[metadataFixture.general.uri,metadataFixture.parameters.uri],'compressed general and parameter metadata both pass their independent PX4 checksums');
  generalCrc=(generalCrc^1)>>>0;
  await assert.rejects(loadVehicleMetadata(metadataLink,new AbortController().signal),/CRC32/,'incorrect general CRC remains rejected');
  assert.equal(metadataLink.listeners.size,0);
 }finally{
  if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage;
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
 console.log('PASS: independent MAVLink vectors, integer union decoding, CRC/resync, metadata, FTP paths/chunks and stale NAK recovery, parameter write/readback, rejection/retry/cancel/timeout, Telnet negotiation, log coverage and peer isolation.');
}finally{await rm(dir,{recursive:true,force:true});}
