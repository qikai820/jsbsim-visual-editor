import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
const work=await mkdtemp('/tmp/mcp-nsh-command-');
try{
 await build({stdin:{contents:"export {Px4Shell} from './client/src/px4/shell';export * from './client/src/flight-test/mcpNsh';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:work+'/shell.cjs',logLevel:'silent'});
 const {Px4Shell,validateNshRequest}=createRequire(import.meta.url)(work+'/shell.cjs');
 class Link{
  constructor(mode='ok'){this.mode=mode;this.abort=new AbortController();this.signal=this.abort.signal;this.alive=true;this.connected=true;this.target={system:7,component:1};this.listeners=new Set();this.writes=[];this.commands=[];this.line='';}
  subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(text){const data=new TextEncoder().encode(text);for(let i=0;i<data.length;i+=17){const p=new Uint8Array(81);p[6]=10;p[8]=Math.min(17,data.length-i);p.set(data.subarray(i,i+17),9);for(const fn of this.listeners)fn({id:126,payload:p});}}
  async send(id,p){assert.equal(id,126);assert.deepEqual([p[79],p[80]],[7,1]);const text=new TextDecoder().decode(p.subarray(9,9+p[8]));this.writes.push(text);if(!text)return;
   if(text==='\n'){if(this.mode!=='no-prompt')queueMicrotask(()=>this.emit('\r\nnsh> '));return;}
   if(text==='\x03'){this.emit('\r\nnsh> ');return;}
   this.line+=text;if(!this.line.endsWith('\r'))return;
   const line=this.line;this.line='';this.commands.push(line);if(this.mode==='silent')return;
   const token=/then echo (MCP[0-9a-f]+)0/.exec(line)[1];
   this.emit(line+'\n');
   if(this.mode==='large')this.emit('x'.repeat(70000)+'\r\n');else this.emit('\x1b[32m参数值：1\x1b[0m\r\n');
   this.emit(token+(this.mode==='failure'?'1':'0')+'\r\nnsh> ');
  }
 }
 for(const mode of ['ok','failure','large']){const link=new Link(mode),shell=new Px4Shell(link);const r=await shell.runCommand('param show SYS_HITL',2000,new AbortController().signal);assert.equal(link.commands.length,1);assert.equal(r.succeeded,mode!=='failure');assert.equal(r.truncated,mode==='large');assert(r.output.length<=65536);if(mode==='ok')assert.match(r.output,/参数值：1/);await shell.close(false);assert.equal(link.listeners.size,0);}
 {
  const link=new Link(),shell=new Px4Shell(link);await shell.open();await new Promise(r=>setTimeout(r,0));link.emit('top\r\nrunning');const n=link.writes.length;await assert.rejects(shell.runCommand('status',1000,new AbortController().signal),/空闲/);assert.equal(link.writes.length,n);await shell.close(false);
 }
 {
  const link=new Link(),shell=new Px4Shell(link);await shell.open();await new Promise(r=>setTimeout(r,0));await shell.close(false);link.mode='no-prompt';await assert.rejects(shell.runCommand('status',1000,new AbortController().signal),/超时/);assert.equal(link.commands.length,0,'cached prompt cannot authorize a new command');await shell.close(false);
 }
 {
  const link=new Link('silent'),shell=new Px4Shell(link);await assert.rejects(shell.runCommand('status',1000,new AbortController().signal),/不会自动重试/);assert.equal(link.commands.length,1);assert(!link.writes.includes('\x03'),'timeout does not send Ctrl+C');await assert.rejects(shell.runCommand('status',1000,new AbortController().signal),/空闲/);assert.equal(link.commands.length,1,'unconfirmed command is not replayed');await shell.close(false);
 }
 {
  const link=new Link('silent'),shell=new Px4Shell(link),cancel=new AbortController();const p=shell.runCommand('status',2000,cancel.signal);await new Promise(r=>setTimeout(r,20));cancel.abort();await assert.rejects(p,/取消/);assert(link.writes.includes('\x03'),'explicit UI cancellation interrupts only the owned command');await shell.close(false);
 }
 {
  const link=new Link('silent'),shell=new Px4Shell(link);const p=shell.runCommand('status',2000,new AbortController().signal);await new Promise(r=>setTimeout(r,20));link.alive=false;link.abort.abort();await assert.rejects(p,/断开/);assert.equal(link.commands.length,1);assert(!link.writes.includes('\x03'));await shell.close(false);
 }
 for(const request of [{command:''},{command:'x\ny'},{command:'x'.repeat(257)},{command:'status',timeoutMs:999}])assert.throws(()=>validateNshRequest(request));
 console.log('PASS: same-owner target binding, UTF-8/ANSI output, success/failure markers, bounded capture, cached/busy prompt rejection, no timeout retry/Ctrl+C, explicit cancellation and disconnect cleanup.');
}finally{await rm(work,{recursive:true,force:true});}
