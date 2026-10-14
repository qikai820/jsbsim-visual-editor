export type SerialDirection = 'rx' | 'tx';
export type SerialChunk = { direction: SerialDirection; timeMs: number; elapsedUs: number; bytes: number[] };
export type FramingMode = 'fixed' | 'headerLength' | 'headerFooter' | 'delimiter' | 'gap';
export type ChecksumMode = 'none' | 'sum8' | 'xor8' | 'crc16Modbus';
export type FieldType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'f32' | 'f64' | 'ascii' | 'hex';
export type SerialField = { name: string; offset: number; length: number; type: FieldType; endian: 'little' | 'big'; scale: number };
export type FramingRule = {
  mode: FramingMode;
  header: string;
  footer: string;
  delimiter: string;
  fixedLength: number;
  lengthOffset: number;
  lengthWidth: 1 | 2 | 4;
  lengthEndian: 'little' | 'big';
  lengthMeaning: 'payload' | 'total';
  gapMs: number;
  maxLength: number;
  checksum: ChecksumMode;
  checksumStart: number;
  fields: SerialField[];
};
export type SerialFrame = {
  id: number;
  direction: SerialDirection;
  timeMs: number;
  elapsedUs: number;
  bytes: number[];
  valid: boolean | null;
  problem?: string;
};

export const DEFAULT_FRAMING_RULE: FramingRule = {
  mode: 'gap', header: 'AA 55', footer: '', delimiter: '0A', fixedLength: 8,
  lengthOffset: 2, lengthWidth: 1, lengthEndian: 'little', lengthMeaning: 'payload',
  gapMs: 20, maxLength: 4096, checksum: 'none', checksumStart: 0, fields: [],
};

export function parseHex(source: string): number[] {
  const clean = source.replace(/[\s,:-]/g, '');
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('HEX 须由成对的十六进制字符组成');
  return clean.match(/../g)!.map(pair => parseInt(pair, 16));
}

