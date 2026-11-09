import { command, encode, Parser, type Frame, stringAt, view } from './protocol';
import { ToolTransport, type TransportConfig } from './transport';
export type Target = { system: number; component: number };
export class Px4Connection {
  readonly transport = new ToolTransport('px4');
  readonly target: Target;
  private parser = new Parser();
  private listeners = new Set<(frame: Frame) => void>();
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private aborter = new AbortController();
  private peer?: string;
  private pinning: Promise<void> = Promise.resolve();
  connected = false;
  lastHeartbeat = 0;
  bytewise = true;
  onChange: () => void = () => {};
  onError: (error: string) => void = () => {};
  endpoint = '';
  version = '';
  uid = '';
  constructor(target: Target, private expectedHost?: string) {
    this.target = target;
    this.transport.onStatus = (connected, error) => {
      this.connected = connected; if (!connected) { this.lastHeartbeat = 0; this.aborter.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
      if (error) this.onError(error); this.onChange();
    };
    this.transport.onEndpoint = label => { this.endpoint = label; this.onChange(); };
    this.transport.onPacket = (bytes, peer, datagram) => {
      if (this.peer && peer && peer !== this.peer) return;
      const parser = datagram ? new Parser() : this.parser;
      for (const frame of parser.push(bytes)) {
        if (frame.signed) { this.onError('此链路使用 MAVLink 签名；当前工具未配置签名密钥，拒绝处理签名帧'); continue; }
        if (this.expectedHost && peer && peer.slice(0,peer.lastIndexOf(':')) !== this.expectedHost) continue;
        if (target.system === 0) {
          if (frame.id !== 0 || frame.payload[5] !== 12 || frame.component !== 1) continue;
          target.system = frame.system; target.component = frame.component;
        }
        if (frame.system !== target.system || frame.component !== target.component) continue;
        if (frame.id === 0) {
          if (frame.payload[5] !== 12) continue;
          if (!this.peer && peer && datagram) { this.pinning = this.transport.pinPeer(peer); void this.pinning.catch(e => this.onError(String(e))); }
          this.peer = peer; this.lastHeartbeat = Date.now(); this.onChange();
        }
        if (!this.lastHeartbeat) continue;
        if (frame.id === 148) {
          const v = view(frame.payload), flags = v.getBigUint64(0, true), version = v.getUint32(16, true);
          if ((flags & 16n) !== 0n) this.bytewise = true; else if ((flags & 131072n) !== 0n) this.bytewise = false;
          this.version = `${version >>> 24}.${(version >>> 16) & 255}.${(version >>> 8) & 255}`;
          this.uid = v.getBigUint64(8, true).toString(16); this.onChange();
        }
        this.listeners.forEach(fn => fn(frame));
      }
    };
  }
  get alive() { return this.connected && this.lastHeartbeat > Date.now() - 5000; }
  get signal() { return this.aborter.signal; }
  subscribe = (fn: (frame: Frame) => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  async open(config: TransportConfig) {
    this.aborter = new AbortController(); this.parser.reset(); this.peer = undefined; this.pinning = Promise.resolve();
    await this.transport.open(config);
    if (this.signal.aborted) throw Error('连接已断开');
    this.timer = setInterval(() => {
      if (!this.lastHeartbeat && config.network?.mode === 'udp' && !config.network.host) { this.onChange(); return; }
      const p = new Uint8Array([0, 0, 0, 0, 6, 8, 0, 4, 3]);
      void this.send(0, p).catch(e => this.onError(String(e))); this.onChange();
    }, 1000);
  }
  async send(id: number, payload: Uint8Array) { await this.pinning; await this.transport.write(encode(id, payload, this.sequence++)); }
  async requestMessage(id: number) { await this.send(76, command(this.target, 512, [id])); }
  wait(predicate: (frame: Frame) => boolean, timeout: number, signal?: AbortSignal): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted || signal?.aborted) { reject(Error('操作已取消或连接已断开')); return; }
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => { unsubscribe(); clearTimeout(timer); this.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); };
      const abort = () => { clean(); reject(Error('操作已取消或连接已断开')); };
      const unsubscribe = this.subscribe(frame => { if (predicate(frame)) { clean(); resolve(frame); } });
      timer = setTimeout(() => { clean(); reject(Error('等待飞控响应超时')); }, timeout);
      this.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async close() {
    if (this.timer) clearInterval(this.timer); this.timer = undefined; this.aborter.abort(); this.lastHeartbeat = 0; this.connected = false;
    await this.transport.close(); this.onChange();
  }
}
export function aborted(...signals: Array<AbortSignal | undefined>) { if (signals.some(s => s?.aborted)) throw Error('操作已取消或连接已断开'); }
export function delay(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> {
  return new Promise((resolve, reject) => {
    try { aborted(...signals); } catch (e) { reject(e); return; }
    const cleanup = () => { signals.forEach(s => s?.removeEventListener('abort', abort)); clearTimeout(timer); };
    const abort = () => { cleanup(); reject(Error('操作已取消或连接已断开')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms); signals.forEach(s => s?.addEventListener('abort', abort, { once: true }));
  });
}
export class FtpReader {
  private sequence = 0;
  constructor(private connection: Px4Connection) {}
  private async request(opcode: number, session: number, offset: number, data: Uint8Array, size: number, signal?: AbortSignal) {
    const seq = this.sequence; this.sequence = (this.sequence + 2) & 65535;
    const p = new Uint8Array(254), v = view(p); p[1] = this.connection.target.system; p[2] = this.connection.target.component;
    v.setUint16(3, seq, true); p[5] = session; p[6] = opcode; p[7] = size; v.setUint32(11, offset, true); p.set(data, 15);
    for (let attempt = 0; attempt < 4; attempt++) {
      aborted(this.connection.signal, signal);
      const waiting = this.connection.wait(f => f.id === 110 && (f.payload[1] === 254 || f.payload[1] === 0) && (f.payload[2] === 190 || f.payload[2] === 0) && view(f.payload).getUint16(3, true) === ((seq + 1) & 65535) && f.payload[8] === opcode && (opcode === 4 || f.payload[5] === session) && (opcode !== 5 || view(f.payload).getUint32(11, true) === offset), 1000, signal);
      // Attach a rejection handler before writing: a failed transport must not leave an unobserved waiter.
      void waiting.catch(() => {});
      await this.connection.send(110, p);
      let response: Frame;
      try { response = await waiting; } catch (e) { if (attempt === 3 || signal?.aborted || this.connection.signal.aborted) throw e; continue; }
      if (response.payload[6] === 129) throw Error('飞控 FTP 拒绝请求，错误码 ' + response.payload[15]);
      if (response.payload[6] !== 128 || response.payload[7] > 239) throw Error('飞控 FTP 响应无效');
      return response.payload;
    }
    throw Error('飞控 FTP 无响应');
  }
  async read(uri: string, signal?: AbortSignal): Promise<Uint8Array> {
    const match = uri.match(/^mftp:\/\/[^/]*(\/.*)$/); if (!match) throw Error('无效的 MAVLink FTP URI');
    const path = new TextEncoder().encode(decodeURIComponent(match[1]) + '\0'); if (path.length > 239) throw Error('元数据路径过长');
    const opened = await this.request(4, 0, 0, path, path.length, signal), session = opened[5];
    try {
      const length = view(opened).getUint32(15, true); if (opened[7] < 4 || length > 16 * 1024 * 1024) throw Error('元数据文件过大或响应无效');
      const file = new Uint8Array(length); let offset = 0;
      while (offset < length) {
        const response = await this.request(5, session, offset, new Uint8Array(), Math.min(239, length - offset), signal), n = response[7];
        if (!n || n > length - offset) throw Error('元数据传输提前结束'); file.set(response.subarray(15, 15 + n), offset); offset += n;
      }
      return file;
    } finally { await this.request(1, session, 0, new Uint8Array(), 0).catch(() => {}); }
  }
}
export const frameUri = (f: Frame) => f.id === 397 ? stringAt(f.payload, 8, 100) : stringAt(f.payload, 12, 100);
