import { DIALECT } from './dialect';
export type Frame = { id: number; system: number; component: number; payload: Uint8Array; signed: boolean };
export function crc16(bytes: Uint8Array, extra: number): number {
  let crc = 0xffff;
  for (const b of [...bytes, extra]) { let t = b ^ (crc & 255); t ^= (t << 4) & 255; crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 65535; }
  return crc;
}
export function crc32(bytes: Uint8Array): number {
  // MAVLink CRC32 starts at zero and has no final XOR (unlike ZIP/ISO CRC32).
  let value = 0;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return value >>> 0;
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
export function normalizeParameterValue(value: number, type: number, bytewise = true): number {
  if (!Number.isFinite(value)) throw Error('请输入有效数值');
  if (type === 9) {
    const rounded = Math.fround(value);
    if (!Number.isFinite(rounded) || (value !== 0 && rounded === 0)) throw Error('数值超出 FLOAT 可表示范围');
    return rounded;
  }
  const limits: Record<number, [number, number]> = { 1:[0,255],2:[-128,127],3:[0,65535],4:[-32768,32767],5:[0,4294967295],6:[-2147483648,2147483647] };
  const range = limits[type];
  if (!range) throw Error('暂不支持修改此参数类型');
  if (!Number.isInteger(value)) throw Error('此参数必须为整数');
  if (value < range[0] || value > range[1]) throw Error(`数值超出参数类型范围 ${range[0]} ～ ${range[1]}`);
  if (!bytewise && Math.fround(value) !== value) throw Error('当前飞控的数值编码无法精确表示此整数');
  return value;
}
export function parameterSetPayload(target: { system: number; component: number }, name: string, type: number, value: number, bytewise = true): Uint8Array {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw Error('无效的 PX4 参数名称');
  value = normalizeParameterValue(value, type, bytewise);
  const p = new Uint8Array(23), d = view(p);
  if (!bytewise || type === 9) d.setFloat32(0, value, true);
  else switch (type) {
    case 1: d.setUint8(0, value); break; case 2: d.setInt8(0, value); break;
    case 3: d.setUint16(0, value, true); break; case 4: d.setInt16(0, value, true); break;
    case 5: d.setUint32(0, value, true); break; case 6: d.setInt32(0, value, true); break;
  }
  p[4] = target.system; p[5] = target.component; p.set(new TextEncoder().encode(name), 6); p[22] = type;
  return p;
}
