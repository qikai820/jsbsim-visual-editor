import { useEffect, useMemo, useRef, useState } from 'react';
import { ftpDeleteLog, ftpDownloadLog, ftpListLogs, type RemoteLogFile } from '../utils/tauriApi';
import { parseMcap, type McapAnalysis } from '../utils/mcapParser';

interface LocalLog {
  name: string;
  size: number;
  validMcap: boolean;
  modified: number;
  file: File;
  analysis?: McapAnalysis;
  error?: string;
}

interface LogFieldNode { name: string; path: string; field?: string; children: Map<string, LogFieldNode>; }
function buildLogFieldTree(fields: McapAnalysis['fields'], filter: string): LogFieldNode {
  const root: LogFieldNode = { name: 'root', path: '', children: new Map() };
  const query = filter.trim().toLowerCase();
  for (const field of Object.keys(fields)) {
    if (query && !field.toLowerCase().includes(query)) continue;
    const parts = field.split('/').filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]; const path = current.path ? `${current.path}/${name}` : name;
      if (!current.children.has(name)) current.children.set(name, { name, path, children: new Map() });
      current = current.children.get(name)!;
    }
    current.field = field;
  }
  return root;
}
function LogFieldNodeView({ node, depth, analysis, selectedFields, onToggle }: { node: LogFieldNode; depth: number; analysis: McapAnalysis; selectedFields: string[]; onToggle: (field: string, checked: boolean) => void }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
  const points = node.field ? analysis.fields[node.field] : undefined;
  return <div className="log-property-node"><div className="log-property-row" style={{ paddingLeft: depth * 16 + 3 }}>
    {children.length > 0 ? <button className="log-property-toggle" onClick={() => setExpanded(value => !value)}>{expanded ? '▼' : '▶'}</button> : <span className="log-property-spacer" />}
    {node.field ? <input type="checkbox" checked={selectedFields.includes(node.field)} onChange={event => onToggle(node.field!, event.target.checked)} /> : null}
    <span className="log-property-name">{node.name}</span>
    {points && <small>{points.at(-1)?.value.toPrecision(6)}</small>}
  </div>{expanded && children.map(child => <LogFieldNodeView key={child.path} node={child} depth={depth + 1} analysis={analysis} selectedFields={selectedFields} onToggle={onToggle} />)}</div>;
}

