import { useEffect, useState } from 'react';
import { telemetryRecordStart, telemetryRecordStop, telemetryRecordStatus, type TelemetryRecordingStatus } from '../utils/tauriApi';

export default function TelemetryRecorder({ open, onClose, onRecordingChange }: { open: boolean; onClose: () => void; onRecordingChange: (recording: boolean) => void }) {
  const [status, setStatus] = useState<TelemetryRecordingStatus>({ recording: false, written: 0, dropped: 0 });
  const [directory, setDirectory] = useState(() => localStorage.getItem('telemetry-record-directory') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try { const next = await telemetryRecordStatus(); if (!disposed) setStatus(next); }
      catch (e) { if (!disposed) setError(String(e)); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => { onRecordingChange(status.recording); }, [status.recording, onRecordingChange]);
  const toggle = async () => {
    setBusy(true); setError('');
    try {
      const next = status.recording ? await telemetryRecordStop() : await telemetryRecordStart(directory.trim() || undefined);
      setStatus(next);
      localStorage.setItem('telemetry-record-directory', directory);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  if (!open) return null;
  return <div className="telemetry-record-panel">
      <div className="telemetry-record-heading"><b>本机遥测记录</b><button type="button" aria-label="关闭遥测记录面板" onClick={onClose}>×</button></div>
      <p>保存每条收到的遥测报文，包含 CPU、FDM、状态和属性数据。PlotJuggler 打开或关闭都不影响记录；断线期间保留文件，重连后继续。</p>
      <label>保存目录<input aria-label="遥测保存目录" value={directory} disabled={status.recording || busy}
        placeholder="默认：文档 / JSBSim / Telemetry" onChange={event => setDirectory(event.target.value)} /></label>
      <p>格式：JSONL · 每条报文附接收时间 · 属性保持原始单位</p>
      <div className="telemetry-record-counts"><span>已写入 <b>{status.written}</b> 条</span><span>丢弃 <b>{status.dropped}</b> 条</span></div>
      {status.path && <div className="telemetry-record-path"><b>{status.recording ? '当前文件' : '记录文件'}</b><code>{status.path}</code></div>}
      {(error || status.error) && <p role="alert" className="telemetry-record-error">{error || status.error}</p>}
      {status.dropped > 0 && <p role="alert" className="telemetry-record-error">写入未能跟上接收速度，记录不完整。</p>}
      <button type="button" className="telemetry-record-action" disabled={busy} onClick={() => void toggle()}>
        {busy ? '正在处理…' : status.recording ? '停止并保存' : '开始记录'}
      </button>
      {!status.recording && status.path && !status.error && !error && <p>已保存。关闭面板不会删除文件。</p>}
  </div>;
}
