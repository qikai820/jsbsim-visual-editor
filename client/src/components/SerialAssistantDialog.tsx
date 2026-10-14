import { useEffect, useMemo, useRef, useState } from 'react';
import {
  localSerialClose, localSerialExport, localSerialListPorts, localSerialOpen, localSerialPickCapture,
  localSerialRecordStart, localSerialRecordStop, localSerialReplay, localSerialSetDtr,
  localSerialSetRts, localSerialWrite, type LocalSerialConfig, type LocalSerialEvent,
  type LocalSerialPort,
} from '../utils/tauriApi';
import {
  decodeField, DEFAULT_FRAMING_RULE, FrameDecoder, parseHex, toAscii, toHex,
  validateFramingRule, type FramingMode, type FramingRule, type SerialChunk, type SerialField,
  type SerialFrame,
} from '../utils/serialProtocol';
import './SerialAssistantDialog.css';

const SETTINGS_KEY = 'local-serial-assistant-settings-v1';
const PROFILES_KEY = 'local-serial-assistant-profiles-v1';
const COMMANDS_KEY = 'local-serial-assistant-commands-v1';
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_VIEW_CHUNKS = 4000;
const MAX_VIEW_FRAMES = 4000;

type SavedSettings = { config: LocalSerialConfig; rule: FramingRule };
type CommandTemplate = { text: string; mode: 'hex' | 'text'; lineEnding: 'none' | 'lf' | 'cr' | 'crlf' };
const DEFAULT_CONFIG: LocalSerialConfig = {
  path: '', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none',
};

function savedSettings(): SavedSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const candidate = { ...DEFAULT_FRAMING_RULE, ...(saved.rule || {}) } as FramingRule;
    let rule = DEFAULT_FRAMING_RULE;
    try { validateFramingRule(candidate); rule = candidate; } catch { /* ignore stale settings */ }
    return {
      config: { ...DEFAULT_CONFIG, ...(saved.config || {}) },
      rule,
    };
  } catch { return { config: DEFAULT_CONFIG, rule: DEFAULT_FRAMING_RULE }; }
}

function savedProfiles(): Record<string, FramingRule> {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, rule]) => {
      try { validateFramingRule(rule as FramingRule); return true; } catch { return false; }
    })) as Record<string, FramingRule>;
  } catch { return {}; }
}

