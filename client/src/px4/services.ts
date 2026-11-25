import { invoke } from '@tauri-apps/api/core';
import { aborted, delay, frameUri, FtpReader, Px4Connection } from './connection';
import { crc32, normalizeParameterValue, parameterSetPayload, parameterValue, stringAt, view } from './protocol';
import { parseMetadata, type MetadataCatalog } from './metadata';
import { cacheLocalText } from '../utils/browserCache';
export type Parameter = { name: string; value: number; type: number; index: number };
export type LogEntry = { id: number; time: number; size: number };
export type LogDownloadPhase = 'direct' | 'staging' | 'copying';
export type UlogSummary = { path: string; name: string; size: number; version: number; duration: number | null; topics: Array<{ name: string; multiId: number; samples: number; frequency: number | null }>; parameters: Record<string, number | string>; info: Record<string, string>; dropoutCount: number; dropoutMs: number; truncated: boolean };

export async function readParameter(link: Px4Connection, name: string, signal: AbortSignal): Promise<Parameter> {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw Error('无效的 PX4 参数名称');
  const request = new Uint8Array(20); view(request).setInt16(0, -1, true);
  request[2] = link.target.system; request[3] = link.target.component; request.set(new TextEncoder().encode(name), 4);
  const control = new AbortController(), cancel = () => control.abort(); signal.addEventListener('abort', cancel, { once: true });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      aborted(signal, link.signal);
      if (!link.alive) throw Error('请等待飞控心跳后读取参数');
      const waiting = link.wait(f => f.id === 22 && stringAt(f.payload, 8, 16) === name, 1000, control.signal);
      void waiting.catch(() => {});
      await link.send(20, request);
      try {
        const frame = await waiting, value = parameterValue(frame.payload, link.bytewise);
        if (!Number.isFinite(value)) throw Error(`${name} 返回了无效数值`);
        return { name, value, type: frame.payload[24], index: view(frame.payload).getUint16(6, true) };
      } catch (e) { aborted(signal, link.signal); if (attempt === 2) throw Error(`无法读取 ${name}：${e instanceof Error ? e.message : String(e)}`); }
    }
    throw Error(`无法读取 ${name}`);
  } finally { control.abort(); signal.removeEventListener('abort', cancel); }
}

