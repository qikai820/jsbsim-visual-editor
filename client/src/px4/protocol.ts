import { DIALECT } from './dialect';
export type Frame = { id: number; system: number; component: number; payload: Uint8Array; signed: boolean };
export function crc16(bytes: Uint8Array, extra: number): number {
  let crc = 0xffff;
  for (const b of [...bytes, extra]) { let t = b ^ (crc & 255); t ^= (t << 4) & 255; crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 65535; }
  return crc;
}
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
export function encode(id: number, payload: Uint8Array, sequence = 0, system = 254, component = 190): Uint8Array {
  const spec = DIALECT[id]; if (!spec || payload.length > spec.length) throw Error('未知 MAVLink 消息或长度无效');
  let length = payload.length; while (length > 1 && !payload[length - 1]) length--;
  const frame = new Uint8Array(length + 12);
  frame.set([253, length, 0, 0, sequence & 255, system, component, id & 255, (id >> 8) & 255, (id >> 16) & 255]);
  frame.set(payload.subarray(0, length), 10);
  const crc = crc16(frame.subarray(1, length + 10), spec.crc); frame[length + 10] = crc & 255; frame[length + 11] = crc >> 8;
  return frame;
}
export class Parser {
  private buffer = new Uint8Array();
  reset() { this.buffer = new Uint8Array(); }
  push(bytes: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buffer.length + bytes.length); joined.set(this.buffer); joined.set(bytes, this.buffer.length); this.buffer = joined;
    const frames: Frame[] = []; let offset = 0;
    while (this.buffer.length - offset >= 8) {
      const b = this.buffer, v2 = b[offset] === 253;
      if (!v2 && b[offset] !== 254) { offset++; continue; }
      const header = v2 ? 10 : 6;
      if (b.length - offset < header) break;
      if (v2 && (b[offset + 2] & ~1)) { offset++; continue; }
      const n = b[offset + 1], signed = v2 && !!(b[offset + 2] & 1), total = header + n + 2 + (signed ? 13 : 0);
      const id = v2 ? b[offset + 7] | (b[offset + 8] << 8) | (b[offset + 9] << 16) : b[offset + 5];
      const spec = DIALECT[id];
      if (!spec || n > spec.length) { offset++; continue; }
      if (b.length - offset < total) break;
      const sum = crc16(b.subarray(offset + 1, offset + header + n), spec.crc);
      if (sum !== (b[offset + header + n] | (b[offset + header + n + 1] << 8))) { offset++; continue; }
      const payload = new Uint8Array(spec.length); payload.set(b.subarray(offset + header, offset + header + n));
      frames.push({ id, signed, system: b[offset + (v2 ? 5 : 3)], component: b[offset + (v2 ? 6 : 4)], payload }); offset += total;
    }
    this.buffer = this.buffer.slice(offset); if (this.buffer.length > 65536) this.reset();
    return frames;
  }
}
export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const stringAt = (bytes: Uint8Array, start: number, n: number) => new TextDecoder().decode(bytes.subarray(start, start + n)).split('\0')[0];
export function command(target: { system: number; component: number }, cmd: number, values: number[]): Uint8Array {
  const p = new Uint8Array(33), v = view(p); values.slice(0, 7).forEach((x, i) => v.setFloat32(i * 4, x, true));
  v.setUint16(28, cmd, true); p[30] = target.system; p[31] = target.component; return p;
}
export function parameterValue(payload: Uint8Array, bytewise = true): number {
  const d = view(payload), type = payload[24];
  if (!bytewise || type === 9) return d.getFloat32(0, true);
  switch (type) { case 1: return d.getUint8(0); case 2: return d.getInt8(0); case 3: return d.getUint16(0, true); case 4: return d.getInt16(0, true); case 5: return d.getUint32(0, true); case 6: return d.getInt32(0, true); default: throw Error('不支持的参数类型：' + type); }
}
