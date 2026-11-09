import { invoke } from '@tauri-apps/api/core';
import { aborted, delay, frameUri, FtpReader, Px4Connection } from './connection';
import { crc32, parameterValue, stringAt, view } from './protocol';
import { parseMetadata, type MetadataCatalog } from './metadata';
export type Parameter = { name: string; value: number; type: number; index: number };
export type LogEntry = { id: number; time: number; size: number };
export type UlogSummary = { path: string; name: string; size: number; version: number; duration: number | null; topics: Array<{ name: string; multiId: number; samples: number; frequency: number | null }>; parameters: Record<string, number | string>; info: Record<string, string>; dropoutCount: number; dropoutMs: number; truncated: boolean };

export async function readParameters(link: Px4Connection, update: (values: Parameter[], expected: number | null) => void, signal: AbortSignal): Promise<Parameter[]> {
  const values = new Map<number, Parameter>(); let expected: number | null = null, error = '', changed = false;
  const unsubscribe = link.subscribe(frame => {
    if (frame.id !== 22) return;
    const d = view(frame.payload), count = d.getUint16(4, true), index = d.getUint16(6, true), name = stringAt(frame.payload, 8, 16);
    if (!count || count > 32767 || index >= count || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return;
    if (expected !== null && expected !== count) { error = '飞控参数总数发生变化，请重新读取'; return; }
    expected = count;
    try { const value = parameterValue(frame.payload, link.bytewise); if (!Number.isFinite(value)) return;
      if (values.has(index) && values.get(index)!.name !== name) { error = '参数索引发生变化，请重新读取'; return; }
      values.set(index, { name, value, index, type: frame.payload[24] }); changed = true;
    } catch (e) { error = String(e); }
  });
  try {
    await link.send(21, Uint8Array.of(link.target.system, link.target.component));
    const started = Date.now(); let retried = started;
    while (expected === null || values.size < expected) {
      await delay(120, link.signal, signal); if (error) throw Error(error);
      if (changed) { update([...values.values()], expected); changed = false; }
      if (Date.now() - started > 60000) throw Error(`参数读取超时：${values.size}/${expected ?? '?'}，可重新读取缺失参数`);
      if (Date.now() - retried > 1500) {
        retried = Date.now();
        if (expected === null) await link.send(21, Uint8Array.of(link.target.system, link.target.component));
        else for (let i = 0, n = 0; i < expected && n < 32; i++) if (!values.has(i)) {
          aborted(signal, link.signal); const p = new Uint8Array(20); view(p).setInt16(0, i, true); p[2] = link.target.system; p[3] = link.target.component; await link.send(20, p); n++;
        }
      }
    }
    if (error) throw Error(error);
    aborted(signal,link.signal);
    const result = [...values.values()].sort((a,b) => a.index-b.index); update(result, expected); return result;
  } finally { unsubscribe(); }
}

export async function readLogs(link: Px4Connection, update: (logs: LogEntry[], expected: number | null) => void, signal: AbortSignal): Promise<LogEntry[]> {
  const logs = new Map<number, LogEntry>(); let expected: number | null = null;
  const unsubscribe = link.subscribe(frame => {
    if (frame.id !== 118) return; const d = view(frame.payload), count = d.getUint16(10, true); if (count > 10000) return;
    expected = count; if (count) { const id = d.getUint16(8, true); logs.set(id, { id, size: d.getUint32(4, true), time: d.getUint32(0, true) }); }
  });
  const request = () => { const p = new Uint8Array(6); view(p).setUint16(2, 65535, true); p[4] = link.target.system; p[5] = link.target.component; return link.send(117, p); };
  try {
    await request(); const started = Date.now(); let retry = started, previous = -1;
    while (expected === null || logs.size < expected) {
      await delay(150, link.signal, signal);
      if (logs.size !== previous) { previous = logs.size; update([...logs.values()], expected); }
      if (Date.now() - started > 15000) throw Error(`日志列表读取超时：${logs.size}/${expected ?? '?'}`);
      if (Date.now() - retry > 2000) { retry = Date.now(); await request(); }
    }
    const result = [...logs.values()].sort((a,b) => b.id-a.id); update(result, expected); return result;
  } finally { unsubscribe(); }
}

export async function readLogWindow(link: Px4Connection, id: number, offset: number, length: number, signal: AbortSignal, progress: (n: number) => void): Promise<Uint8Array> {
  const bytes = new Uint8Array(length), seen = new Uint8Array(length); let received = 0, error = '', lastData = Date.now(), lastReported = 0;
  const unsubscribe = link.subscribe(frame => {
    if (frame.id !== 120) return; const p = frame.payload, d = view(p), at = d.getUint32(0, true), n = p[6];
    if (d.getUint16(4, true) !== id || at < offset || at >= offset + length || n > 90 || !n || at + n > offset + length) return;
    for (let i = 0; i < n; i++) { const index = at-offset+i; if (seen[index] && bytes[index] !== p[7+i]) { error = '日志内容在传输中发生变化'; return; } if (!seen[index]) { seen[index] = 1; received++; lastData = Date.now(); } bytes[index] = p[7+i]; }
    if (Date.now() - lastReported > 100 || received === length) { lastReported = Date.now(); progress(received); }
  });
  const request = (at: number, count: number) => { const p = new Uint8Array(12), d = view(p); d.setUint32(0, at, true); d.setUint32(4, count, true); d.setUint16(8, id, true); p[10] = link.target.system; p[11] = link.target.component; return link.send(119, p); };
  try {
    await request(offset, length); let retry = Date.now(); const started = retry;
    while (received < length) {
      await delay(100, signal, link.signal); if (error) throw Error(error);
      if (Date.now()-lastData > 10000 || Date.now()-started > 60000) throw Error('日志下载停滞，请检查连接后重试');
      if (Date.now()-retry > 1200) {
        retry = Date.now();
        for (let i = 0, requests = 0; i < length && requests < 8;) {
          if (seen[i]) { i++; continue; } const start = i; while (i < length && !seen[i]) i++;
          await request(offset + start, i-start); requests++;
        }
      }
    }
    return bytes;
  } finally { unsubscribe(); }
}
export async function downloadLog(link: Px4Connection, log: LogEntry, signal: AbortSignal, progress: (bytes: number) => void): Promise<UlogSummary | null> {
  aborted(signal,link.signal);
  const id = await invoke<number | null>('px4_log_begin', { name: `px4_log_${log.id}.ulg`, size: log.size }); if (id === null) return null;
  try {
    for (let offset = 0; offset < log.size;) {
      aborted(signal, link.signal); const bytes = await readLogWindow(link, log.id, offset, Math.min(32760, log.size-offset), signal, n => progress(offset+n));
      await invoke('px4_log_write', { id, offset, bytes: Array.from(bytes) }); offset += bytes.length;
    }
    aborted(signal, link.signal); const summary = await invoke<UlogSummary>('px4_log_finish', { id }); return summary;
  } catch (e) { await invoke('px4_log_cancel', { id }).catch(() => {}); throw e; }
  finally { await link.send(122, Uint8Array.of(link.target.system, link.target.component)).catch(() => {}); }
}

export async function loadVehicleMetadata(link: Px4Connection, signal: AbortSignal): Promise<MetadataCatalog> {
  const ftp = new FtpReader(link);
  const read = async (uri: string, checksum?: number): Promise<string> => {
    aborted(signal, link.signal);
    const bytes = uri.startsWith('mftp://') ? await ftp.read(uri, signal) : Uint8Array.from(await invoke<number[]>('px4_metadata_fetch', { uri }));
    aborted(signal, link.signal);
    if (checksum !== undefined && checksum !== 0 && crc32(bytes) !== checksum) throw Error('飞控元数据 CRC32 校验失败');
    return invoke<string>('px4_metadata_decode', { bytes: Array.from(bytes) });
  };
  const waiting = link.wait(frame => frame.id === 397 || frame.id === 395, 3000, signal); void waiting.catch(() => {});
  await link.requestMessage(397); const fallback = setTimeout(() => { void link.requestMessage(395).catch(() => {}); }, 800);
  let generalFrame; try { generalFrame = await waiting; } finally { clearTimeout(fallback); }
  const general = JSON.parse(await read(frameUri(generalFrame), view(generalFrame.payload).getUint32(4, true)));
  const param = Array.isArray(general.metadataTypes) ? general.metadataTypes.find((p: any) => p.type === 1) : null;
  if (!param || typeof param.uri !== 'string') throw Error('飞控未发布参数元数据地址');
  const candidates = [{ uri: param.uri, crc: param.fileCrc }, { uri: param.uriFallback, crc: param.fileCrcFallback }].filter(p => typeof p.uri === 'string' && p.uri);
  let error: unknown;
  for (const candidate of candidates) {
    const checksum = typeof candidate.crc === 'number' ? candidate.crc >>> 0 : undefined;
    const key = checksum ? `px4-parameter-metadata:${checksum}:${candidate.uri}` : '';
    try {
      if (key) { const cached = localStorage.getItem(key); if (cached) return parseMetadata(cached, { kind: 'cache', label: candidate.uri, uri: candidate.uri, crc: checksum, matched: true }); }
      const text = await read(candidate.uri, checksum);
      const catalog = parseMetadata(text, { kind: 'vehicle', label: candidate.uri, uri: candidate.uri, crc: checksum, matched: true });
      if (key) try { localStorage.setItem(key, text); } catch { /* Metadata remains usable if the cache is full. */ }
      return catalog;
    } catch (e) { aborted(signal, link.signal); if (key) localStorage.removeItem(key); error = e; }
  }
  throw error || Error('无法取得飞控参数元数据');
}
