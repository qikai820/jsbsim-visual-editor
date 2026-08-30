export interface McapPoint { time: number; value: number }
export interface McapAnalysis {
  valid: boolean; profile: string; library: string; topic: string;
  messageCount: number; startTime: number; endTime: number;
  fields: Record<string, McapPoint[]>;
}

const names = ['timestamp_us', 'sim_time_s', 'latitude_deg', 'longitude_deg', 'altitude_m', 'roll_deg', 'pitch_deg', 'yaw_deg', 'airspeed_mps', 'groundspeed_mps', 'vertical_speed_mps', 'fdm_run_ms'];
const u16 = (v: DataView, p: number) => v.getUint16(p, true);
const u32 = (v: DataView, p: number) => v.getUint32(p, true);
const u64 = (v: DataView, p: number) => Number(v.getBigUint64(p, true));
function text(v: DataView, p: number): [string, number] { const n = u32(v, p); p += 4; return [new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + p, n)), p + n]; }

function lz4Block(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected); let ip = 0; let op = 0;
  while (ip < src.length) {
    const token = src[ip++]; let literals = token >>> 4;
    if (literals === 15) { let n = 255; while (n === 255) { n = src[ip++]; literals += n; } }
    out.set(src.subarray(ip, ip + literals), op); ip += literals; op += literals;
    if (ip >= src.length) break;
    const offset = src[ip++] | (src[ip++] << 8); if (!offset || offset > op) throw new Error('LZ4 offset invalid');
    let length = (token & 15) + 4;
    if ((token & 15) === 15) { let n = 255; while (n === 255) { n = src[ip++]; length += n; } }
    for (let i = 0; i < length; i++) out[op + i] = out[op - offset + i];
    op += length;
  }
  return out.subarray(0, op);
}