export default function LogCenter({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'local' | 'remote'>('remote');
  const [localLogs, setLocalLogs] = useState<LocalLog[]>([]);
  const [remoteLogs, setRemoteLogs] = useState<RemoteLogFile[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('正在读取仿真机日志…');
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldFilter, setFieldFilter] = useState('');
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

  const refreshRemote = async () => {
    setStatus('正在读取仿真机日志…');
    try {
      const files = await ftpListLogs();
      setRemoteLogs(files);
      setStatus(files.length ? `仿真机上有 ${files.length} 个 MCAP 日志` : '仿真机上没有 MCAP 日志');
    } catch (error: any) {
      setStatus(`读取失败：${error?.message || error}`);
    }
  };

  useEffect(() => { void refreshRemote(); }, []);

  const openFileArray = async (files: File[]) => {
    if (!files.length) return;
    const parsed = await Promise.all(files.map(async file => {
      const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const expected = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
      return { name: file.name, size: file.size, modified: file.lastModified, file, validMcap: expected.every((value, i) => magic[i] === value) };
    }));
    setLocalLogs(parsed);
    setTab('local');
    setSelected(parsed[0]?.name || '');
    setStatus(parsed.length ? `已打开 ${parsed.length} 个本地日志` : '未选择日志');
  };
  const openFiles = async (files: FileList | null) => openFileArray(files ? [...files] : []);

  const items = tab === 'remote' ? remoteLogs.map(log => log.name) : localLogs.map(log => log.name);
  const remote = useMemo(() => remoteLogs.find(log => log.name === selected), [remoteLogs, selected]);
  const local = useMemo(() => localLogs.find(log => log.name === selected), [localLogs, selected]);
  const analysis = local?.analysis;
  const formatSize = (size?: number | null) => size === undefined || size === null ? '大小读取中…' : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
  const formatRemoteDate = (value?: string | null) => {
    if (!value) return '日期未知';
    const date = value.startsWith('epoch:')
      ? new Date(Number(value.slice(6)) * 1000)
      : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  };
  const groupedItems = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const name of items) {
      let day = tab === 'remote' && /^\d{4}-\d{2}-\d{2}\//.test(name) ? name.slice(0, 10) : '';
      if (!day) {
        const entry = tab === 'remote' ? remoteLogs.find(log => log.name === name) : localLogs.find(log => log.name === name);
        const value = tab === 'remote' ? (entry as RemoteLogFile | undefined)?.modified : (entry as LocalLog | undefined)?.modified;
        const date = typeof value === 'number' ? new Date(value) : value?.startsWith('epoch:') ? new Date(Number(value.slice(6)) * 1000) : value ? new Date(value) : null;
        day = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('en-CA') : '日期未知';
      }
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(name);
    }
    return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left));
  }, [items, localLogs, remoteLogs, tab]);
  const toggleDay = (day: string) => setExpandedDays(current => {
    const next = new Set(current);
    if (next.has(day)) next.delete(day); else next.add(day);
    return next;
  });

  const analyseLocal = async (name: string) => {
    const entry = localLogs.find(log => log.name === name); if (!entry || entry.analysis || entry.error) return;
    setBusy(true); setStatus(`正在解析 ${name}…`);
    try {
      const result = await parseMcap(entry.file);
      setLocalLogs(current => current.map(log => log.name === name ? { ...log, analysis: result } : log));
      const initialFields = Object.keys(result.fields).slice(0, 3);
      setSelectedFields(initialFields);
      setStatus(`解析完成：${result.messageCount.toLocaleString()} 条消息`);
    } catch (error: any) {
      const message = error?.message || String(error);
      setLocalLogs(current => current.map(log => log.name === name ? { ...log, error: message } : log));
      setStatus(`解析失败：${message}`);
    } finally { setBusy(false); }
  };

  useEffect(() => { if (tab === 'local' && selected) void analyseLocal(selected); }, [tab, selected]);

  const downloadRemote = async (name = selected) => {
    if (!name || tab !== 'remote' || busy) return; setBusy(true); setSelected(name); setStatus(`正在下载 ${name}…`);
    try {
      const result = await ftpDownloadLog(name, localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs');
      if (result.bytes) {
        const file = new File([new Uint8Array(result.bytes)], result.file.split('/').pop() || result.file, { type: 'application/octet-stream', lastModified: Date.now() });
        await openFileArray([file]);
        setStatus(`下载并自动打开：${result.path}`);
      } else {
        setStatus(`下载完成：${result.path}（文件超过 64 MiB，请从本地日志手动打开）`);
      }
    }
    catch (error: any) { setStatus(`下载失败：${error?.message || error}`); }
    finally { setBusy(false); }
  };
  const deleteRemote = async () => {
    if (!selected || tab !== 'remote' || !window.confirm(`确定删除仿真机日志 ${selected}？此操作不可恢复。`)) return;
    setBusy(true);
    try { const removed = selected; await ftpDeleteLog(removed); setSelected(''); await refreshRemote(); setStatus(`已删除 ${removed}`); }
    catch (error: any) { setStatus(`删除失败：${error?.message || error}`); }
    finally { setBusy(false); }
  };
  const colors = ['#0ea5a4', '#f59e0b', '#8b5cf6', '#ef476f'];
  const exportCsv = () => {
    if (!analysis || !selectedFields.length) return;
    const length = Math.max(...selectedFields.map(field => analysis.fields[field]?.length || 0));
    const rows = [`time_s,${selectedFields.join(',')}`];
    for (let i = 0; i < length; i++) {
      const time = selectedFields.map(field => analysis.fields[field]?.[i]?.time).find(value => value !== undefined) ?? '';
      rows.push([time, ...selectedFields.map(field => analysis.fields[field]?.[i]?.value ?? '')].join(','));
    }
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${selected.replace(/\.mcap$/i, '')}_signals.csv`; anchor.click(); URL.revokeObjectURL(url);
  };
  const chartPaths = useMemo(() => selectedFields.map((field, index) => {
    const points = analysis?.fields[field] || []; if (points.length < 2) return { field, color: colors[index], d: '' };
    let min = Infinity, max = -Infinity; for (const point of points) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
    const span = max - min || 1; const start = analysis?.startTime || points[0].time; const duration = (analysis?.endTime || points.at(-1)!.time) - start || 1;
    const d = points.map((point, i) => `${i ? 'L' : 'M'}${((point.time - start) / duration) * 1000},${190 - ((point.value - min) / span) * 170}`).join(' ');
    return { field, color: colors[index], d };
  }), [analysis, selectedFields]);
  const fieldTree = useMemo(() => analysis ? buildLogFieldTree(analysis.fields, fieldFilter) : null, [analysis, fieldFilter]);
  const toggleField = (field: string, checked: boolean) => setSelectedFields(current => checked ? [...current.filter(value => value !== field), field].slice(-4) : current.filter(value => value !== field));

  return <div className="log-center">
    <header className="log-center-head">
      <div><span className="log-center-mark">▥</span><strong>日志中心</strong><small>MCAP 分析与仿真机日志管理</small></div>
      <div className="log-center-actions">
        <button onClick={() => inputRef.current?.click()}>＋ 打开本地 MCAP</button>
        <button onClick={() => void refreshRemote()} disabled={busy}>↻ 刷新仿真机</button>
        {tab === 'remote' && selected && <button onClick={() => void downloadRemote()} disabled={busy}>↓ 下载</button>}
        {tab === 'remote' && selected && <button className="danger" onClick={() => void deleteRemote()} disabled={busy}>删除</button>}
        <button className="log-center-close" onClick={onClose}>×</button>
      </div>
      <input ref={inputRef} hidden type="file" accept=".mcap,application/octet-stream" multiple onChange={event => void openFiles(event.target.files)} />
    </header>
    <div className="log-center-tabs">
      <button className={tab === 'remote' ? 'active' : ''} onClick={() => setTab('remote')}>🛰 仿真机日志 <b>{remoteLogs.length}</b></button>
      <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>💻 本地日志 <b>{localLogs.length}</b></button>
      <span>{status}</span>
    </div>
    <main className="log-center-body">
      <aside className="log-file-panel">
        <div className="log-panel-title">日志文件</div>
        {items.length === 0 ? <div className="log-empty">暂无日志</div> : groupedItems.map(([day, names]) => <div className="log-day-group" key={day}>
          <button className="log-day-title" onClick={() => toggleDay(day)} aria-expanded={expandedDays.has(day)} title={expandedDays.has(day) ? '折叠该日期' : '展开该日期'}><span className="log-day-arrow">{expandedDays.has(day) ? '▼' : '▶'}</span><span>{expandedDays.has(day) ? '📂' : '📁'}</span><strong>{day}</strong><small>{names.length}</small></button>
          {expandedDays.has(day) && names.map(name => <button key={name} className={selected === name ? 'selected' : ''} onClick={() => setSelected(name)} onDoubleClick={() => { if (tab === 'remote') void downloadRemote(name); }} title={tab === 'remote' ? '双击下载并打开' : '选择日志'}>
            <span>◫</span><div><strong>{name.split('/').pop()}</strong><small>{tab === 'remote' ? `${formatRemoteDate(remoteLogs.find(log => log.name === name)?.modified)} · ${formatSize(remoteLogs.find(log => log.name === name)?.size)}` : (localLogs.find(log => log.name === name) ? formatSize(localLogs.find(log => log.name === name)!.size) : '')}</small></div>
          </button>)}
        </div>)}
      </aside>
      <section className="log-plot-panel">
        <div className="log-plot-toolbar"><strong>时序图</strong>{chartPaths.map(item => <span key={item.field} style={{ color: item.color }}>● {item.field}</span>)}{analysis && selectedFields.length > 0 && <button onClick={exportCsv}>导出 CSV</button>}</div>
        {analysis && chartPaths.some(item => item.d) ? <div className="log-chart"><svg viewBox="0 0 1000 210" preserveAspectRatio="none"><g className="grid"><path d="M0 20H1000M0 62H1000M0 105H1000M0 147H1000M0 190H1000" /></g>{chartPaths.map(item => <path key={item.field} d={item.d} fill="none" stroke={item.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg></div> :
          <div className="log-plot-empty"><div className="log-wave">⌁⌁⌁</div><strong>{selected || '选择一个 MCAP 日志'}</strong><span>{busy ? '正在处理日志…' : tab === 'remote' && selected ? '下载后从本地打开，即可解析和绘图' : '从左侧选择日志，或打开本地 MCAP 文件'}</span></div>}
        <div className="log-timeline"><span>{analysis ? `${analysis.startTime.toFixed(3)} s` : '00:00.000'}</span><div><i /></div><span>{analysis ? `${analysis.endTime.toFixed(3)} s` : '结束'}</span></div>
      </section>
      <aside className="log-detail-panel">
        <div className="log-panel-title">日志信息</div>
        <dl>
          <dt>来源</dt><dd>{selected ? (tab === 'remote' ? 'NuttX 仿真机' : '本地文件') : '—'}</dd>
          <dt>格式</dt><dd>{selected ? 'MCAP' : '—'}</dd>
          <dt>文件</dt><dd>{selected || '—'}</dd>
          {remote && <><dt>日期</dt><dd>{formatRemoteDate(remote.modified)}</dd><dt>大小</dt><dd>{formatSize(remote.size)}</dd></>}
          {local && <><dt>大小</dt><dd>{formatSize(local.size)}</dd><dt>文件头</dt><dd className={local.validMcap ? 'ok' : 'bad'}>{local.validMcap ? '有效 MCAP' : '格式异常'}</dd></>}
          {analysis && <><dt>Profile</dt><dd>{analysis.profile}</dd><dt>消息数</dt><dd>{analysis.messageCount.toLocaleString()}</dd><dt>时长</dt><dd>{Math.max(0, analysis.endTime - analysis.startTime).toFixed(3)} s</dd></>}
        </dl>
        <div className="log-panel-title">Topic / Schema</div>
        {!analysis ? <div className="log-empty">{local?.error || '打开本地日志后显示数据树'}</div> : <div className="log-topic-tree"><div className="topic-name">▾ {analysis.topic}</div><div className="topic-tools"><input value={fieldFilter} onChange={event => setFieldFilter(event.target.value)} placeholder="搜索字段…"/><button onClick={() => setSelectedFields([])}>清空</button></div>{fieldTree && Array.from(fieldTree.children.values()).sort((a, b) => a.name.localeCompare(b.name)).map(node => <LogFieldNodeView key={node.path} node={node} depth={0} analysis={analysis} selectedFields={selectedFields} onToggle={toggleField} />)}</div>}
      </aside>
    </main>
  </div>;
}