export async function writeParameter(link: Px4Connection, parameter: Parameter, value: number, signal: AbortSignal, update: (parameter: Parameter) => void): Promise<Parameter> {
  aborted(signal, link.signal);
  if (!link.alive) throw Error('请等待飞控心跳后再写入参数');
  const expected = normalizeParameterValue(value, parameter.type, link.bytewise);
  const payload = parameterSetPayload(link.target, parameter.name, parameter.type, expected, link.bytewise);
  const control = new AbortController(), cancel = () => control.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const exchange = async (id: number, payload: Uint8Array): Promise<Parameter> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      aborted(signal, link.signal);
      const waiting = link.wait(frame => frame.id === 22 && frame.payload[24] === parameter.type && stringAt(frame.payload, 8, 16) === parameter.name, 1000, control.signal);
      void waiting.catch(() => {});
      await link.send(id, payload);
      let response;
      try { response = await waiting; }
      catch { aborted(signal, link.signal); if (attempt < 2) continue; throw Error(`${parameter.name} 写入结果未确认，请重新读取参数核实`); }
      const actual = { ...parameter, value: parameterValue(response.payload, link.bytewise) };
      if (!Number.isFinite(actual.value)) throw Error('飞控返回了无效参数值');
      update(actual);
      if (actual.value !== expected) throw Error(`${parameter.name} 未写入目标值：请求 ${expected}，飞控返回 ${actual.value}`);
      return actual;
    }
    throw Error('飞控参数无响应');
  };
  try {
    await exchange(23, payload);
    // A separate named read confirms the stored value after PARAM_SET acknowledgement.
    const read = new Uint8Array(20); view(read).setInt16(0, -1, true);
    read[2] = link.target.system; read[3] = link.target.component; read.set(new TextEncoder().encode(parameter.name), 4);
    return await exchange(20, read);
  } finally { control.abort(); signal.removeEventListener('abort', cancel); }
}

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
  const bytes=new Uint8Array(length),seen=new Uint8Array(length);
  let received=0,error='',lastData=Date.now(),lastReported=0;
  let requestedStart=0,requestedEnd=length,lastRequest=0;
  const unsubscribe=link.subscribe(frame=>{
    if(frame.id!==120)return;
    const p=frame.payload,d=view(p),at=d.getUint32(0,true),n=p[6];
    if(d.getUint16(4,true)!==id||!n||n>90||p.length<7+n||at>=offset+length||at+n<=offset)return;
    const first=Math.max(at,offset),end=Math.min(at+n,offset+length);
    for(let pos=first;pos<end;pos++){
      const index=pos-offset,value=p[7+pos-at];
      if(seen[index]&&bytes[index]!==value){error='日志内容在传输中发生变化';return;}
      if(!seen[index]){seen[index]=1;received++;lastData=Date.now();}bytes[index]=value;
    }
    if(Date.now()-lastReported>100||received===length){lastReported=Date.now();progress(received);}
  });
  const request=async(start:number,end:number)=>{
    const p=new Uint8Array(12),d=view(p);d.setUint32(0,offset+start,true);d.setUint32(4,end-start,true);d.setUint16(8,id,true);p[10]=link.target.system;p[11]=link.target.component;
    requestedStart=start;requestedEnd=end;lastRequest=Date.now();await link.send(119,p);
  };
  const missing=(start:number,end:number)=>{for(let i=start;i<end;i++)if(!seen[i])return i;return end;};
  try{
    const started=Date.now();await request(0,length);
    while(received<length){
      await delay(20,signal,link.signal);if(error)throw Error(error);if(received===length)break;
      const now=Date.now();
      if(now-lastData>10000||now-started>60000)throw Error('日志下载停滞，请检查连接后重试');
      // PX4 has a single outstanding LOG_REQUEST_DATA range. Do not replace a
      // progressing stream or enqueue several repairs that overwrite each other.
      const rangeComplete=missing(requestedStart,requestedEnd)===requestedEnd;
      if(rangeComplete||(now-lastData>250&&now-lastRequest>300)){
        const first=missing(0,length);let end=first+1;while(end<length&&!seen[end])end++;
        await request(first,end);
      }
    }
    if(error)throw Error(error);return bytes;
  }finally{unsubscribe();}
}
export async function downloadLog(
  link: Px4Connection,
  log: LogEntry,
  signal: AbortSignal,
  progress: (bytes: number, phase: LogDownloadPhase) => void,
  managed?: { onBegin: (id: number) => void },
  simulator?: string,
): Promise<UlogSummary | null> {
  aborted(signal,link.signal);
  const identity={uid:link.uid,boot:link.bootGeneration,heartbeat:link.heartbeatGeneration,session:link.transport.sessionId,system:link.target.system,component:link.target.component};
  const checkIdentity=()=>{aborted(signal,link.signal);if(!link.alive||link.transport.sessionId!==identity.session||link.bootGeneration!==identity.boot||(!simulator&&link.heartbeatGeneration!==identity.heartbeat)||(identity.uid&&link.uid!==identity.uid)||link.target.system!==identity.system||link.target.component!==identity.component)throw Error('日志来源飞控或连接已变化，未保存为完整文件');};
  if (simulator && (link.expectedHost !== simulator || link.armed !== false || !identity.uid || identity.uid === '0')) {
    throw Error('经任务机下载需要确认飞控已上锁且已识别 UID');
  }
  const id = managed ? await invoke<number>('px4_log_begin_managed',{logId:log.id,size:log.size,time:log.time,sessionId:identity.session,system:identity.system,component:identity.component,hardwareUid:identity.uid}) : await invoke<number | null>('px4_log_begin', { name: `px4_log_${log.id}.ulg`, size: log.size }); if (id === null) return null;
  try {
    managed?.onBegin(id);
    if (simulator) {
      checkIdentity();
      await link.ready;
      checkIdentity();
      const cancel = () => { void invoke('px4_log_cancel', { id }).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      link.signal.addEventListener('abort', cancel, { once: true });
      let reporting = true;
      const timer = setInterval(() => {
        void invoke<{ staged: number; saved: number; copying: boolean } | null>('px4_log_relay_progress', { id })
          .then(value => { if (reporting && value && !signal.aborted && !link.signal.aborted) {
            progress(value.copying ? value.saved : value.staged, value.copying ? 'copying' : 'staging');
          } }).catch(() => {});
      }, 250);
      try {
        await invoke('px4_log_relay', { id, request: {
          simulator, sessionId: identity.session, system: identity.system, component: identity.component,
          hardwareUid: identity.uid, logId: log.id, time: log.time, size: log.size,
        } });
      } finally {
        reporting = false;
        clearInterval(timer);
        signal.removeEventListener('abort', cancel);
        link.signal.removeEventListener('abort', cancel);
      }
      checkIdentity();
      if (link.armed !== false) throw Error('飞控解锁状态已变化，未保存日志');
      progress(log.size, 'copying');
      return await invoke<UlogSummary>('px4_log_finish', { id });
    }
    let lastReceipt=0;
    for (let offset = 0; offset < log.size;) {
      if(managed)checkIdentity();else aborted(signal,link.signal); const bytes = await readLogWindow(link, log.id, offset, Math.min(262080, log.size-offset), signal, n => {progress(offset+n,'direct');if(managed&&Date.now()-lastReceipt>250){lastReceipt=Date.now();void invoke("px4_log_transfer_received",{id,received:offset+n}).catch(()=>{});}});
      for(let start=0;start<bytes.length;start+=65520){aborted(signal,link.signal);await invoke('px4_log_write',{id,offset:offset+start,bytes:Array.from(bytes.subarray(start,start+65520))});}offset+=bytes.length;
    }
    aborted(signal, link.signal);
    if(managed){checkIdentity();const current=(await readLogs(link,()=>{},signal)).find(item=>item.id===log.id);if(!current||current.size!==log.size||current.time!==log.time)throw Error('机载日志在下载期间发生变化，未保存为完整文件');}
    if(managed)checkIdentity();else aborted(signal,link.signal); const summary = await invoke<UlogSummary>('px4_log_finish', { id }); return summary;
  } catch (e) { await invoke('px4_log_cancel', { id }).catch(() => {}); if(managed)await invoke('px4_log_transfer_error',{id,error:String(e),cancelled:signal.aborted}).catch(()=>{}); throw e; }
  finally { if (!simulator) await link.send(122, Uint8Array.of(link.target.system, link.target.component)).catch(() => {}); }
}

export async function loadVehicleMetadata(link: Px4Connection, signal: AbortSignal): Promise<MetadataCatalog> {
  const ftp = new FtpReader(link);
  const read = async (uri: string, checksum?: number, decodedChecksum = false): Promise<string> => {
    aborted(signal, link.signal);
    const bytes = uri.startsWith('mftp://') ? await ftp.read(uri, signal) : Uint8Array.from(await invoke<number[]>('px4_metadata_fetch', { uri }));
    aborted(signal, link.signal);
    const text = await invoke<string>('px4_metadata_decode', { bytes: Array.from(bytes) }).catch(error => {
      throw Error(`元数据解码失败（${uri}）：${error instanceof Error ? error.message : String(error)}`);
    });
    // PX4 publishes the general JSON checksum before compression; parameter CRCs cover the downloaded file.
    if (checksum !== undefined && checksum !== 0 && crc32(bytes) !== checksum &&
        (!decodedChecksum || crc32(new TextEncoder().encode(text)) !== checksum)) throw Error(`飞控元数据 CRC32 校验失败：${uri}`);
    return text;
  };
  const waiting = link.wait(frame => frame.id === 397 || frame.id === 395, 3000, signal); void waiting.catch(() => {});
  await link.requestMessage(397); const fallback = setTimeout(() => { void link.requestMessage(395).catch(() => {}); }, 800);
  let generalFrame; try { generalFrame = await waiting; } finally { clearTimeout(fallback); }
  const general = JSON.parse(await read(frameUri(generalFrame), view(generalFrame.payload).getUint32(4, true), true));
  const param = Array.isArray(general.metadataTypes) ? general.metadataTypes.find((p: any) => p.type === 1) : null;
  if (!param || typeof param.uri !== 'string') throw Error('飞控未发布参数元数据地址');
  const candidates = [{ uri: param.uri, crc: param.fileCrc }, { uri: param.uriFallback, crc: param.fileCrcFallback }].filter(p => typeof p.uri === 'string' && p.uri);
  const errors: string[] = [];
  for (const candidate of candidates) {
    const checksum = typeof candidate.crc === 'number' ? candidate.crc >>> 0 : undefined;
    const key = checksum ? `px4-parameter-metadata:${checksum}:${candidate.uri}` : '';
    try {
      if (key) { const cached = localStorage.getItem(key); if (cached) return parseMetadata(cached, { kind: 'cache', label: candidate.uri, uri: candidate.uri, crc: checksum, matched: true }); }
      const text = await read(candidate.uri, checksum);
      const catalog = parseMetadata(text, { kind: 'vehicle', label: candidate.uri, uri: candidate.uri, crc: checksum, matched: true });
      if (key) cacheLocalText(key, text);
      return catalog;
    } catch (e) { aborted(signal, link.signal); if (key) localStorage.removeItem(key); errors.push(`${candidate.uri}：${e instanceof Error ? e.message : String(e)}`); }
  }
  throw Error(errors.join('；') || '无法取得飞控参数元数据');
}
