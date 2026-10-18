import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ftpDeleteLog, ftpDownloadLog, ftpListLogs, ftpLogInfo, listenLogDownloadProgress,
  listDownloadedMcapLogs, openPlotJugglerLog, pickPlotJugglerLog,
  type LocalMcapLog, type RemoteLogFile, type RemoteMcapInfo,
} from '../utils/tauriApi';

const downloadDirectory = () => localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatSize = (size?: number | null) => size == null ? '大小未知' : size >= 1024 ** 2
  ? `${(size / 1024 ** 2).toFixed(1)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
const parseLogDate = (value?: string | number | null): Date | null => {
  if (value == null) return null;
  const date = typeof value === 'number' ? new Date(value)
    : value.startsWith('epoch:') ? new Date(Number(value.slice(6)) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const formatDate = (value?: string | number | null) => {
  if (value == null) return '日期未知';
  const date = parseLogDate(value);
  return date ? date.toLocaleString() : String(value);
};
const formatMcapTime = (nanoseconds: number) => nanoseconds >= 0
  ? `${(nanoseconds / 1_000_000_000).toFixed(3)} s` : '—';
const formatDuration = (start: number, end: number) => {
  if (end < start || (start === 0 && end === 0)) return '—';
  const seconds = Math.floor((end - start) / 1_000_000_000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours} 小时 ` : ''}${minutes} 分 ${seconds % 60} 秒`;
};
const formatCount = (count: number | null) => count == null ? '未提供' : count.toLocaleString();
const formatAverageFrequency = (count: number | null, startNs: number, endNs: number) => {
  const durationNs = endNs - startNs;
  if (count == null || !Number.isFinite(count) || !Number.isFinite(durationNs) || durationNs <= 0) return '—';
  const hertz = count * 1_000_000_000 / durationNs;
  if (!Number.isFinite(hertz)) return '—';
  if (hertz === 0) return '0 Hz';
  if (hertz < 0.01) return '<0.01 Hz';
  return `${hertz.toFixed(2)} Hz`;
};
type LogItem = { key: string; name: string; size?: number | null; modified?: string | number | null };
type WindowRect = { left: number; top: number; width: number; height: number };
type WindowGesture = WindowRect & { pointerId: number; x: number; y: number; mode: 'drag' | 'resize' };
const WINDOW_MARGIN = 8;
const MIN_WINDOW_WIDTH = 520;
const MIN_WINDOW_HEIGHT = 320;

export default function LogCenter({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'remote' | 'local'>('remote');
  const [remoteLogs, setRemoteLogs] = useState<RemoteLogFile[]>([]);
  const [downloadedLogs, setDownloadedLogs] = useState<LocalMcapLog[]>([]);
  const [pickedLogs, setPickedLogs] = useState<LocalMcapLog[]>([]);
  const localLogs = useMemo(() => {
    const byPath = new Map(downloadedLogs.map(log => [log.path, log]));
    for (const log of pickedLogs) if (!byPath.has(log.path)) byPath.set(log.path, log);
    return [...byPath.values()];
  }, [downloadedLogs, pickedLogs]);
  const [selected, setSelected] = useState('');
  const [remoteStatus, setRemoteStatus] = useState('正在读取仿真机日志…');
  const [localStatus, setLocalStatus] = useState('正在读取本地日志…');
  const [busy, setBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ name: string; bytes: number; retries: number } | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const [infoResult, setInfoResult] = useState<{ file: string; value: RemoteMcapInfo } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState('');
  const infoCache = useRef(new Map<string, RemoteMcapInfo>());
  const [windowRect, setWindowRect] = useState<WindowRect | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const windowGesture = useRef<WindowGesture | null>(null);

  const beginWindowGesture = (event: ReactPointerEvent<HTMLElement>, mode: WindowGesture['mode']) => {
    if (event.button !== 0 || (mode === 'drag' && (event.target as HTMLElement).closest('button, input, select, textarea'))) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    windowGesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height, mode };
    setWindowRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const updateWindowGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const start = windowGesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const maxWidth = Math.max(1, window.innerWidth - WINDOW_MARGIN * 2);
    const maxHeight = Math.max(1, window.innerHeight - WINDOW_MARGIN * 2);
    if (start.mode === 'drag') {
      const width = Math.min(start.width, maxWidth);
      const height = Math.min(start.height, maxHeight);
      setWindowRect({ width, height,
        left: Math.max(WINDOW_MARGIN, Math.min(start.left + event.clientX - start.x, window.innerWidth - width - WINDOW_MARGIN)),
        top: Math.max(WINDOW_MARGIN, Math.min(start.top + event.clientY - start.y, window.innerHeight - height - WINDOW_MARGIN)) });
    } else {
      const maxAllowedWidth = Math.max(1, window.innerWidth - start.left - WINDOW_MARGIN);
      const maxAllowedHeight = Math.max(1, window.innerHeight - start.top - WINDOW_MARGIN);
      setWindowRect({ left: start.left, top: start.top,
        width: Math.max(Math.min(MIN_WINDOW_WIDTH, maxAllowedWidth), Math.min(start.width + event.clientX - start.x, maxAllowedWidth)),
        height: Math.max(Math.min(MIN_WINDOW_HEIGHT, maxAllowedHeight), Math.min(start.height + event.clientY - start.y, maxAllowedHeight)) });
    }
  };
  const endWindowGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (windowGesture.current?.pointerId !== event.pointerId) return;
    windowGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const keepWindowVisible = () => setWindowRect(current => {
      if (!current) return current;
      const width = Math.min(current.width, Math.max(1, window.innerWidth - WINDOW_MARGIN * 2));
      const height = Math.min(current.height, Math.max(1, window.innerHeight - WINDOW_MARGIN * 2));
      return { width, height,
        left: Math.max(WINDOW_MARGIN, Math.min(current.left, window.innerWidth - width - WINDOW_MARGIN)),
        top: Math.max(WINDOW_MARGIN, Math.min(current.top, window.innerHeight - height - WINDOW_MARGIN)) };
    });
    window.addEventListener('resize', keepWindowVisible);
    return () => window.removeEventListener('resize', keepWindowVisible);
  }, []);

  const refreshRemote = async () => {
    setRemoteStatus('正在读取仿真机日志…');
    try {
      const files = await ftpListLogs();
      infoCache.current.clear();
      setRemoteLogs(files);
      setRemoteStatus(files.length ? `仿真机上有 ${files.length} 个 MCAP 日志` : '仿真机上没有 MCAP 日志');
    } catch (error) { setRemoteStatus(`读取失败：${errorText(error)}`); }
  };
  const refreshLocal = async () => {
    try {
      const logs = await listDownloadedMcapLogs(downloadDirectory());
      setDownloadedLogs(logs);
      setLocalStatus(logs.length ? `下载目录中有 ${logs.length} 个 MCAP 日志` : '下载目录中没有 MCAP 日志');
    } catch (error) { setLocalStatus(`读取本地失败：${errorText(error)}`); }
  };
  useEffect(() => { void refreshRemote(); void refreshLocal(); }, []);
  useEffect(() => {
    if (tab !== 'remote' || !selected) {
      setInfoResult(null); setInfoLoading(false); setInfoError('');
      return;
    }
    if (busy) { setInfoLoading(false); return; }
    const file = remoteLogs.find(item => item.name === selected);
    if (!file) return;
    const key = `${file.name}:${file.size ?? 'unknown'}`;
    const cached = infoCache.current.get(key);
    if (cached) {
      setInfoResult({ file: selected, value: cached }); setInfoLoading(false); setInfoError('');
      return;
    }
    let active = true;
    setInfoResult(null); setInfoLoading(true); setInfoError('');
    const timer = window.setTimeout(() => {
      void ftpLogInfo(file.name).then(info => {
        if (!active) return;
        infoCache.current.set(key, info);
        setInfoResult({ file: selected, value: info });
      }).catch(error => { if (active) setInfoError(errorText(error)); })
        .finally(() => { if (active) setInfoLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [tab, selected, remoteLogs, busy]);
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
    setPickedLogs(current => [log, ...current.filter(item => item.path !== log.path)]);
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
      setLocalStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
      await openPlotJugglerLog(log.path);
      setLocalStatus(`已启动 PlotJuggler 加载 ${log.name}`);
    } catch (error) { setLocalStatus(`打开失败：${errorText(error)}`); }
    finally { setBusy(false); }
  };
  const downloadRemote = async (name: string, open: boolean) => {
    if (busy) return;
    setBusy(true); setSelected(name);
    setDownloadProgress({ name, bytes: 0, retries: 0 });
    setRemoteStatus(`正在下载 ${name}…`);
    try {
      const result = await ftpDownloadLog(name, downloadDirectory(), remoteLogs.find(log => log.name === name)?.size, open);
      const log: LocalMcapLog = { path: result.path, name: result.path.split('/').pop() || name,
        size: result.size, modified: Date.now() };
      setDownloadedLogs(current => [log, ...current.filter(item => item.path !== log.path)]);
      if (open) {
        setRemoteStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
        await openPlotJugglerLog(result.path);
        setRemoteStatus(`已启动 PlotJuggler 加载 ${log.name}`);
      } else setRemoteStatus(result.hasMcapMarkers ? `已下载到 ${result.path}` : `已下载原始文件到 ${result.path}；MCAP 文件头或文件尾无效，无法用 PlotJuggler 查看`);
    } catch (error) { setRemoteStatus(`${open ? '打开失败' : '下载失败'}：${errorText(error)}`); }
    finally { setDownloadProgress(null); setBusy(false); }
  };
  const viewLocal = async (path: string) => {
    if (busy) return;
    const log = localLogs.find(item => item.path === path);
    if (!log) return;
    setBusy(true); setLocalStatus(`正在用 PlotJuggler 打开 ${log.name}…`);
    try { await openPlotJugglerLog(log.path); setLocalStatus(`已启动 PlotJuggler 加载 ${log.name}`); }
    catch (error) { setLocalStatus(`打开失败：${errorText(error)}`); }
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
      setRemoteStatus(`已删除 ${removed}`);
    } catch (error) { setRemoteStatus(`删除失败：${errorText(error)}`); }
    finally { setBusy(false); }
  };

  const items: LogItem[] = tab === 'remote' ? remoteLogs.map(log => ({ key: log.name, name: log.name,
    size: log.size, modified: log.modified })) : localLogs.map(log => ({ key: log.path,
    name: log.name, size: log.size, modified: log.modified }));
  const groups = useMemo(() => {
    const byDay = new Map<string, LogItem[]>();
    for (const item of items) {
      const parsedDate = parseLogDate(item.modified);
      const day = tab === 'remote' && /^\d{4}-\d{2}-\d{2}\//.test(item.name)
        ? item.name.slice(0, 10) : parsedDate
          ? parsedDate.toLocaleDateString('en-CA') : '日期未知';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(item);
    }
    for (const files of byDay.values()) {
      files.sort((a, b) => (parseLogDate(b.modified)?.getTime() ?? 0)
        - (parseLogDate(a.modified)?.getTime() ?? 0) || b.name.localeCompare(a.name));
    }
    return [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [tab, remoteLogs, localLogs]);
  const current = items.find(item => item.key === selected);
  const mcapInfo = tab === 'remote' && infoResult?.file === selected ? infoResult.value : null;
  const totalBytes = remoteLogs.find(log => log.name === downloadProgress?.name)?.size;
  const progressPercent = totalBytes && downloadProgress
    ? Math.min(100, Math.floor(downloadProgress.bytes / totalBytes * 100)) : null;
  const displayedStatus = downloadProgress
    ? `${downloadProgress.retries ? `重新下载（第 ${downloadProgress.retries + 1} 次）` : '正在下载'} ${downloadProgress.name.split('/').pop()}：${formatSize(downloadProgress.bytes)}${totalBytes ? ` / ${formatSize(totalBytes)}（${progressPercent}%）` : ''}`
    : tab === 'remote' ? remoteStatus : localStatus;
  const errorStatus = /^(打开失败|下载失败|下载或打开失败|读取失败|读取本地失败|删除失败)：/.test(displayedStatus) || displayedStatus.includes('MCAP 文件头或文件尾无效') ? displayedStatus : null;
  const toggleDay = (day: string) => setExpandedDays(currentDays => {
    const next = new Set(currentDays);
    if (next.has(day)) next.delete(day); else next.add(day);
    return next;
  });

  const closeCenter = () => { if (!busy) onClose(); };

  return createPortal(<div className="log-center-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeCenter(); }}>
    <div className="log-center" ref={windowRef} style={windowRect ? { position: 'fixed', ...windowRect } : undefined}
      role="dialog" aria-label="日志中心">
    <header className="log-center-head" onPointerDown={event => beginWindowGesture(event, 'drag')}
      onPointerMove={updateWindowGesture} onPointerUp={endWindowGesture} onPointerCancel={endWindowGesture}>
      <div><span className="log-center-mark">▥</span><strong>日志中心</strong><small>MCAP 日志管理与 PlotJuggler 查看 · 拖动标题栏移动，右下角缩放</small></div>
      <button className="log-center-close" onClick={closeCenter} disabled={busy} aria-label="关闭">×</button>
    </header>
    <div className="log-center-actions">
        <button onClick={() => void openLocal()} disabled={busy}>＋ 打开本地 MCAP</button>
        <button onClick={() => void (tab === 'remote' ? refreshRemote() : refreshLocal())} disabled={busy}>↻ 刷新{tab === 'remote' ? '仿真机' : '本地'}</button>
        {current && <button onClick={() => void viewSelected()} disabled={busy}>📈 PlotJuggler 查看</button>}
        {tab === 'remote' && current && <button onClick={() => void downloadRemote(selected, false)} disabled={busy}>↓ 下载</button>}
        {tab === 'remote' && current && <button className="danger" onClick={() => void deleteRemote()} disabled={busy}>删除</button>}
    </div>
    <div className="log-center-tabs">
      <button className={tab === 'remote' ? 'active' : ''} onClick={() => { setTab('remote'); setSelected(''); }}>🛰 仿真机日志 <b>{remoteLogs.length}</b></button>
      <button className={tab === 'local' ? 'active' : ''} onClick={() => { setTab('local'); setSelected(''); void refreshLocal(); }}>💻 本地日志 <b>{localLogs.length}</b></button>
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
        <div className="log-plot-toolbar"><strong>{tab === 'remote' && current ? 'MCAP 信息' : '日志查看'}</strong></div>
        {tab === 'remote' && current && !downloadProgress && (mcapInfo || infoLoading || infoError) ?
          <div className="log-mcap-info">
            <strong className="log-mcap-name">{current.name.split('/').pop()}</strong>
            {infoLoading ? <p>正在从仿真机读取 MCAP 信息…</p> : infoError ?
              <div className="log-open-error" role="alert">信息读取失败：{infoError}</div> : mcapInfo && <>
                <div className="log-mcap-range">仿真时间 {formatMcapTime(mcapInfo.startNs)} — {formatMcapTime(mcapInfo.endNs)}</div>
                <div className="log-mcap-metrics">
                  <div><small>记录时长</small><strong>{formatDuration(mcapInfo.startNs, mcapInfo.endNs)}</strong></div>
                  <div><small>消息总数</small><strong>{formatCount(mcapInfo.messageCount)}</strong></div>
                  <div><small>通道</small><strong>{mcapInfo.channels.length}</strong></div>
                </div>
                <h3>通道详情</h3>
                <div className="log-mcap-table"><table><thead><tr><th>Topic</th><th>编码</th><th>消息数</th><th>平均频率</th></tr></thead>
                  <tbody>{mcapInfo.channels.map(channel => <tr key={channel.topic}><td>{channel.topic}</td><td>{channel.encoding}</td><td>{formatCount(channel.messageCount)}</td><td>{formatAverageFrequency(channel.messageCount, mcapInfo.startNs, mcapInfo.endNs)}</td></tr>)}</tbody>
                </table></div>
                <p>平均频率 = 通道消息数 ÷ 整段日志的仿真时长；间歇通道包含未发送的时间。</p>
                {mcapInfo.statisticsSource === 'chunk-scan' && <p>此旧日志没有 Statistics；准确消息数需扫描并解压全部 Chunk。</p>}
              </>}
            <button className="log-open-plotjuggler" onClick={() => void viewSelected()} disabled={busy}>📈 用 PlotJuggler 查看</button>
          </div> : <div className="log-plot-empty"><div className="log-wave">⌁⌁⌁</div><strong>{current?.name.split('/').pop() || '选择一个 MCAP 日志'}</strong>
          <span>{downloadProgress ? `下载中：${formatSize(downloadProgress.bytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ''}` : tab === 'remote' ? '选择仿真机日志后，在 PlotJuggler 中查看曲线' : '选择本地日志后，在 PlotJuggler 中查看曲线'}</span>
          {downloadProgress && progressPercent !== null && <div className="log-download-progress"><i style={{ width: `${progressPercent}%` }} /></div>}
          {!downloadProgress && errorStatus && <div className="log-open-error" role="alert">{errorStatus}</div>}
          {current && <button className="log-open-plotjuggler" onClick={() => void viewSelected()} disabled={busy}>📈 用 PlotJuggler 查看</button>}
        </div>}
      </section>
      <aside className="log-detail-panel">
        <div className="log-panel-title">日志信息</div>
        <dl><dt>来源</dt><dd>{current ? tab === 'remote' ? 'NuttX 仿真机' : '本地文件' : '—'}</dd>
          <dt>格式</dt><dd>{current ? 'MCAP' : '—'}</dd>
          <dt>文件</dt><dd>{current?.name || '—'}</dd>
          {current && <><dt>日期</dt><dd>{formatDate(current.modified)}</dd><dt>大小</dt><dd>{formatSize(current.size)}</dd></>}
          {tab === 'remote' && current && mcapInfo && <>
            <dt>Profile</dt><dd>{mcapInfo.profile || '—'}</dd>
            <dt>Library</dt><dd>{mcapInfo.library || '—'}</dd>
            <dt>压缩</dt><dd>{mcapInfo.compression || '无'}</dd>
            <dt>Chunk</dt><dd>{mcapInfo.chunkCount}</dd>
            <dt>统计来源</dt><dd>{mcapInfo.statisticsSource === 'summary' ? 'MCAP Summary' : '板端轻量扫描'}</dd>
          </>}
        </dl>
      </aside>
    </main>
    <div className="log-center-resize-handle" role="separator" aria-label="调整日志中心窗口大小"
      onPointerDown={event => beginWindowGesture(event, 'resize')} onPointerMove={updateWindowGesture}
      onPointerUp={endWindowGesture} onPointerCancel={endWindowGesture} />
    </div>
  </div>, document.body);
}
