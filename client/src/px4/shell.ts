import { Px4Connection } from './connection';
export type TerminalChannel = { write: (data: string) => Promise<void>; subscribe: (fn: (bytes: Uint8Array) => void) => () => void };
export class Px4Shell implements TerminalChannel {
  private listeners = new Set<(bytes: Uint8Array) => void>();
  private cache = new Uint8Array();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  active = false;
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(private link: Px4Connection) {}
  subscribe = (fn: (bytes: Uint8Array) => void) => { this.listeners.add(fn); if (this.cache.length) fn(this.cache); return () => { this.listeners.delete(fn); }; };
  private receive(bytes: Uint8Array) {
    const cache = new Uint8Array(this.cache.length + bytes.length); cache.set(this.cache); cache.set(bytes, this.cache.length); this.cache = cache.slice(-256 * 1024);
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
    const work = this.queue.then(async () => { for (let i = 0; i < bytes.length; i += 70) { if (!this.active) throw Error('终端会话已结束'); await this.link.send(126, this.packet(bytes.subarray(i, i+70))); } });
    this.queue = work.catch(() => {}); return work;
  };
  async close(release = true) {
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