function formatTime(timeMs: number): string {
  const date = new Date(timeMs);
  return `${date.toLocaleTimeString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function csvCell(value: string | number | boolean): string {
  const text = typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export default function SerialAssistantDialog({ onClose }: { onClose: () => void }) {
  const initial = useMemo(savedSettings, []);
  const [config, setConfig] = useState<LocalSerialConfig>(initial.config);
  const [rule, setRule] = useState<FramingRule>(initial.rule);
  const [profiles, setProfiles] = useState(savedProfiles);
  const [ports, setPorts] = useState<LocalSerialPort[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordPath, setRecordPath] = useState('');
  const [offlinePath, setOfflinePath] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'raw' | 'frames'>('raw');
  const [search, setSearch] = useState('');
  const [showRx, setShowRx] = useState(true);
  const [showTx, setShowTx] = useState(true);
  const [paused, setPaused] = useState(false);
  const [chunks, setChunks] = useState<SerialChunk[]>([]);
  const [frames, setFrames] = useState<SerialFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [rxBytes, setRxBytes] = useState(0);
  const [txBytes, setTxBytes] = useState(0);
  const [viewDropped, setViewDropped] = useState(0);
  const [sendText, setSendText] = useState('');
  const [sendMode, setSendMode] = useState<'hex' | 'text'>('hex');
  const [lineEnding, setLineEnding] = useState<'none' | 'lf' | 'cr' | 'crlf'>('none');
  const [sendHistory, setSendHistory] = useState<CommandTemplate[]>([]);
  const [savedCommands, setSavedCommands] = useState<CommandTemplate[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COMMANDS_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(value => typeof value?.text === 'string' && ['hex', 'text'].includes(value.mode) && ['none', 'lf', 'cr', 'crlf'].includes(value.lineEnding)) : [];
    } catch { return []; }
  });
  const [repeatMs, setRepeatMs] = useState(1000);
  const [repeating, setRepeating] = useState(false);
  const [dtr, setDtr] = useState<boolean | null>(null);
  const [rts, setRts] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const sessionRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const chunksRef = useRef<SerialChunk[]>([]);
  const framesRef = useRef<SerialFrame[]>([]);
  const decoderRef = useRef(new FrameDecoder(DEFAULT_FRAMING_RULE));
  const byteWindowRef = useRef(0);
  const droppedRef = useRef(0);
  const rxRef = useRef(0);
  const txRef = useRef(0);
  const lastArrivalRef = useRef<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const pausedRef = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const rawEndRef = useRef<HTMLDivElement>(null);

  const ruleError = useMemo(() => {
    try { validateFramingRule(rule); return ''; } catch (error) { return errorText(error); }
  }, [rule]);

  const selectedFrame = frames.find(frame => frame.id === selectedFrameId) || frames[frames.length - 1] || null;
  const filteredChunks = chunks.filter(chunk => (chunk.direction === 'rx' ? showRx : showTx) &&
    (!search || `${toHex(chunk.bytes)} ${toAscii(chunk.bytes)}`.toLowerCase().includes(search.toLowerCase()))).slice(-500);
  const filteredFrames = frames.filter(frame => (frame.direction === 'rx' ? showRx : showTx) &&
    (!search || `${toHex(frame.bytes)} ${frame.problem || ''}`.toLowerCase().includes(search.toLowerCase()))).slice(-500);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ config, rule }));
  }, [config, rule]);

  useEffect(() => {
    void localSerialListPorts().then(found => {
      setPorts(found);
      setConfig(current => current.path ? current : { ...current, path: found[0]?.path || '' });
    }).catch(error => setError(errorText(error)));
    return () => {
      generationRef.current++;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (sessionRef.current !== null) void localSerialClose(sessionRef.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (ruleError) return;
    const decoder = new FrameDecoder(rule);
    const rebuilt = chunksRef.current.flatMap(chunk => decoder.push(chunk));
    decoderRef.current = decoder;
    framesRef.current = rebuilt.slice(-MAX_VIEW_FRAMES);
    setFrames(framesRef.current);
    setSelectedFrameId(null);
  }, [rule, ruleError]);

  useEffect(() => { pausedRef.current = paused; if (!paused) refresh(); }, [paused]);
  useEffect(() => {
    if (rule.mode !== 'gap' || ruleError) return;
    const timer = setInterval(() => {
      for (const direction of ['rx', 'tx'] as const) {
        if (lastArrivalRef.current[direction] && Date.now() - lastArrivalRef.current[direction] >= rule.gapMs) {
          const completed = decoderRef.current.flushGap(direction);
          if (completed.length) {
            framesRef.current.push(...completed);
            if (framesRef.current.length > MAX_VIEW_FRAMES) framesRef.current.splice(0, framesRef.current.length - MAX_VIEW_FRAMES);
            scheduleRefresh();
          }
        }
      }
    }, Math.min(100, Math.max(10, rule.gapMs)));
    return () => clearInterval(timer);
  }, [rule.mode, rule.gapMs, ruleError]);
  useEffect(() => { if (tab === 'raw' && !paused) rawEndRef.current?.scrollIntoView({ block: 'end' }); }, [chunks, tab, paused]);
  useEffect(() => {
    if (!repeating || !connected || !sendText.trim() || !Number.isFinite(repeatMs) || repeatMs < 50) return;
    const timer = setInterval(() => { void send(); }, repeatMs);
    return () => clearInterval(timer);
  }, [repeating, connected, repeatMs, sendText, sendMode, lineEnding, sessionId]);

  function refresh() {
    setChunks([...chunksRef.current]);
    setFrames([...framesRef.current]);
    setRxBytes(rxRef.current);
    setTxBytes(txRef.current);
    setViewDropped(droppedRef.current);
  }

  function scheduleRefresh() {
    if (pausedRef.current || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refresh(); }, 80);
  }

  function clearData() {
    chunksRef.current = [];
    framesRef.current = [];
    byteWindowRef.current = 0;
    droppedRef.current = 0;
    rxRef.current = 0;
    txRef.current = 0;
    decoderRef.current = new FrameDecoder(ruleError ? DEFAULT_FRAMING_RULE : rule);
    setSelectedFrameId(null);
    refresh();
  }

  function receiveChunk(event: Extract<LocalSerialEvent, { kind: 'data' }>) {
    const chunk: SerialChunk = { direction: event.direction, timeMs: event.timeMs, elapsedUs: event.elapsedUs, bytes: event.bytes };
    lastArrivalRef.current[chunk.direction] = Date.now();
    chunksRef.current.push(chunk);
    byteWindowRef.current += chunk.bytes.length;
    if (chunk.direction === 'rx') rxRef.current += chunk.bytes.length; else txRef.current += chunk.bytes.length;
    while (chunksRef.current.length > MAX_VIEW_CHUNKS || byteWindowRef.current > MAX_VIEW_BYTES) {
      const removed = chunksRef.current.shift();
      if (!removed) break;
      byteWindowRef.current -= removed.bytes.length;
      droppedRef.current += removed.bytes.length;
    }
    framesRef.current.push(...decoderRef.current.push(chunk));
    if (framesRef.current.length > MAX_VIEW_FRAMES) framesRef.current.splice(0, framesRef.current.length - MAX_VIEW_FRAMES);
    scheduleRefresh();
  }

  function handleEvent(event: LocalSerialEvent, generation: number) {
    if (generation !== generationRef.current) return;
    if (event.kind === 'data') { receiveChunk(event); return; }
    if (event.kind === 'replayDone') {
      framesRef.current.push(...decoderRef.current.flush());
      setNotice(`记录回放完成，共 ${event.records} 条数据`);
      refresh();
      return;
    }
    if (event.error) setError(event.error);
    setConnected(event.connected);
    setRecording(event.recording);
    if (!event.connected) {
      setRepeating(false);
      sessionRef.current = null;
      setSessionId(null);
      framesRef.current.push(...decoderRef.current.flush());
      refresh();
    }
  }

  async function refreshPorts() {
    try { setPorts(await localSerialListPorts()); setError(''); } catch (error) { setError(errorText(error)); }
  }

  async function disconnect() {
    const id = sessionRef.current;
    generationRef.current++;
    sessionRef.current = null;
    setSessionId(null);
    setConnected(false);
    setRecording(false);
    setRepeating(false);
    if (id !== null) await localSerialClose(id).catch(error => setError(errorText(error)));
    framesRef.current.push(...decoderRef.current.flush());
    refresh();
  }

  async function toggleConnection() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (sessionRef.current !== null) { await disconnect(); return; }
      if (!config.path.trim()) throw new Error('请选择本机串口，或输入设备路径');
      const generation = ++generationRef.current;
      const pending: LocalSerialEvent[] = [];
      let ready = false;
      const info = await localSerialOpen({ ...config, path: config.path.trim() }, event => {
        if (ready) handleEvent(event, generation); else pending.push(event);
      });
      if (generation !== generationRef.current) { await localSerialClose(info.sessionId); return; }
      clearData();
      setPaused(false);
      sessionRef.current = info.sessionId;
      setSessionId(info.sessionId);
      setConnected(true);
      setDtr(null);
      setRts(null);
      setOfflinePath('');
      setNotice(`已连接 ${info.path}`);
      ready = true;
      pending.forEach(event => handleEvent(event, generation));
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }

  async function toggleRecording() {
    if (sessionId === null) return;
    setError('');
    try {
      if (recording) {
        await localSerialRecordStop(sessionId);
        setRecording(false);
        setNotice(`记录已保存：${recordPath}`);
      } else {
        const path = await localSerialPickCapture(true);
        if (!path) return;
        await localSerialRecordStart(sessionId, path);
        setRecordPath(path);
        setRecording(true);
        setNotice(`记录中：${path}`);
      }
    } catch (error) { setError(errorText(error)); }
  }

  async function openRecording() {
    if (busy) return;
    setBusy(true);
    try {
      const path = await localSerialPickCapture(false);
      if (!path) return;
      if (sessionRef.current !== null) await disconnect();
      clearData();
      setPaused(false);
      setOfflinePath(path);
      setNotice(`正在读取记录：${path}`);
      const generation = ++generationRef.current;
      await localSerialReplay(path, event => handleEvent(event, generation));
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  async function replayAgain() {
    if (!offlinePath || busy) return;
    if (ruleError) { setError(ruleError); return; }
    setBusy(true);
    clearData();
    setNotice(`正在重新分析：${offlinePath}`);
    const generation = ++generationRef.current;
    try { await localSerialReplay(offlinePath, event => handleEvent(event, generation)); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  async function send() {
    if (sessionId === null || !connected || sendingRef.current) return;
    sendingRef.current = true;
    try {
      let bytes = sendMode === 'hex' ? parseHex(sendText) : Array.from(new TextEncoder().encode(sendText));
      if (sendMode === 'text') {
        const suffix = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : lineEnding === 'lf' ? '\n' : '';
        bytes = [...bytes, ...new TextEncoder().encode(suffix)];
      }
      await localSerialWrite(sessionId, bytes);
      const command = { text: sendText, mode: sendMode, lineEnding };
      setSendHistory(previous => [command, ...previous.filter(value => value.text !== command.text || value.mode !== command.mode || value.lineEnding !== command.lineEnding)].slice(0, 20));
      setError('');
    } catch (error) { setError(errorText(error)); setRepeating(false); }
    finally { sendingRef.current = false; }
  }

  function saveCommand() {
    if (!sendText.trim()) return;
    const command = { text: sendText, mode: sendMode, lineEnding };
    if (savedCommands.some(value => value.text === command.text && value.mode === command.mode && value.lineEnding === command.lineEnding)) return;
    const updated = [...savedCommands, command].slice(-30);
    setSavedCommands(updated);
    localStorage.setItem(COMMANDS_KEY, JSON.stringify(updated));
    setNotice('已保存常用报文');
  }

  function chooseCommand(value: string) {
    const [source, indexText] = value.split(':');
    const command = (source === 'saved' ? savedCommands : sendHistory)[Number(indexText)];
    if (!command) return;
    setSendText(command.text);
    setSendMode(command.mode);
    setLineEnding(command.lineEnding);
  }

  async function exportData(kind: 'binary' | 'csv' | 'json') {
    try {
      let bytes: number[];
      if (kind === 'binary') {
        bytes = chunksRef.current.filter(chunk => chunk.direction === 'rx' ? showRx : showTx).flatMap(chunk => chunk.bytes);
      } else {
        const rows = framesRef.current.filter(frame => frame.direction === 'rx' ? showRx : showTx)
          .map(frame => ({ frame: frame.id, timeMs: frame.timeMs, direction: frame.direction,
            hex: toHex(frame.bytes), valid: frame.valid, problem: frame.problem || '',
            fields: Object.fromEntries(rule.fields.map(field => [field.name, decodeField(frame, field)])) }));
        const content = kind === 'json' ? JSON.stringify(rows, null, 2) : [
          ['frame', 'timeMs', 'direction', 'hex', 'valid', 'problem', ...rule.fields.map(field => field.name)].map(csvCell).join(','),
          ...rows.map(row => [row.frame, row.timeMs, row.direction, row.hex, row.valid ?? '', row.problem,
            ...rule.fields.map(field => row.fields[field.name])].map(csvCell).join(',')),
        ].join('\n');
        bytes = Array.from(new TextEncoder().encode(content));
      }
      if (!bytes.length) throw new Error('当前窗口没有可导出的数据');
      const path = await localSerialExport(kind, bytes);
      if (path) setNotice(`已导出：${path}${kind === 'binary' ? '。BIN 不含时间与方向，完整记录请使用 .serialcap' : ''}`);
      setError('');
    } catch (error) { setError(errorText(error)); }
  }

  async function changeLine(which: 'dtr' | 'rts', value: boolean) {
    if (sessionId === null) return;
    try {
      if (which === 'dtr') { await localSerialSetDtr(sessionId, value); setDtr(value); }
      else { await localSerialSetRts(sessionId, value); setRts(value); }
    } catch (error) { setError(errorText(error)); }
  }

  function saveProfile() {
    if (ruleError) { setError(ruleError); return; }
    const name = window.prompt('给这套拆帧规则命名：');
    if (!name?.trim()) return;
    const updated = { ...profiles, [name.trim()]: rule };
    setProfiles(updated);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(updated));
    setNotice(`已保存规则：${name.trim()}`);
  }

  function updateRule(change: Partial<FramingRule>) { setRule(previous => ({ ...previous, ...change })); }
  function updateField(index: number, change: Partial<SerialField>) {
    setRule(previous => ({ ...previous, fields: previous.fields.map((field, at) => at === index ? { ...field, ...change } : field) }));
  }

  const frameStatus = selectedFrame?.problem || (selectedFrame?.valid === true ? '校验正确' : selectedFrame?.valid === false ? '校验错误' : '未配置校验');

  return <div className="serial-assistant-overlay" role="dialog" aria-label="串口助手">
    <section className="serial-assistant">
      <header className="serial-assistant-head">
        <div><strong>⌁ 串口助手</strong><small>电脑本机串口 · 原始数据与协议分析</small></div>
        <button onClick={onClose} aria-label="关闭串口助手">×</button>
      </header>
      <div className="serial-assistant-connect">
        <label className="serial-assistant-port">本机串口（{ports.length}）
          <select aria-label="选择本机串口" value={ports.some(port => port.path === config.path) ? config.path : ''}
            onChange={event => setConfig({ ...config, path: event.target.value })} disabled={connected}>
            <option value="">手动输入路径</option>
            {ports.map(port => <option key={port.path} value={port.path}>{port.label}</option>)}
          </select>
        </label>
        <label className="serial-assistant-port-path">设备路径<input value={config.path} onChange={event => setConfig({ ...config, path: event.target.value })} disabled={connected} placeholder="例如 /dev/ttyACM0" /></label>
        <button onClick={() => void refreshPorts()} disabled={busy}>刷新</button>
        <label>波特率<input type="number" min="300" max="4000000" value={config.baudRate} disabled={connected} onChange={event => setConfig({ ...config, baudRate: Number(event.target.value) })} /></label>
        <label>数据位<select value={config.dataBits} disabled={connected} onChange={event => setConfig({ ...config, dataBits: Number(event.target.value) })}>{[5, 6, 7, 8].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>校验<select value={config.parity} disabled={connected} onChange={event => setConfig({ ...config, parity: event.target.value as LocalSerialConfig['parity'] })}><option value="none">无</option><option value="even">偶</option><option value="odd">奇</option></select></label>
        <label>停止位<select value={config.stopBits} disabled={connected} onChange={event => setConfig({ ...config, stopBits: Number(event.target.value) })}><option>1</option><option>2</option></select></label>
        <label>流控<select value={config.flowControl} disabled={connected} onChange={event => setConfig({ ...config, flowControl: event.target.value as LocalSerialConfig['flowControl'] })}><option value="none">无</option><option value="software">XON/XOFF</option><option value="hardware">RTS/CTS</option></select></label>
        <button className="serial-assistant-primary" disabled={busy} onClick={() => void toggleConnection()}>{busy ? '处理中…' : connected ? '断开' : '连接'}</button>
      </div>
      <div className="serial-assistant-workspace">
        <div className="serial-assistant-data">
          <div className="serial-assistant-data-head">
            <div className="serial-assistant-tabs" role="tablist" aria-label="数据视图"><button role="tab" aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>原始数据</button><button role="tab" aria-selected={tab === 'frames'} onClick={() => setTab('frames')}>帧分析 <span>{frames.length}</span></button></div>
            <div className="serial-assistant-data-actions"><button onClick={() => setPaused(value => !value)}>{paused ? '继续显示' : '暂停显示'}</button><button onClick={() => void toggleRecording()} disabled={!connected || busy}>{recording ? '● 停止记录' : '● 开始记录'}</button><button onClick={() => void openRecording()} disabled={busy}>打开记录</button><button onClick={clearData}>清屏</button></div>
          </div>
          <div className="serial-assistant-filter"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="查找 HEX 或文本" aria-label="查找数据" /><label><input type="checkbox" checked={showRx} onChange={event => setShowRx(event.target.checked)} />接收 RX</label><label><input type="checkbox" checked={showTx} onChange={event => setShowTx(event.target.checked)} />发送 TX</label><span></span><select aria-label="导出当前窗口数据" value="" onChange={event => { const kind = event.target.value as 'binary' | 'csv' | 'json'; if (kind) void exportData(kind); }}><option value="">导出当前窗口…</option><option value="binary">原始 BIN</option><option value="csv">帧列表 CSV</option><option value="json">帧列表 JSON</option></select></div>
          {viewDropped > 0 && <p className="serial-assistant-limited">当前窗口已移出 {formatBytes(viewDropped)} 较早数据；已开启的记录文件仍保存完整字节。</p>}
          <div className="serial-assistant-scroll">
            {tab === 'raw' ? <div role="tabpanel"><div className="serial-assistant-raw-grid serial-assistant-grid-head"><span>时间</span><span>方向</span><span>长度</span><span>HEX</span><span>ASCII</span></div>
              {filteredChunks.map((chunk, index) => <div className="serial-assistant-raw-grid serial-assistant-row" key={`${chunk.elapsedUs}-${chunk.direction}-${index}`}><span>{formatTime(chunk.timeMs)}</span><span className={chunk.direction === 'rx' ? 'serial-assistant-rx' : 'serial-assistant-tx'}>{chunk.direction === 'rx' ? '↓ RX' : '↑ TX'}</span><span>{chunk.bytes.length}</span><code>{toHex(chunk.bytes)}</code><code>{toAscii(chunk.bytes)}</code></div>)}
              {!filteredChunks.length && <div className="serial-assistant-empty">连接电脑串口，或打开本地记录文件后在这里查看原始字节。</div>}<div ref={rawEndRef} /></div>
              : <div role="tabpanel"><div className="serial-assistant-frame-grid serial-assistant-grid-head"><span>帧号</span><span>时间</span><span>方向</span><span>间隔</span><span>长度</span><span>校验</span><span>HEX</span></div>
                {filteredFrames.map((frame, index) => <button className={`serial-assistant-frame-grid serial-assistant-frame-row ${selectedFrame?.id === frame.id ? 'selected' : ''}`} key={frame.id} onClick={() => setSelectedFrameId(frame.id)}><span>#{frame.id}</span><span>{formatTime(frame.timeMs)}</span><span className={frame.direction === 'rx' ? 'serial-assistant-rx' : 'serial-assistant-tx'}>{frame.direction === 'rx' ? '↓ RX' : '↑ TX'}</span><span>{index ? `${((frame.elapsedUs - filteredFrames[index - 1].elapsedUs) / 1000).toFixed(1)} ms` : '—'}</span><span>{frame.bytes.length} B</span><span className={frame.problem || frame.valid === false ? 'serial-assistant-bad' : 'serial-assistant-ok'}>{frame.problem ? '异常' : frame.valid === null ? '—' : frame.valid ? '正确' : '错误'}</span><code>{toHex(frame.bytes)}</code></button>)}
                {!filteredFrames.length && <div className="serial-assistant-empty">选择拆帧规则后，收到的字节会在这里组成协议帧。</div>}</div>}
          </div>
        </div>
        <aside className="serial-assistant-analysis">
          <div className="serial-assistant-side-title"><strong>拆帧规则</strong><button onClick={saveProfile}>保存配置</button></div>
          <select aria-label="已保存的拆帧规则" defaultValue="" onChange={event => { const saved = profiles[event.target.value]; if (saved) setRule(saved); }}><option value="">自定义规则</option>{Object.keys(profiles).map(name => <option key={name}>{name}</option>)}</select>
          <label>拆帧方式<select value={rule.mode} onChange={event => updateRule({ mode: event.target.value as FramingMode })}><option value="gap">空闲间隔</option><option value="fixed">固定帧长</option><option value="headerLength">帧头 + 长度字段</option><option value="headerFooter">帧头 + 帧尾</option><option value="delimiter">结束符</option></select></label>
          {['headerLength', 'headerFooter'].includes(rule.mode) && <label>帧头 HEX<input value={rule.header} onChange={event => updateRule({ header: event.target.value })} /></label>}
          {rule.mode === 'headerFooter' && <label>帧尾 HEX<input value={rule.footer} onChange={event => updateRule({ footer: event.target.value })} /></label>}
          {rule.mode === 'delimiter' && <label>结束符 HEX<input value={rule.delimiter} onChange={event => updateRule({ delimiter: event.target.value })} /></label>}
          {rule.mode === 'fixed' && <label>固定帧长<input type="number" value={rule.fixedLength} onChange={event => updateRule({ fixedLength: Number(event.target.value) })} /></label>}
          {rule.mode === 'gap' && <label>间隔阈值 ms<input type="number" min="0.1" step="0.1" value={rule.gapMs} onChange={event => updateRule({ gapMs: Number(event.target.value) })} /></label>}
          {rule.mode === 'headerLength' && <><div className="serial-assistant-rule-pair"><label>长度偏移<input type="number" min="0" value={rule.lengthOffset} onChange={event => updateRule({ lengthOffset: Number(event.target.value) })} /></label><label>长度字节<select value={rule.lengthWidth} onChange={event => updateRule({ lengthWidth: Number(event.target.value) as 1 | 2 | 4 })}><option>1</option><option>2</option><option>4</option></select></label></div><div className="serial-assistant-rule-pair"><label>字节序<select value={rule.lengthEndian} onChange={event => updateRule({ lengthEndian: event.target.value as 'little' | 'big' })}><option value="little">小端</option><option value="big">大端</option></select></label><label>长度含义<select value={rule.lengthMeaning} onChange={event => updateRule({ lengthMeaning: event.target.value as 'payload' | 'total' })}><option value="payload">后续数据</option><option value="total">整帧</option></select></label></div></>}
          <div className="serial-assistant-rule-pair"><label>最大帧长<input type="number" min="2" max="65536" value={rule.maxLength} onChange={event => updateRule({ maxLength: Number(event.target.value) })} /></label><label>校验<select value={rule.checksum} onChange={event => updateRule({ checksum: event.target.value as FramingRule['checksum'] })}><option value="none">无</option><option value="sum8">SUM8</option><option value="xor8">XOR8</option><option value="crc16Modbus">CRC16 Modbus</option></select></label></div>
          {rule.checksum !== 'none' && <label>校验起始字节偏移<input type="number" min="0" value={rule.checksumStart} onChange={event => updateRule({ checksumStart: Number(event.target.value) })} /></label>}
          {ruleError && <span className="serial-assistant-bad" role="alert">{ruleError}</span>}
          {offlinePath && <button disabled={busy || !!ruleError} onClick={() => void replayAgain()}>按当前规则重新分析记录</button>}
          <div className="serial-assistant-divider" />
          <div className="serial-assistant-side-title"><strong>{selectedFrame ? `帧 #${selectedFrame.id}` : '字段解析'}</strong><span className={selectedFrame?.valid === false || selectedFrame?.problem ? 'serial-assistant-bad' : 'serial-assistant-ok'}>{selectedFrame ? frameStatus : '选择一帧'}</span></div>
          {selectedFrame && <><div className="serial-assistant-byte-strip">{selectedFrame.bytes.slice(0, 80).map((byte, index) => <span key={index} title={`偏移 ${index}`}>{byte.toString(16).padStart(2, '0').toUpperCase()}</span>)}{selectedFrame.bytes.length > 80 && <span>…</span>}</div>{selectedFrame.problem && <span className="serial-assistant-bad">{selectedFrame.problem}</span>}</>}
          <div className="serial-assistant-side-title"><strong>字段定义</strong><button onClick={() => updateRule({ fields: [...rule.fields, { name: '新字段', offset: 0, length: 1, type: 'u8', endian: 'little', scale: 1 }] })}>＋ 添加</button></div>
          {rule.fields.map((field, index) => <div className="serial-assistant-field-editor" key={index}><div><input aria-label="字段名" value={field.name} onChange={event => updateField(index, { name: event.target.value })} /><button aria-label={`删除字段 ${field.name}`} onClick={() => updateRule({ fields: rule.fields.filter((_, at) => at !== index) })}>×</button></div><div><label>偏移<input type="number" min="0" value={field.offset} onChange={event => updateField(index, { offset: Number(event.target.value) })} /></label><label>长度<input type="number" min="1" value={field.length} onChange={event => updateField(index, { length: Number(event.target.value) })} /></label></div><div><select aria-label="字段类型" value={field.type} onChange={event => updateField(index, { type: event.target.value as SerialField['type'] })}>{['u8','s8','u16','s16','u32','s32','f32','f64','ascii','hex'].map(type => <option key={type}>{type}</option>)}</select><select aria-label="字段字节序" value={field.endian} onChange={event => updateField(index, { endian: event.target.value as SerialField['endian'] })}><option value="little">小端</option><option value="big">大端</option></select><input type="number" step="any" aria-label="比例系数" value={field.scale} onChange={event => updateField(index, { scale: Number(event.target.value) })} /></div>{selectedFrame && <output>{field.name}：{decodeField(selectedFrame, field)}</output>}</div>)}
        </aside>
      </div>
      <div className="serial-assistant-send">
        <div className="serial-assistant-send-options">
          <strong>发送</strong><span>电脑本机串口</span>
          <select aria-label="历史与常用报文" value="" onChange={event => chooseCommand(event.target.value)}>
            <option value="">历史与常用报文</option>
            {savedCommands.length > 0 && <optgroup label="常用报文">{savedCommands.map((value, index) => <option key={`saved-${index}`} value={`saved:${index}`}>{value.mode.toUpperCase()} · {value.text}</option>)}</optgroup>}
            {sendHistory.length > 0 && <optgroup label="本次发送">{sendHistory.map((value, index) => <option key={`history-${index}`} value={`history:${index}`}>{value.mode.toUpperCase()} · {value.text}</option>)}</optgroup>}
          </select>
          <button onClick={saveCommand} disabled={!sendText.trim()}>保存报文</button>
          <label>DTR<select aria-label="DTR 电平" value={dtr === null ? 'keep' : dtr ? 'high' : 'low'} disabled={!connected} onChange={event => void changeLine('dtr', event.target.value === 'high')}><option value="keep" disabled={dtr !== null}>未设置</option><option value="low">低</option><option value="high">高</option></select></label>
          <label>RTS<select aria-label="RTS 电平" value={rts === null ? 'keep' : rts ? 'high' : 'low'} disabled={!connected} onChange={event => void changeLine('rts', event.target.value === 'high')}><option value="keep" disabled={rts !== null}>未设置</option><option value="low">低</option><option value="high">高</option></select></label>
        </div>
        <div className="serial-assistant-send-input">
          <select value={sendMode} onChange={event => setSendMode(event.target.value as 'hex' | 'text')} aria-label="发送格式"><option value="hex">HEX</option><option value="text">文本</option></select>
          <input value={sendText} onChange={event => setSendText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void send(); } }} placeholder={sendMode === 'hex' ? '例如 AA 55 01 00' : '输入要发送的文本'} aria-label="发送内容" />
          <select value={lineEnding} disabled={sendMode === 'hex'} onChange={event => setLineEnding(event.target.value as typeof lineEnding)} aria-label="换行方式"><option value="none">不追加换行</option><option value="lf">LF</option><option value="cr">CR</option><option value="crlf">CRLF</option></select>
          <button className="serial-assistant-primary" disabled={!connected || !sendText.trim()} onClick={() => void send()}>发送 ↵</button>
          <label>间隔 ms<input type="number" min="50" step="50" value={repeatMs} onChange={event => setRepeatMs(Number(event.target.value))} /></label>
          <button disabled={!connected || !sendText.trim() || repeatMs < 50} onClick={() => setRepeating(value => !value)}>{repeating ? '停止定时' : '定时发送'}</button>
        </div>
      </div>
      <footer className="serial-assistant-status"><span>{connected ? `● 已连接 · ${config.path} · ${config.baudRate} ${config.dataBits}${config.parity === 'none' ? 'N' : config.parity === 'even' ? 'E' : 'O'}${config.stopBits}` : offlinePath ? `○ 离线记录 · ${offlinePath.split('/').pop()}` : '○ 未连接 · 仅访问电脑本机串口'}</span><span>RX {formatBytes(rxBytes)}　TX {formatBytes(txBytes)}　{recording ? '● 记录中' : '记录未开始'}</span></footer>
      {(error || notice) && <div className={`serial-assistant-message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}<button onClick={() => { setError(''); setNotice(''); }} aria-label="关闭提示">×</button></div>}
    </section>
  </div>;
}
