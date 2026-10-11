import { useEffect, useMemo, useState } from 'react';
import {
  ftpDeleteLog, ftpDownloadLog, ftpListLogs, listenLogDownloadProgress,
  openPlotJugglerLog, pickPlotJugglerLog,
  type LocalMcapLog, type RemoteLogFile,
} from '../utils/tauriApi';

const downloadDirectory = () => localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatSize = (size?: number | null) => size == null ? '大小未知' : size >= 1024 ** 2
  ? `${(size / 1024 ** 2).toFixed(1)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
const formatDate = (value?: string | number | null) => {
  if (value == null) return '日期未知';
  const date = typeof value === 'number' ? new Date(value)
    : value.startsWith('epoch:') ? new Date(Number(value.slice(6)) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};
type LogItem = { key: string; name: string; size?: number | null; modified?: string | number | null };

export default function LogCenter({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'remote' | 'local'>('remote');
  const [remoteLogs, setRemoteLogs] = useState<RemoteLogFile[]>([]);
  const [localLogs, setLocalLogs] = useState<LocalMcapLog[]>([]);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState('正在读取仿真机日志…');
  const [busy, setBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ name: string; bytes: number; retries: number } | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

  const refreshRemote = async () => {
    setStatus('正在读取仿真机日志…');
    try {
      const files = await ftpListLogs();
      setRemoteLogs(files);
      setStatus(files.length ? `仿真机上有 ${files.length} 个 MCAP 日志` : '仿真机上没有 MCAP 日志');
    } catch (error) { setStatus(`读取失败：${errorText(error)}`); }
  };
  useEffect(() => { void refreshRemote(); }, []);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listenLogDownloadProgress(progress => {
      setDownloadProgress(current => current?.name === progress.file
        ? { name: current.name, bytes: progress.bytes,
          retries: current.retries + (progress.bytes < current.bytes ? 1 : 0) } : current);
    }).then(stop => { if (active) unlisten = stop; else stop(); });
    return () => { active = false; unlisten?.(); };
  }, []);

  const rememberLocal = (log: LocalMcapLog) => {
    setLocalLogs(current => [log, ...current.filter(item => item.path !== log.path)]);
    setTab('local');
    setSelected(log.path);
  };
  const openLocal = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const log = await pickPlotJugglerLog();
      if (!log) return;
      rememberLocal(log);
      setStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
      await openPlotJugglerLog(log.path);
      setStatus(`已启动 PlotJuggler 加载 ${log.name}`);
    } catch (error) { setStatus(`打开失败：${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const downloadRemote = async (name: string, open: boolean) => {
    if (busy) return;
    setBusy(true); setSelected(name);
    setDownloadProgress({ name, bytes: 0, retries: 0 });
    setStatus(`正在下载 ${name}…`);
    try {
      const result = await ftpDownloadLog(name, downloadDirectory(), remoteLogs.find(log => log.name === name)?.size, open);
      const log: LocalMcapLog = { path: result.path, name: result.path.split('/').pop() || name,
        size: result.size, modified: Date.now() };
      setLocalLogs(current => [log, ...current.filter(item => item.path !== log.path)]);
      if (open) {
        setStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
        await openPlotJugglerLog(result.path);
        setStatus(`已启动 PlotJuggler 加载 ${log.name}`);
      } else setStatus(result.hasMcapMarkers ? `已下载到 ${result.path}` : `已下载原始文件到 ${result.path}；MCAP 文件头或文件尾无效，无法用 PlotJuggler 查看`);
    } catch (error) { setStatus(`${open ? '打开失败' : '下载失败'}：${errorText(error)}`); }
    finally { setDownloadProgress(null); setBusy(false); }
  };
  const viewLocal = async (path: string) => {
    if (busy) return;
    const log = localLogs.find(item => item.path === path);
    if (!log) return;
    setBusy(true); setStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
    try { await openPlotJugglerLog(log.path); setStatus(`已启动 PlotJuggler 加载 ${log.name}`); }
    catch (error) { setStatus(`打开失败：${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const viewSelected = async () => {
    if (!selected || busy) return;
    if (tab === 'remote') await downloadRemote(selected, true);
    else await viewLocal(selected);
  };
  const deleteRemote = async () => {
    if (!selected || tab !== 'remote' || busy || !window.confirm(`确定删除仿真机日志 ${selected}？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const removed = selected;
      await ftpDeleteLog(removed);
      setSelected('');
      await refreshRemote();
      setStatus(`已删除 ${removed}`);
    } catch (error) { setStatus(`删除失败：${errorText(error)}`); }
    finally { setBusy(false); }
  };

  const items: LogItem[] = tab === 'remote' ? remoteLogs.map(log => ({ key: log.name, name: log.name,
    size: log.size, modified: log.modified })) : localLogs.map(log => ({ key: log.path,
    name: log.name, size: log.size, modified: log.modified }));
  const groups = useMemo(() => {
    const byDay = new Map<string, LogItem[]>();
    for (const item of items) {
      const parsedDate = item.modified == null ? null : typeof item.modified === 'number'
        ? new Date(item.modified) : item.modified.startsWith('epoch:')
          ? new Date(Number(item.modified.slice(6)) * 1000) : new Date(item.modified);
      const day = tab === 'remote' && /^\d{4}-\d{2}-\d{2}\//.test(item.name)
        ? item.name.slice(0, 10) : parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toLocaleDateString('en-CA') : '日期未知';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(item);
    }
    return [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [tab, remoteLogs, localLogs]);
  const current = items.find(item => item.key === selected);
  const totalBytes = remoteLogs.find(log => log.name === downloadProgress?.name)?.size;
  const progressPercent = totalBytes && downloadProgress
    ? Math.min(100, Math.floor(downloadProgress.bytes / totalBytes * 100)) : null;
  const displayedStatus = downloadProgress
    ? `${downloadProgress.retries ? `重新下载（第 ${downloadProgress.retries + 1} 次）` : '正在下载'} ${downloadProgress.name.split('/').pop()}：${formatSize(downloadProgress.bytes)}${totalBytes ? ` / ${formatSize(totalBytes)}（${progressPercent}%）` : ''}`
    : status;
  const errorStatus = /^(打开失败|下载失败|下载或打开失败|读取失败|删除失败)：/.test(status) || status.includes('MCAP 文件头或文件尾无效') ? status : null;
  const toggleDay = (day: string) => setExpandedDays(currentDays => {
    const next = new Set(currentDays);
    if (next.has(day)) next.delete(day); else next.add(day);
    return next;
  });

  return <div className="log-center">
    <header className="log-center-head">
      <div><span className="log-center-mark">▥</span><strong>日志中心</strong><small>MCAP 日志管理与 PlotJuggler 查看</small></div>
      <div className="log-center-actions">
        <button onClick={() => void openLocal()} disabled={busy}>＋ 打开本地 MCAP</button>
        <button onClick={() => void refreshRemote()} disabled={busy}>↻ 刷新仿真机</button>
        {current && <button onClick={() => void viewSelected()} disabled={busy}>📈 PlotJuggler 查看</button>}
        {tab === 'remote' && current && <button onClick={() => void downloadRemote(selected, false)} disabled={busy}>↓ 下载</button>}
        {tab === 'remote' && current && <button className="danger" onClick={() => void deleteRemote()} disabled={busy}>删除</button>}
        <button className="log-center-close" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="log-center-tabs">
      <button className={tab === 'remote' ? 'active' : ''} onClick={() => { setTab('remote'); setSelected(''); }}>🛰 仿真机日志 <b>{remoteLogs.length}</b></button>
      <button className={tab === 'local' ? 'active' : ''} onClick={() => { setTab('local'); setSelected(''); }}>💻 本地日志 <b>{localLogs.length}</b></button>
      <span>{displayedStatus}</span>
    </div>
    <main className="log-center-body">
      <aside className="log-file-panel">
        <div className="log-panel-title">日志文件</div>
        {items.length === 0 ? <div className="log-empty">暂无日志</div> : groups.map(([day, files]) => <div className="log-day-group" key={day}>
          <button className="log-day-title" onClick={() => toggleDay(day)} aria-expanded={expandedDays.has(day)}><span className="log-day-arrow">{expandedDays.has(day) ? '▼' : '▶'}</span><span>{expandedDays.has(day) ? '📂' : '📁'}</span><strong>{day}</strong><small>{files.length}</small></button>
          {expandedDays.has(day) && files.map(file => <button key={file.key} className={selected === file.key ? 'selected' : ''}
            onClick={() => setSelected(file.key)} onDoubleClick={() => { if (tab === 'remote') void downloadRemote(file.key, true); else void viewLocal(file.key); }}
            title="双击用 PlotJuggler 查看"><span>◫</span><div><strong>{file.name.split('/').pop()}</strong><small>{formatDate(file.modified)} · {formatSize(file.size)}</small></div></button>)}
        </div>)}
      </aside>
      <section className="log-plot-panel">
        <div className="log-plot-toolbar"><strong>日志查看</strong></div>
        <div className="log-plot-empty"><div className="log-wave">⌁⌁⌁</div><strong>{current?.name.split('/').pop() || '选择一个 MCAP 日志'}</strong>
          <span>{downloadProgress ? `下载中：${formatSize(downloadProgress.bytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ''}` : tab === 'remote' ? '选择仿真机日志后，在 PlotJuggler 中查看曲线' : '选择本地日志后，在 PlotJuggler 中查看曲线'}</span>
          {downloadProgress && progressPercent !== null && <div className="log-download-progress"><i style={{ width: `${progressPercent}%` }} /></div>}
          {!downloadProgress && errorStatus && <div className="log-open-error" role="alert">{errorStatus}</div>}
          {current && <button className="log-open-plotjuggler" onClick={() => void viewSelected()} disabled={busy}>📈 用 PlotJuggler 查看</button>}
        </div>
      </section>
      <aside className="log-detail-panel">
        <div className="log-panel-title">日志信息</div>
        <dl><dt>来源</dt><dd>{current ? tab === 'remote' ? 'NuttX 仿真机' : '本地文件' : '—'}</dd>
          <dt>格式</dt><dd>{current ? 'MCAP' : '—'}</dd>
          <dt>文件</dt><dd>{current?.name || '—'}</dd>
          {current && <><dt>日期</dt><dd>{formatDate(current.modified)}</dd><dt>大小</dt><dd>{formatSize(current.size)}</dd></>}
        </dl>
      </aside>
    </main>
  </div>;
}