export function toHex(bytes: readonly number[]): string {
  return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function toAscii(bytes: readonly number[]): string {
  return bytes.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
}

export function validateFramingRule(rule: FramingRule): void {
  if (!['fixed', 'headerLength', 'headerFooter', 'delimiter', 'gap'].includes(rule.mode)) throw new Error('拆帧方式无效');
  if (!['none', 'sum8', 'xor8', 'crc16Modbus'].includes(rule.checksum)) throw new Error('校验方式无效');
  if (!['little', 'big'].includes(rule.lengthEndian) || !['payload', 'total'].includes(rule.lengthMeaning)) throw new Error('长度字段设置无效');
  if (!Array.isArray(rule.fields)) throw new Error('字段定义无效');
  if (!Number.isInteger(rule.maxLength) || rule.maxLength < 2 || rule.maxLength > 65536) throw new Error('最大帧长须为 2～65536 字节');
  if (rule.mode === 'fixed' && (!Number.isInteger(rule.fixedLength) || rule.fixedLength < 1 || rule.fixedLength > rule.maxLength)) throw new Error('固定帧长无效');
  if (['headerLength', 'headerFooter'].includes(rule.mode) && parseHex(rule.header).length > rule.maxLength) throw new Error('帧头超过最大帧长');
  if (rule.mode === 'headerFooter' && parseHex(rule.footer).length > rule.maxLength) throw new Error('帧尾超过最大帧长');
  if (rule.mode === 'delimiter' && parseHex(rule.delimiter).length > rule.maxLength) throw new Error('结束符超过最大帧长');
  if (rule.mode === 'headerLength' && (!Number.isInteger(rule.lengthOffset) || rule.lengthOffset < 0 || ![1, 2, 4].includes(rule.lengthWidth) || rule.lengthOffset + rule.lengthWidth > rule.maxLength)) throw new Error('长度字段设置无效');
  if (rule.mode === 'gap' && (!Number.isFinite(rule.gapMs) || rule.gapMs <= 0)) throw new Error('间隔须大于 0 ms');
  if (!Number.isInteger(rule.checksumStart) || rule.checksumStart < 0 || rule.checksumStart >= rule.maxLength) throw new Error('校验起点无效');
  for (const field of rule.fields) {
    if (typeof field.name !== 'string' || !field.name.trim() || !['u8','s8','u16','s16','u32','s32','f32','f64','ascii','hex'].includes(field.type) ||
      !['little','big'].includes(field.endian) || !Number.isInteger(field.offset) || field.offset < 0 || !Number.isInteger(field.length) || field.length <= 0 || !Number.isFinite(field.scale)) throw new Error('字段名称、类型、偏移、长度或比例无效');
  }
}

function checksumWidth(mode: ChecksumMode): number { return mode === 'none' ? 0 : mode === 'crc16Modbus' ? 2 : 1; }

export function checkFrame(bytes: readonly number[], rule: FramingRule): { valid: boolean | null; problem?: string } {
  const width = checksumWidth(rule.checksum);
  if (!width) return { valid: null };
  if (bytes.length < width + rule.checksumStart) return { valid: false, problem: '帧短于校验范围' };
  const end = bytes.length - width;
  const data = bytes.slice(rule.checksumStart, end);
  if (rule.checksum === 'sum8') {
    const sum = data.reduce((value, byte) => value + byte, 0) & 255;
    return sum === bytes[end] ? { valid: true } : { valid: false, problem: `SUM8 错误：应为 ${toHex([sum])}` };
  }
  if (rule.checksum === 'xor8') {
    const xor = data.reduce((value, byte) => value ^ byte, 0);
    return xor === bytes[end] ? { valid: true } : { valid: false, problem: `XOR8 错误：应为 ${toHex([xor])}` };
  }
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  const received = bytes[end] | (bytes[end + 1] << 8);
  return crc === received ? { valid: true } : { valid: false, problem: `CRC16 错误：应为 ${toHex([crc & 255, crc >> 8])}` };
}

type TimedByte = { value: number; timeMs: number; elapsedUs: number };

export class FrameDecoder {
  private buffers: Record<SerialDirection, TimedByte[]> = { rx: [], tx: [] };
  private lastElapsed: Record<SerialDirection, number | null> = { rx: null, tx: null };
  private nextId = 1;
  constructor(public readonly rule: FramingRule) { validateFramingRule(rule); }

  push(chunk: SerialChunk): SerialFrame[] {
    const results: SerialFrame[] = [];
    const buffer = this.buffers[chunk.direction];
    const previous = this.lastElapsed[chunk.direction];
    if (this.rule.mode === 'gap' && buffer.length && previous !== null && chunk.elapsedUs - previous >= this.rule.gapMs * 1000) {
      results.push(this.consume(chunk.direction, buffer.length));
    }
    this.lastElapsed[chunk.direction] = chunk.elapsedUs;
    for (const value of chunk.bytes) buffer.push({ value, timeMs: chunk.timeMs, elapsedUs: chunk.elapsedUs });
    if (this.rule.mode === 'gap') {
      if (buffer.length > this.rule.maxLength) results.push(this.consume(chunk.direction, buffer.length, '超过最大帧长'));
      return results;
    }
    const header = ['headerLength', 'headerFooter'].includes(this.rule.mode) ? parseHex(this.rule.header) : [];
    const footer = this.rule.mode === 'headerFooter' ? parseHex(this.rule.footer) : [];
    const delimiter = this.rule.mode === 'delimiter' ? parseHex(this.rule.delimiter) : [];
    while (buffer.length) {
      if (header.length) {
        const index = findSequence(buffer, header);
        if (index < 0) {
          const retained = Math.min(buffer.length, header.length - 1);
          if (buffer.length > retained) results.push(this.consume(chunk.direction, buffer.length - retained, '未匹配帧头'));
          break;
        }
        if (index > 0) { results.push(this.consume(chunk.direction, index, '未匹配帧头')); continue; }
      }
      let length = 0;
      if (this.rule.mode === 'fixed') length = this.rule.fixedLength;
      else if (this.rule.mode === 'headerLength') {
        const end = this.rule.lengthOffset + this.rule.lengthWidth;
        if (buffer.length < end) break;
        let value = 0;
        for (let index = 0; index < this.rule.lengthWidth; index++) {
          const shift = (this.rule.lengthEndian === 'little' ? index : this.rule.lengthWidth - 1 - index) * 8;
          value += buffer[this.rule.lengthOffset + index].value * 2 ** shift;
        }
        length = this.rule.lengthMeaning === 'total' ? value : end + value + checksumWidth(this.rule.checksum);
        if (length < end || length < header.length || length > this.rule.maxLength) {
          results.push(this.consume(chunk.direction, 1, '长度字段无效'));
          continue;
        }
      } else if (this.rule.mode === 'headerFooter') {
        const at = findSequence(buffer, footer, header.length);
        if (at < 0) {
          if (buffer.length > this.rule.maxLength) results.push(this.consume(chunk.direction, buffer.length, '未找到帧尾'));
          break;
        }
        length = at + footer.length;
        if (length > this.rule.maxLength) {
          results.push(this.consume(chunk.direction, length, '超过最大帧长'));
          continue;
        }
      } else if (this.rule.mode === 'delimiter') {
        const at = findSequence(buffer, delimiter);
        if (at < 0) {
          if (buffer.length > this.rule.maxLength) results.push(this.consume(chunk.direction, buffer.length, '未找到结束符'));
          break;
        }
        length = at + delimiter.length;
        if (length > this.rule.maxLength) {
          results.push(this.consume(chunk.direction, length, '超过最大帧长'));
          continue;
        }
      }
      if (buffer.length < length) break;
      results.push(this.consume(chunk.direction, length));
    }
    return results;
  }

  flush(): SerialFrame[] {
    const frames: SerialFrame[] = [];
    for (const direction of ['rx', 'tx'] as const) {
      if (this.buffers[direction].length) frames.push(this.consume(direction, this.buffers[direction].length,
        this.rule.mode === 'gap' ? undefined : '未完成的帧'));
    }
    return frames;
  }

  flushGap(direction?: SerialDirection): SerialFrame[] {
    if (this.rule.mode !== 'gap') return [];
    return (direction ? [direction] : ['rx', 'tx'] as const).filter(item => this.buffers[item].length)
      .map(item => this.consume(item, this.buffers[item].length));
  }

  private consume(direction: SerialDirection, length: number, problem?: string): SerialFrame {
    const part = this.buffers[direction].splice(0, length);
    const bytes = part.map(item => item.value);
    const checked = problem ? { valid: false as const, problem } : checkFrame(bytes, this.rule);
    return { id: this.nextId++, direction, timeMs: part[0].timeMs, elapsedUs: part[0].elapsedUs,
      bytes, valid: checked.valid, problem: checked.problem };
  }
}

function findSequence(buffer: readonly TimedByte[], sequence: readonly number[], from = 0): number {
  for (let at = from; at <= buffer.length - sequence.length; at++) {
    if (sequence.every((value, index) => buffer[at + index].value === value)) return at;
  }
  return -1;
}

export function decodeField(frame: SerialFrame, field: SerialField): string {
  const bytes = frame.bytes.slice(field.offset, field.offset + field.length);
  if (bytes.length !== field.length) return '超出帧长';
  if (field.type === 'hex') return toHex(bytes);
  if (field.type === 'ascii') return new TextDecoder().decode(Uint8Array.from(bytes));
  const widths: Record<Exclude<FieldType, 'hex' | 'ascii'>, number> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, f32: 4, f64: 8 };
  if (widths[field.type] !== field.length) return '字段长度不匹配';
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const little = field.endian === 'little';
  const value = ({ u8: () => view.getUint8(0), s8: () => view.getInt8(0),
    u16: () => view.getUint16(0, little), s16: () => view.getInt16(0, little),
    u32: () => view.getUint32(0, little), s32: () => view.getInt32(0, little),
    f32: () => view.getFloat32(0, little), f64: () => view.getFloat64(0, little) })[field.type]();
  return String(Number((value * field.scale).toPrecision(10)));
}
