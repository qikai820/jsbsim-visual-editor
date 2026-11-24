import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
const dir=await mkdtemp('/tmp/mcp-logs-');
try{
 await build({stdin:{contents:"export {downloadLog,readLogWindow} from './client/src/px4/services';export * from './client/src/flight-test/mcpLogs';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:dir+'/test.cjs',logLevel:'silent',plugins:[{name:'invoke',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const invoke=(...a)=>globalThis.invokeMock(...a);export class Channel{}'}));}}]});
 const {downloadLog,readLogWindow,validateLogRequest,registerLogOwner,setRemoteLogHandler,requestMcpLog}=createRequire(import.meta.url)(dir+'/test.cjs');
 const bytes=Uint8Array.from({length:1200},(_,i)=>i%256),log={id:7,time:1234,size:1200};
 for(const mode of ['ok','cancel','disconnect','changed']){
  const calls=[],chunks=[];let receive=0;
  globalThis.invokeMock=async(cmd,args)=>{calls.push({cmd,args});if(cmd==='px4_log_begin_managed')return 42;if(cmd==='px4_log_write'){chunks.push(args);receive+=args.bytes.length;}if(cmd==='px4_log_finish')return{path:'/managed/flight.ulg',size:receive,truncated:false};};
  class Link{
   abort=new AbortController();signal=this.abort.signal;target={system:7,component:1};transport={sessionId:99};listeners=new Set();alive=true;listReads=0;requests=0;skipped=false;
   subscribe=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
   emit(payload,id=120){for(const fn of this.listeners)fn({id,payload});}
   async send(id,p){if(id===119){this.requests++;const d=new DataView(p.buffer),offset=d.getUint32(0,true),count=d.getUint32(4,true);const frames=[];
    for(let i=offset;i<offset+count;i+=90){if(mode==='ok'&&i===90&&!this.skipped){this.skipped=true;continue;}const out=new Uint8Array(97),v=new DataView(out.buffer);const n=Math.min(90,offset+count-i);v.setUint32(0,i,true);v.setUint16(4,7,true);out[6]=n;out.set(bytes.subarray(i,i+n),7);frames.unshift(out);}
    queueMicrotask(()=>{for(const f of frames)this.emit(f);if(frames.length)this.emit(frames[0]);});
   }if(id===117){this.listReads++;const out=new Uint8Array(14),v=new DataView(out.buffer);v.setUint32(0,mode==='changed'?1235:1234,true);v.setUint32(4,1200,true);v.setUint16(8,7,true);v.setUint16(10,1,true);queueMicrotask(()=>this.emit(out,118));}}
  }
  const link=new Link(),abort=new AbortController();let started=0;
  const result=downloadLog(link,log,abort.signal,()=>{if(mode==='cancel')abort.abort();if(mode==='disconnect'){link.alive=false;link.abort.abort();}},{onBegin:id=>{assert.equal(id,42);started++;}});
  if(mode==='ok'){
   const value=await result;assert.equal(value.size,1200);assert.equal(started,1);assert(link.requests>=2,'missing range is requested without restarting transfer');assert.equal(link.listReads,1);assert.deepEqual(Uint8Array.from(chunks.flatMap(c=>c.bytes)),bytes);assert(!calls.some(c=>c.cmd==='px4_log_cancel'));
  }else{
   await assert.rejects(result,mode==='changed'?/日志.*变化/:/取消|断开/);assert(calls.some(c=>c.cmd==='px4_log_cancel'));assert(!calls.some(c=>c.cmd==='px4_log_finish'));assert.equal(calls.find(c=>c.cmd==='px4_log_transfer_error').args.cancelled,mode==='cancel');
  }
  assert.equal(calls.filter(c=>c.cmd==='px4_log_begin_managed').length,1);assert.equal(link.listeners.size,0);
 }
 {
  const bytes=Uint8Array.from({length:12000},(_,i)=>i%251),listeners=new Set();let active=false,replacements=0,generation=0,requests=0;
  const link={signal:new AbortController().signal,target:{system:7,component:1},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},send:async(id,p)=>{
   if(id!==119)return;if(active)replacements++;active=true;requests++;const mine=++generation,d=new DataView(p.buffer),start=d.getUint32(0,true),end=start+d.getUint32(4,true);let at=start;
   const next=()=>{if(mine!==generation)return;if(at>=end){active=false;return;}const pos=at,n=Math.min(90,bytes.length-pos);at+=n;
    if(!(mine===1&&[900,2700,6300,9000].includes(pos))){const out=new Uint8Array(97),v=new DataView(out.buffer);v.setUint32(0,pos,true);v.setUint16(4,7,true);out[6]=n;out.set(bytes.subarray(pos,pos+n),7);for(const fn of listeners)fn({id:120,payload:out});}
    if(at>=end)active=false;else setTimeout(next,10);
   };setTimeout(next,10);
  }};
  const out=await readLogWindow(link,7,0,12000,new AbortController().signal,()=>{});assert.deepEqual(out,bytes);assert.equal(replacements,0,'a healthy active PX4 range is never overwritten');assert.equal(requests,5,'repair the four holes serially');assert.equal(listeners.size,0);
 }
 for(const r of [{action:'download',id:65535,expectedSize:1200,expectedTime:1},{action:'download',id:0,expectedSize:15,expectedTime:0},{action:'cancel',jobId:0}])assert.throws(()=>validateLogRequest(r));
 const requests=[];const off=registerLogOwner(async r=>{requests.push(r);return 'owner';});setRemoteLogHandler(async()=> 'remote');assert.equal(await requestMcpLog({action:'list'}),'owner');off();assert.equal(await requestMcpLog({action:'list'}),'remote');setRemoteLogHandler(null);await assert.rejects(requestMcpLog({action:'list'}));
 console.log('PASS: managed same-owner transfer, out-of-order/duplicate packets, missing-range retransmission, source-log identity change rejection, cancellation/disconnect cleanup, no whole-transfer retry, validated dispatch.');
}finally{await rm(dir,{recursive:true,force:true});}
