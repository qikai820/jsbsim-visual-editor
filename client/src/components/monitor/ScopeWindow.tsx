import { useEffect, useMemo, useRef, useState } from 'react';
import { monitorRecord, sampleText, useSignalMonitorStore, type MonitorPoint } from '../../store/signalMonitorStore';
import type { SignalHistory } from '../../sim/signalHistory';
import FloatInput from '../FloatInput';
import { convertScopeValue, formatScopeValue, scopeSampleText, scopeUnits, SCOPE_UNIT_GROUPS } from './scopeUnits';
const colors = ['#06b6d4', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#e879f9', '#a3e635'];

// Keep extrema in each screen column, preserving short peaks while bounding
// the amount of SVG geometry even when a long history is visible.
export function waveformPoints(points: MonitorPoint[], start: number, end: number, width: number): MonitorPoint[] {
  const result: MonitorPoint[] = [];
  let bucket: MonitorPoint[] = [], column = -1;
  const flush = () => {
    if (!bucket.length) return;
    const valid = bucket.filter(p => p.value !== null);
    if (!valid.length) result.push(bucket[0]);
    else {
      const min = valid.reduce((a, b) => a.value! < b.value! ? a : b), max = valid.reduce((a, b) => a.value! > b.value! ? a : b);
      for (const point of [...new Set([bucket[0], min, max, bucket[bucket.length - 1]])].sort((a, b) => a.t - b.t)) result.push(point);
    }
    bucket = [];
  };
  for (const point of points) {
    if (point.t < start || point.t > end) continue;
    const next = Math.floor((point.t - start) / Math.max(1e-9, end - start) * width);
    if (next !== column || point.value === null) { flush(); column = next; }
    bucket.push(point); if (point.value === null) flush();
  }
  flush(); return result;
}

export default function ScopeWindow() {
  const state = useSignalMonitorStore(), scope = state.project.scopes.find(scope => scope.id === state.openScope);
  const preferredWindow = scope?.windowSeconds ?? 30;
  const duration = Number.isFinite(preferredWindow) && preferredWindow >= 0.1 && preferredWindow <= 86400 ? preferredWindow : 30;
  const [viewEnd, setViewEnd] = useState<number | null>(null), [frozen, setFrozen] = useState(false);
  const [windowError, setWindowError] = useState('');
  const [cursor, setCursor] = useState<number | null>(null), [autoY, setAutoY] = useState(true);
  const [yMin, setYMin] = useState(-1), [yMax, setYMax] = useState(1);
  const capture = useRef<{ session: string; end: number; records: Map<string, { record: SignalHistory; count: number }> } | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const channels = scope?.channels || [];
  const conversionKey = JSON.stringify(channels.map(binding => [binding.key, binding.sign, binding.unit, binding.sourceUnit, binding.displayUnit]));
  const now = state.running[state.instance]?.t || 0;
  const session = `${state.instance}:${scope?.id || ''}:${state.running[state.instance]?.generation || ''}`;
  const snapshot = frozen && capture.current?.session === session ? capture.current : null;
  const isFrozen = snapshot !== null;
  useEffect(() => { capture.current = null; setFrozen(false); setViewEnd(null); setCursor(null); setHidden([]); setWindowError(''); }, [session]);
  const recordEnd = snapshot ? snapshot.end : now;
  const latestEnd = Math.max(duration, recordEnd);
  const end = viewEnd === null ? latestEnd : Math.max(duration, Math.min(latestEnd, viewEnd)), start = end - duration;
  const records = channels.map(binding => {
    if (sampleText(binding, state.instance, state).status === '运行模型结构不匹配') return undefined;
    return snapshot ? snapshot.records.get(binding.key) : (() => { const record = monitorRecord(state.instance, binding.key); return record ? { record, count: record.length } : undefined; })();
  });
  const series = records.map((entry, index) => entry ? entry.record.range(start, Math.min(end, recordEnd), 800, entry.count)
    .map(point => ({ t: point.t, value: point.value === null ? null : convertScopeValue(point.value * (channels[index].sign ?? 1), channels[index]) })) : []);
  const visible = series.flatMap((points, i) => hidden.includes(channels[i]?.key) ? [] : points.filter(p => p.t >= start && p.t <= end && p.value !== null).map(p => p.value!));
  let low = autoY && visible.length ? visible.reduce((a, b) => Math.min(a, b), Infinity) : yMin, high = autoY && visible.length ? visible.reduce((a, b) => Math.max(a, b), -Infinity) : yMax;
  if (high <= low) { low -= 1; high += 1; }
  if (autoY) { const pad = (high - low) * 0.08; low -= pad; high += pad; }
  const W = 900, H = 360, left = 75, top = 18, width = 800, height = 295;
  const x = (t: number) => left + (t - start) / duration * width;
  const y = (v: number) => top + height - (v - low) / (high - low) * height;
  const paths = useMemo(() => series.map(points => {
    let move = true;
    return waveformPoints(points, start, end, width).map(point => {
      if (point.value === null) { move = true; return ''; }
      const command = `${move ? 'M' : 'L'}${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}${move ? ' l0.01,0' : ''}`;
      move = false; return command;
    }).join(' ');
  }), [state.tick, isFrozen, viewEnd, start, end, duration, low, high, scope?.id, state.instance, conversionKey]);
  if (!scope) return null;
  const freeze = () => {
    if (!isFrozen) capture.current = { session, end: now, records: new Map(channels.flatMap(binding => {
      const record = monitorRecord(state.instance, binding.key);
      return record ? [[binding.key, { record, count: record.length }] as const] : [];
    })) };
    else { capture.current = null; setViewEnd(null); }
    setFrozen(!isFrozen);
  };
  const changeDuration = (seconds: number) => {
    if (seconds < 0.1 || seconds > 86400) { setWindowError('时间窗口请输入 0.1～86400 秒。'); return; }
    setWindowError(''); state.patchScope(scope.id, { windowSeconds: seconds }); setCursor(null);
  };
  const historyCount = channels.reduce((count, binding) => count + (monitorRecord(state.instance, binding.key)?.length || 0), 0);
  return <div className="monitor-window-backdrop" onPointerDown={event => event.stopPropagation()}>
    <section className="monitor-window" role="dialog" aria-modal="false" aria-label="示波器波形" data-testid="scope-window">
      <header><span className="monitor-window-grip" title="拖动示波器；可从右下角调整大小">⠿</span><input aria-label="示波器名称" value={scope.title} onChange={event => state.patchScope(scope.id, { title: event.target.value })} />
        <span>实例 {state.instance} · {isFrozen ? '显示已冻结' : viewEnd !== null ? '历史查看' : state.running[state.instance]?.state || '等待数据'}</span>
        <button onClick={() => useSignalMonitorStore.setState({ openScope: null })} aria-label="关闭示波器">×</button></header>
      <div className="monitor-window-tools">
        <label>时间窗口 <FloatInput aria-label="示波器时间窗口（秒）" value={duration} onValueChange={changeDuration} title="默认 30 秒，可设为 0.1～86400 秒" /> s</label>
        <button onClick={freeze}>{isFrozen ? '恢复实时' : '冻结显示'}</button>
        <button onClick={() => { setViewEnd(duration); setCursor(null); }} disabled={start <= 0}>回到起点</button>
        <button onClick={() => { setViewEnd(Math.max(duration, end - duration / 2)); setCursor(null); }} disabled={start <= 0}>← 历史</button>
        <button onClick={() => { const next = Math.min(latestEnd, end + duration / 2); setViewEnd(next >= latestEnd ? null : next); setCursor(null); }} disabled={end >= latestEnd}>较新 →</button>
        <button onClick={() => { capture.current = null; setFrozen(false); setViewEnd(null); setCursor(null); }}>最新</button>
        <label><input type="checkbox" checked={autoY} onChange={event => setAutoY(event.target.checked)} />自动纵轴</label>
        {!autoY && <><input aria-label="纵轴最小值" type="number" value={yMin} onChange={event => setYMin(Number(event.target.value))} /><input aria-label="纵轴最大值" type="number" value={yMax} onChange={event => setYMax(Number(event.target.value))} /></>}
        <button onClick={() => { state.clearHistory(state.instance, channels.map(c => c.key)); capture.current = null; setFrozen(false); setViewEnd(null); setCursor(null); }}>清空波形</button>
        {windowError && <small role="alert">{windowError}</small>}
      </div>
      <svg className="monitor-chart" data-start-time={start} data-end-time={end} viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setCursor(null)}
        onMouseMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setCursor(Math.max(start, Math.min(end, start + ((event.clientX - rect.left) / rect.width * W - left) / width * duration))); }}
        onWheel={event => changeDuration(Math.max(0.1, Math.min(86400, duration * (event.deltaY > 0 ? 2 : 0.5))))}>
        <defs><clipPath id="monitor-plot-clip"><rect x={left} y={top} width={width} height={height} /></clipPath></defs>
        <rect x={left} y={top} width={width} height={height} fill="#0f172a" />
        {Array.from({ length: 6 }, (_, i) => <g key={i}><line x1={left} x2={left + width} y1={top + i * height / 5} y2={top + i * height / 5} stroke="#334155" /><text x={left - 8} y={top + i * height / 5 + 4} textAnchor="end">{Number((high - i * (high - low) / 5).toPrecision(5))}</text></g>)}
        {Array.from({ length: 6 }, (_, i) => <g key={i}><line x1={left + i * width / 5} x2={left + i * width / 5} y1={top} y2={top + height} stroke="#334155" /><text x={left + i * width / 5} y={top + height + 24} textAnchor="middle">{(start + i * duration / 5).toFixed(2)}</text></g>)}
        <g clipPath="url(#monitor-plot-clip)">{paths.map((path, i) => !hidden.includes(channels[i]?.key) && <path key={i} d={path} fill="none" stroke={colors[i % colors.length]} strokeWidth="1.6" strokeLinecap="round" data-testid="scope-waveform" />)}</g>
        {cursor !== null && <line x1={x(cursor)} x2={x(cursor)} y1={top} y2={top + height} stroke="#e2e8f0" strokeDasharray="4 3" />}
        <text x={left + width / 2} y={H - 8} textAnchor="middle">仿真时间 / s{cursor !== null ? ` · 游标 ${cursor.toFixed(4)} s` : ''}</text>
      </svg>
      <div className="monitor-channel-list">{channels.map((binding, index) => {
        const entry = records[index], recent = entry?.record.recent(30, recordEnd, entry.count) || [];
        const rate = recent.length > 1 && recent[recent.length - 1].t > recent[0].t ? (recent.length - 1) / (recent[recent.length - 1].t - recent[0].t) : 0;
        const nearest = cursor === null ? isFrozen ? entry?.record.recent(1, recordEnd, entry.count)[0] : null : entry?.record.nearest(cursor, recordEnd, entry.count);
        const units = scopeUnits(binding);
        const changeUnit = (patch: Partial<typeof binding>) => state.patchScope(scope.id, {
          channels: channels.map((current, channelIndex) => channelIndex === index ? { ...current, ...patch } : current),
        });
        return <div key={`${binding.key}:${binding.sign}`}>
          <input type="checkbox" checked={!hidden.includes(binding.key)} onChange={() => setHidden(hidden.includes(binding.key) ? hidden.filter(key => key !== binding.key) : [...hidden, binding.key])} />
          <span style={{ color: colors[index % colors.length] }}>CH{index + 1}</span><span className="monitor-channel-name" title={binding.key}>{binding.label}</span>
          <div className="monitor-channel-units">
            <label>原单位<select aria-label={`CH${index + 1} 原单位`} value={binding.sourceUnit || ''} onChange={event => changeUnit({ sourceUnit: event.target.value || undefined, displayUnit: undefined })}>
              <option value="">自动（{units.inferred || '未知'}）</option>
              {SCOPE_UNIT_GROUPS.map(group => <optgroup key={group.label} label={group.label}>{group.units.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}</optgroup>)}
            </select></label>
            <label>显示<select aria-label={`CH${index + 1} 显示单位`} value={binding.displayUnit && units.target === binding.displayUnit ? binding.displayUnit : ''} disabled={!units.source} onChange={event => changeUnit({ displayUnit: event.target.value || undefined })}>
              <option value="">原单位{units.source ? `（${units.source}）` : ''}</option>
              {units.group?.units.filter(unit => unit.id !== units.source).map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
            </select></label>
          </div>
          <strong data-testid={`scope-channel-value-${index + 1}`}>{nearest ? formatScopeValue(nearest.value! * (binding.sign ?? 1), binding) : isFrozen ? '—' : scopeSampleText(binding, state.instance, state).text}</strong>
          <small>{rate ? `${rate.toFixed(1)} Hz` : '等待采样'}</small>
          <button aria-label={`移除通道 ${index + 1}`} onClick={() => state.patchScope(scope.id, { channels: channels.filter((_, i) => i !== index) })}>×</button>
        </div>;
      })}</div>
      <footer><span>{state.error || `本次仿真已记录 ${historyCount.toLocaleString()} 点 · 纵轴按各通道显示单位 · 丢帧 ${state.running[state.instance]?.dropped || 0}`}</span><button onClick={() => { useSignalMonitorStore.setState({ armedScope: scope.id, openScope: null }); }}>+ 接入信号</button></footer>
    </section>
  </div>;
}
