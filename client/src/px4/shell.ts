import { Px4Connection } from './connection';
import type { NshResult } from '../flight-test/mcpNsh';
export type TerminalChannel = { write: (data: string) => Promise<void>; subscribe: (fn: (bytes: Uint8Array) => void) => () => void };
export class Px4Shell implements TerminalChannel {
  private listeners = new Set<(bytes: Uint8Array) => void>();
  private cache = new Uint8Array();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  private receiveEpoch = 0;
  private commandRunning = false;
  private promptConfirmed = false;
  active = false;
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(private link: Px4Connection) {}
  subscribe = (fn: (bytes: Uint8Array) => void) => { this.listeners.add(fn); if (this.cache.length) fn(this.cache); return () => { this.listeners.delete(fn); }; };
  private receive(bytes: Uint8Array) {
    if(bytes.length)this.receiveEpoch++;
    const cache = new Uint8Array(this.cache.length + bytes.length); cache.set(this.cache); cache.set(bytes, this.cache.length); this.cache = cache.slice(-256 * 1024);
    if(bytes.length)this.promptConfirmed=/(?:^|[\r\n])nsh>\s*$/.test(new TextDecoder().decode(this.cache).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,''));
    this.listeners.forEach(fn => fn(bytes));
  }
  private packet(bytes: Uint8Array, flags = 22): Uint8Array {
    const p = new Uint8Array(81); p[6] = 10; p[7] = flags; p[8] = bytes.length; p.set(bytes, 9); p[79] = this.link.target.system; p[80] = this.link.target.component; return p;
  }
  async open() {
    if (!this.link.alive) throw Error('请先连接 PX4 并等待心跳'); if (this.active) return;
    this.active = true;
    this.unsubscribe = this.link.subscribe(frame => { if (frame.id === 126 && frame.payload[6] === 10 && frame.payload[8] <= 70) this.receive(frame.payload.slice(9, 9+frame.payload[8])); });
    const disconnected = () => { void this.close(false); }; this.link.signal.addEventListener('abort', disconnected, { once: true });
    const previous = this.unsubscribe; this.unsubscribe = () => { previous?.(); this.link.signal.removeEventListener('abort', disconnected); };
    try {
      await this.write('\n');
      this.timer = setInterval(() => { if (this.active && this.link.alive) void this.link.send(126, this.packet(new Uint8Array())).catch(e => this.onError(String(e))); }, 500);
      this.onChange();
    } catch (e) { await this.close(false); throw e; }
  }
  write = (data: string): Promise<void> => {
    if (!this.active) return Promise.reject(Error('终端会话未连接'));
    const bytes = new TextEncoder().encode(data);
    if(bytes.length)this.promptConfirmed=false;
    const work = this.queue.then(async () => { for (let i = 0; i < bytes.length; i += 70) { if (!this.active) throw Error('终端会话已结束'); await this.link.send(126, this.packet(bytes.subarray(i, i+70))); } });
    this.queue = work.catch(() => {}); return work;
  };
  async runCommand(command: string, timeoutMs: number, signal: AbortSignal, beforeSend?: () => void): Promise<Pick<NshResult,'command'|'output'|'succeeded'|'truncated'|'durationMs'>> {
    if (!command.trim() || command.length>256 || /[\x00-\x1f\x7f]/.test(command)) throw Error('NSH 只接受一条不超过 256 字符的非交互命令');
    if (!Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>30000) throw Error('NSH 超时范围为 1000～30000 ms');
    if (this.commandRunning) throw Error('已有 NSH 命令正在执行');
    if (signal.aborted || this.link.signal.aborted || !this.link.alive) throw Error('飞控连接已断开或操作已取消');
    const clean=(text:string)=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
    const atPrompt=()=>this.promptConfirmed&&/(?:^|[\r\n])nsh>\s*$/.test(clean(new TextDecoder().decode(this.cache)));
    if(this.active&&!atPrompt())throw Error('终端尚未回到空闲 nsh> 提示符，或有未提交输入；未发送命令');
    this.commandRunning=true;
    const started=performance.now(),deadline=started+timeoutMs;
    let sent=false;
    const pending=new Set<()=>void>();
    const wait=<T,>(accept:(text:string,output:string,truncated:boolean)=>T|undefined)=>new Promise<T>((resolve,reject)=>{
      let tail='',output='',truncated=false,settled=false;
      const decoder=new TextDecoder();
      const dispose:()=>void=()=>finish(Error('NSH 采集已结束'));
      const finish=(error?:Error,result?:T):void=>{if(settled)return;settled=true;pending.delete(dispose);clearTimeout(timer);this.listeners.delete(receive);signal.removeEventListener('abort',cancel);this.link.signal.removeEventListener('abort',cancel);error?reject(error):resolve(result!);};
      const cancel=()=>finish(Error('NSH 操作已取消或飞控连接已断开；命令不会重放'));
      const receive=(bytes:Uint8Array)=>{
        const text=decoder.decode(bytes,{stream:true});tail=(tail+text).slice(-4096);
        if(output.length+text.length>65536)truncated=true;output=(output+text).slice(0,65536);
        const result=accept(clean(tail),clean(output),truncated);if(result!==undefined)finish(undefined,result);
      };
      const timer=setTimeout(()=>finish(Error('NSH 超时，命令结果未确认；不会自动重试，也不会自动中断远端命令')),Math.max(1,deadline-performance.now()));
      pending.add(dispose);signal.addEventListener('abort',cancel,{once:true});this.link.signal.addEventListener('abort',cancel,{once:true});this.listeners.add(receive);
      if(signal.aborted||this.link.signal.aborted)cancel();
    });
    try {
      if(!this.active){
        const before=this.receiveEpoch;await this.open();
        if(this.receiveEpoch===before||!atPrompt())await wait(text=>/(?:^|[\r\n])nsh>\s*$/.test(text)?true:undefined);
      }
      if(!atPrompt())throw Error('终端未就绪，未发送命令');
      beforeSend?.();
      const token='MCP'+crypto.randomUUID().replace(/-/g,'').slice(0,12);
      const result=wait((tail,output,truncated)=>{
        const lines=tail.replace(/\r/g,'\n').split('\n').map(s=>s.trim());
        const succeeded=lines.includes(token+'0')?true:lines.includes(token+'1')?false:undefined;
        if(succeeded===undefined||!/(?:^|[\r\n])nsh>\s*$/.test(tail))return;
        return {command,output:output.replace(/\r/g,'\n').split('\n').filter(line=>!line.includes(token)&&line.trim()!=='nsh>').join('\n').trim(),succeeded,truncated,durationMs:Math.round(performance.now()-started)};
      });
      // Observe rejection immediately: a failed transport write must not leave
      // an unhandled timeout while the receive listener is being cleaned up.
      void result.catch(()=>{});
      sent=true;
      await this.write(`if ${command}; then echo ${token}0; else echo ${token}1; fi\r`);
      return await result;
    } catch(error) {
      if(sent&&signal.aborted&&!this.link.signal.aborted&&this.link.alive)await this.write('\x03').catch(()=>{});
      throw error;
    } finally {for(const dispose of pending)dispose();this.commandRunning=false;}
  }
  async saveParameters(signal: AbortSignal) {
    if (signal.aborted) throw Error('操作已取消');
    await this.open();
    // PREFLIGHT_STORAGE is acknowledged before PX4's worker finishes saving.
    // Wait for the synchronous NSH command's exit status before requesting reboot.
    const token = 'PX4S' + Math.random().toString(36).slice(2, 10);
    await new Promise<void>((resolve, reject) => {
      let output = '', unsubscribe = () => {}, timer: ReturnType<typeof setTimeout>;
      const clean = () => { unsubscribe(); clearTimeout(timer); signal.removeEventListener('abort', cancel); this.link.signal.removeEventListener('abort', cancel); };
      const finish = (error?: Error) => { clean(); error ? reject(error) : resolve(); };
      const cancel = () => finish(Error('参数保存已取消或飞控连接已断开'));
      timer = setTimeout(() => finish(Error('参数保存结果未确认，未发送重启指令')), 10000);
      signal.addEventListener('abort', cancel, { once: true }); this.link.signal.addEventListener('abort', cancel, { once: true });
      unsubscribe = this.subscribe(bytes => {
        output = (output + new TextDecoder().decode(bytes)).slice(-16384);
        const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n').split('\n').map(s => s.trim());
        if (lines.includes(token + '0')) finish();
        else if (lines.includes(token + '1')) finish(Error('飞控参数保存失败，未发送重启指令'));
      });
      if (signal.aborted || this.link.signal.aborted) { cancel(); return; }
      // Clear any unfinished input line; leave a running console command alone.
      void this.write(`\x15if param save; then echo ${token}0; else echo ${token}1; fi\r`).catch(e => finish(e instanceof Error ? e : Error(String(e))));
    });
  }
  async close(release = true) {
    this.promptConfirmed=false;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.active && release && this.link.connected) {
      await this.write('\x03').catch(() => {}); await this.link.send(126, this.packet(new Uint8Array(), 0)).catch(() => {});
    }
    this.active = false; this.unsubscribe?.(); this.unsubscribe = undefined; this.onChange();
  }
}
// Telnet negotiation is kept out of the shared terminal renderer.
export class TelnetDecoder {
  private state = 0; private command = 0;
  push(bytes: Uint8Array): { bytes: Uint8Array; reply: Uint8Array } {
    const out: number[] = [], reply: number[] = [];
    for (const b of bytes) {
      if (this.state === 0) { if (b === 255) this.state = 1; else out.push(b); }
      else if (this.state === 1) {
        if (b === 255) { out.push(255); this.state = 0; }
        else if (b >= 251 && b <= 254) { this.command = b; this.state = 2; }
        else this.state = b === 250 ? 3 : 0;
      } else if (this.state === 2) {
        if (this.command === 251) reply.push(255, b === 1 || b === 3 ? 253 : 254, b);
        if (this.command === 253) reply.push(255, 252, b);
        this.state = 0;
      } else if (this.state === 3 && b === 255) this.state = 4;
      else if (this.state === 4) this.state = b === 240 ? 0 : 3;
    }
    return { bytes: Uint8Array.from(out), reply: Uint8Array.from(reply) };
  }
}
