import { Channel, invoke } from '@tauri-apps/api/core';
import type { LocalNetworkConfig, LocalSerialConfig, LocalSerialEvent } from '../utils/tauriApi';
export type TransportConfig = { serial?: LocalSerialConfig; network?: LocalNetworkConfig };
export class ToolTransport {
  private session: number | null = null;
  private generation = 0;
  private output = new Set<(bytes: Uint8Array) => void>();
  onStatus: (connected: boolean, error?: string) => void = () => {};
  onEndpoint: (label: string) => void = () => {};
  onPacket: (bytes: Uint8Array, peer?: string, datagram?: boolean) => void = () => {};
  constructor(readonly owner: 'px4' | 'nsh') {}
  subscribe = (fn: (bytes: Uint8Array) => void) => { this.output.add(fn); return () => { this.output.delete(fn); }; };
  async open(config: TransportConfig) {
    await this.close(); const generation = ++this.generation;
    let closedDuringOpen = false, opening = true;
    const pending: LocalSerialEvent[] = [];
    const channel = new Channel<LocalSerialEvent>();
    const deliver = (event: LocalSerialEvent) => {
      if (generation !== this.generation) return;
      if (event.kind === 'status') { if (!event.connected) closedDuringOpen = true; this.onStatus(event.connected, event.error || undefined); }
      if (event.kind === 'endpoint') this.onEndpoint([event.localAddr, event.peerAddr].filter(Boolean).join(' → '));
      if (event.kind === 'data' && event.direction === 'rx') { const bytes = Uint8Array.from(event.bytes); this.output.forEach(fn => fn(bytes)); this.onPacket(bytes, event.peer, event.datagram); }
    };
    channel.onmessage = event => { if (opening) pending.push(event); else deliver(event); };
    const info = await invoke<{ sessionId: number; path: string }>('tool_transport_open', { owner: this.owner, serial: config.serial || null, network: config.network || null, onEvent: channel });
    if (generation !== this.generation) { await invoke('tool_transport_close', { owner: this.owner, sessionId: info.sessionId }); throw Error('连接已取消'); }
    this.session = info.sessionId; opening = false; this.onStatus(true); pending.forEach(deliver); if (closedDuringOpen) { await this.close(); throw Error('连接建立时已被对端关闭'); } return info;
  }
  async write(bytes: Uint8Array) {
    if (this.session === null) throw Error('连接尚未建立');
    await invoke('tool_transport_write', { owner: this.owner, sessionId: this.session, bytes: Array.from(bytes) });
  }
  async pinPeer(address: string) {
    if (this.session === null) throw Error('连接尚未建立');
    await invoke('tool_transport_pin_peer', { owner: this.owner, sessionId: this.session, address });
  }
  async close() {
    this.generation++; const sessionId = this.session; this.session = null;
    if (sessionId !== null) await invoke('tool_transport_close', { owner: this.owner, sessionId });
  }
}
