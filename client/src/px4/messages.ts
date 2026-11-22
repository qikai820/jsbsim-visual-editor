import type { Frame } from './protocol';

export const PX4_MESSAGE_LIMIT = 2000;
export const PX4_SEVERITIES = ['紧急', '警报', '严重', '错误', '警告', '通知', '信息', '调试'] as const;
export type Px4Message = {
  id: number; time: number; system: number; component: number;
  severity: number; text: string; incomplete: boolean;
};
type PendingText = { entry: Px4Message; bytes: Uint8Array; next: number; updated: number };

// One passive collector follows the toolbox's existing connection, including
// while its page/window is hidden. It never opens a shell or sends commands.
export class Px4Messages {
  private entries: Px4Message[] = [];
  private listeners = new Set<() => void>();
  private pending = new Map<string, PendingText>();
  private sequence = 0;
  private notification?: ReturnType<typeof setTimeout>;
  getSnapshot = () => this.entries;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() {
    if (this.notification !== undefined) return;
    this.notification = setTimeout(() => {
      this.notification = undefined; this.listeners.forEach(listener => listener());
    }, 50);
  }
  clear = () => {
    this.entries = []; this.pending.clear();
    if (this.notification !== undefined) clearTimeout(this.notification);
    this.notification = undefined; this.listeners.forEach(listener => listener());
  };
  // Do not splice the tail of a message onto a different connection's text.
  resetAssembly = () => { this.pending.clear(); };
  receive = (frame: Frame, now = Date.now()) => {
    if (frame.id !== 253 || frame.signed || frame.payload.length < 51 || frame.payload[0] > 7) return;
    const p = frame.payload, messageId = (p[51] || 0) | ((p[52] || 0) << 8), chunk = p[53] || 0;
    const text = p.subarray(1, 51), end = text.indexOf(0), bytes = text.slice(0, end < 0 ? 50 : end);
    for (const [key, value] of this.pending) if (now - value.updated > 5000) this.pending.delete(key);
    const key = `${frame.system}:${frame.component}:${messageId}`;
    const previous = messageId && chunk > 0 ? this.pending.get(key) : undefined;
    if (previous && chunk < previous.next) return; // Duplicate chunk.
    let joined = bytes, incomplete = !!messageId && chunk > 0;
    if (previous) {
      const gap = chunk !== previous.next || p[0] !== previous.entry.severity;
      const marker = gap ? new TextEncoder().encode(' [缺失分片] ') : new Uint8Array();
      joined = new Uint8Array(previous.bytes.length + marker.length + bytes.length);
      joined.set(previous.bytes); joined.set(marker, previous.bytes.length); joined.set(bytes, previous.bytes.length + marker.length);
      incomplete = previous.entry.incomplete || gap;
    }
    const entry: Px4Message = {
      id: previous?.entry.id ?? ++this.sequence, time: previous?.entry.time ?? now,
      system: frame.system, component: frame.component, severity: p[0],
      // Decode after assembly so a UTF-8 character split at byte 50 survives.
      text: new TextDecoder().decode(joined), incomplete,
    };
    if (!entry.text) { this.pending.delete(key); return; }
    const index = previous ? this.entries.findIndex(item => item.id === entry.id) : -1;
    if (index >= 0) this.entries = this.entries.map((item, i) => i === index ? entry : item);
    else this.entries = [...this.entries, entry].slice(-PX4_MESSAGE_LIMIT);
    if (messageId && end < 0 && chunk < 255) {
      this.pending.delete(key);
      this.pending.set(key, { entry, bytes: joined, next: chunk + 1, updated: now });
      if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    } else this.pending.delete(key);
    this.notify();
  };
}
