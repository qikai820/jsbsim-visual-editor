import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PX4_MESSAGE_LIMIT, PX4_SEVERITIES, type Px4Message, type Px4Messages as MessageBuffer } from '../px4/messages';

const timeText = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(time % 1000).padStart(3, '0');

export default function Px4Messages({ messages, online, visible }: { messages: MessageBuffer; online: boolean; visible: boolean }) {
  const entries = useSyncExternalStore(messages.subscribe, messages.getSnapshot);
  const [search, setSearch] = useState(''), [severity, setSeverity] = useState('all');
  const [paused, setPaused] = useState<Px4Message[] | null>(null), [follow, setFollow] = useState(true);
  const [copyResult, setCopyResult] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!entries.length) setPaused(value => value ? [] : null); }, [entries]);
  const rows = useMemo(() => (paused || entries).filter(entry =>
    (severity === 'all' || entry.severity <= Number(severity)) && entry.text.toLowerCase().includes(search.trim().toLowerCase())
  ), [entries, paused, search, severity]);
  useEffect(() => {
    if (visible && follow && !paused && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [rows, visible, follow, paused]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map(entry => `[${timeText(entry.time)}] [${PX4_SEVERITIES[entry.severity]}] [${entry.system}/${entry.component}] ${entry.incomplete ? '[分片不完整] ' : ''}${entry.text}`).join('\n'));
      setCopyResult('已复制当前显示内容');
    } catch { setCopyResult('复制失败，请选择文字后手动复制'); }
  };
  return <div className="px4-messages">
    <div className="px4-message-heading"><div><h3>PX4 打印</h3><small>{paused ? '已暂停显示 · 后台继续接收' : online ? '正在接收飞控消息' : '等待飞控消息 · 已接收内容保留'}</small></div><div className="px4-message-actions">
      <button aria-pressed={!!paused} onClick={() => setPaused(value => value ? null : entries)}>{paused ? '继续显示' : '暂停显示'}</button>
      <button disabled={!rows.length} onClick={() => void copy()}>复制显示内容</button>
      <button disabled={!entries.length && !paused?.length} onClick={() => { messages.clear(); setPaused(value => value ? [] : null); setCopyResult(''); }}>清空打印</button>
    </div></div>
    <div className="px4-filter px4-message-filter">
      <input aria-label="搜索 PX4 打印" placeholder="搜索打印内容" value={search} onChange={e => setSearch(e.target.value)}/>
      <select aria-label="PX4 打印级别" value={severity} onChange={e => setSeverity(e.target.value)}><option value="all">全部级别</option><option value="4">警告及以上</option><option value="3">错误及以上</option><option value="6">信息及以上</option></select>
      <label><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/>自动滚动</label>
    </div>
    <div className="px4-message-output" ref={viewport} role="region" aria-label="PX4 打印内容" tabIndex={0} onScroll={e => {
      const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight > 32) setFollow(false);
    }}>
      {rows.map(entry => <div key={entry.id} className={'px4-message-row px4-severity-' + entry.severity}>
        <time dateTime={new Date(entry.time).toISOString()}>{timeText(entry.time)}</time><span className="px4-message-level">{PX4_SEVERITIES[entry.severity]}</span><span className="px4-message-source">{entry.system}/{entry.component}</span><span className="px4-message-text">{entry.incomplete && <span className="px4-message-incomplete">[分片不完整] </span>}{entry.text}</span>
      </div>)}
      {!rows.length && <div className="px4-empty">{(paused || entries).length ? '没有匹配的打印消息' : '等待 PX4 打印；收到状态、警告或错误消息后会显示在这里'}</div>}
    </div>
    <div className="px4-message-footer"><span>显示 {rows.length} / 已接收 {entries.length} 条 · 最多保留 {PX4_MESSAGE_LIMIT} 条{paused ? ' · 暂停期间继续缓存' : ''}</span><span role="status">{copyResult}</span><small>接收飞控 MAVLink 状态消息；命令输出请查看 NSH 控制台。</small></div>
  </div>;
}