function lz4Frame(src: Uint8Array, expected: number): Uint8Array {
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (u32(v, 0) !== 0x184d2204) throw new Error('Unsupported LZ4 frame');
  let p = 7; const parts: Uint8Array[] = []; let total = 0;
  while (p + 4 <= src.length) {
    let size = u32(v, p); p += 4; if (!size) break;
    const raw = !!(size & 0x80000000); size &= 0x7fffffff;
    const part = raw ? src.subarray(p, p + size) : lz4Block(src.subarray(p, p + size), expected - total);
    parts.push(part); total += part.length; p += size;
  }
  const out = new Uint8Array(total); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function varint(data: Uint8Array, start: number): [number, number] { let value = 0; let shift = 0; let p = start; while (p < data.length) { const b = data[p++]; value += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return [value, p]; shift += 7; } throw new Error('protobuf varint truncated'); }
function protobufFields(data: Uint8Array): Array<{ field: number; wire: number; value?: number; bytes?: Uint8Array }> {
  const fields: Array<{ field: number; wire: number; value?: number; bytes?: Uint8Array }> = []; let p = 0;
  while (p < data.length) { let key; [key, p] = varint(data, p); const field = key >>> 3; const wire = key & 7;
    if (wire === 0) { let value; [value, p] = varint(data, p); fields.push({ field, wire, value }); }
    else if (wire === 1) { fields.push({ field, wire, bytes: data.subarray(p, p + 8) }); p += 8; }
    else if (wire === 5) { fields.push({ field, wire, bytes: data.subarray(p, p + 4) }); p += 4; }
    else if (wire === 2) { let length; [length, p] = varint(data, p); fields.push({ field, wire, bytes: data.subarray(p, p + length) }); p += length; }
    else break;
  } return fields;
}
function schemaFieldNames(data: Uint8Array): string[] {
  const result = [...names];
  try {
    const file = protobufFields(data).find(item => item.field === 1 && item.bytes)?.bytes;
    const message = file && protobufFields(file).find(item => item.field === 4 && item.bytes)?.bytes;
    if (!message) return result;
    for (const descriptor of protobufFields(message).filter(item => item.field === 2 && item.bytes)) {
      const parts = protobufFields(descriptor.bytes!); const name = parts.find(item => item.field === 1 && item.bytes)?.bytes;
      const number = parts.find(item => item.field === 3)?.value;
      if (name && number && number > 0) result[number - 1] = new TextDecoder().decode(name);
    }
  } catch { /* fall back to the fixed JSBSim schema */ }
  return result;
}
function decodePayload(data: Uint8Array, fieldNames: string[]): Record<string, number> {
  const result: Record<string, number> = {}; const v = new DataView(data.buffer, data.byteOffset, data.byteLength); let p = 0;
  while (p < data.length) {
    let key; [key, p] = varint(data, p); const field = key >>> 3; const wire = key & 7; const name = fieldNames[field - 1] || `field_${field}`; if (!field) break;
    if (wire === 0) { let value; [value, p] = varint(data, p); result[name] = value; }
    else if (wire === 1) { result[name] = v.getFloat64(p, true); p += 8; }
    else if (wire === 5) { result[name] = v.getFloat32(p, true); p += 4; }
    else if (wire === 2) { let length; [length, p] = varint(data, p); p += length; }
    else throw new Error(`unsupported protobuf wire ${wire}`);
  }
  return result;
}

export async function parseMcap(file: File, maxPoints = 12000): Promise<McapAnalysis> {
  const bytes = new Uint8Array(await file.arrayBuffer()); const v = new DataView(bytes.buffer);
  const magic = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
  if (!magic.every((n, i) => bytes[i] === n)) throw new Error('不是有效的 MCAP 文件');
  let p = 8; let profile = ''; let library = ''; let topic = ''; let fieldNames = [...names]; const samples: Array<{ time: number; values: Record<string, number> }> = [];
  const parseRecords = (records: Uint8Array) => {
    const rv = new DataView(records.buffer, records.byteOffset, records.byteLength); let rp = 0;
    while (rp + 9 <= records.length) { const op = records[rp]; const len = u64(rv, rp + 1); const body = rp + 9; if (body + len > records.length) break;
      if (op === 0x05 && len >= 22) { const logNs = u64(rv, body + 6); const payload = records.subarray(body + 22, body + len); samples.push({ time: logNs / 1e9, values: decodePayload(payload, fieldNames) }); }
      rp = body + len;
    }
  };
  while (p + 9 <= bytes.length - 8) {
    const op = bytes[p]; const len = u64(v, p + 1); const body = p + 9; if (body + len > bytes.length) break;
    if (op === 0x01) { let q = body; [profile, q] = text(v, q); [library] = text(v, q); }
    else if (op === 0x03) { let q = body + 2; [, q] = text(v, q); [, q] = text(v, q); const size = u32(v, q); q += 4; fieldNames = schemaFieldNames(bytes.subarray(q, q + size)); }
    else if (op === 0x04) { let q = body + 4; [topic] = text(v, q); }
    else if (op === 0x06) { let q = body + 16; const uncompressed = u64(v, q); q += 12; let compression; [compression, q] = text(v, q); const compressedSize = u64(v, q); q += 8; const chunk = bytes.subarray(q, q + compressedSize); parseRecords(compression === 'lz4' ? lz4Frame(chunk, uncompressed) : chunk); }
    else if (op === 0x05) parseRecords(bytes.subarray(p, body + len));
    p = body + len;
  }
  const fields: Record<string, McapPoint[]> = {}; const stride = Math.max(1, Math.ceil(samples.length / maxPoints));
  for (let i = 0; i < samples.length; i += stride) for (const [name, value] of Object.entries(samples[i].values)) if (Number.isFinite(value)) (fields[name] ||= []).push({ time: samples[i].time, value });
  return { valid: true, profile, library, topic: topic || '/jsbsim/fdm_state', messageCount: samples.length, startTime: samples[0]?.time || 0, endTime: samples.at(-1)?.time || 0, fields };
}
