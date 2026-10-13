import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useSignalIndex } from '../hooks/useSignalIndex';
import './signalPathInput.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  title?: string;
  multiple?: boolean;
  readOnly?: boolean;
}

export default function SignalPathInput({ value, onChange, placeholder, style, className, title, multiple, readOnly }: Props) {
  const signals = useSignalIndex();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 360 });

  const placeMenu = () => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition({
      top: Math.min(rect.bottom + 4, window.innerHeight - 330),
      left: Math.min(rect.left, Math.max(8, window.innerWidth - 490)),
      width: Math.max(280, Math.min(480, window.innerWidth - 16)),
    });
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as globalThis.Node) &&
          !menu.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
    };
  }, [open]);

  const visible = signals.filter(signal => signal.path.toLowerCase().includes(query.toLowerCase())).slice(0, 100);
  const choose = (path: string) => {
    if (multiple) {
      const cursor = input.current?.selectionStart ?? value.length;
      const before = value.slice(0, cursor);
      const after = value.slice(cursor);
      const start = before.lastIndexOf(',') + 1;
      const end = after.indexOf(',');
      const suffix = end < 0 ? '' : after.slice(end);
      onChange(`${before.slice(0, start)}${start ? ' ' : ''}${path}${suffix}`);
    } else onChange(path);
    setOpen(false);
    input.current?.focus();
  };

  return <div className={`signal-path-input ${className || ''}`} ref={root} style={style}>
    <input ref={input} type="text" value={value ?? ''} title={title} placeholder={placeholder}
      readOnly={readOnly} onChange={event => onChange(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }} />
    {!readOnly && <button type="button" className="signal-path-trigger" title="从全局信号索引选择"
      aria-label="选择信号" aria-expanded={open} onClick={() => { setQuery(''); placeMenu(); setOpen(!open); }}>⌕</button>}
    {open && createPortal(<div ref={menu} className="signal-path-menu" role="dialog" aria-label="全局信号索引"
      style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}>
      <input autoFocus type="search" value={query} placeholder="搜索当前工程和已发现信号"
        onChange={event => setQuery(event.target.value)} />
      <div className="signal-path-count">{signals.length} 条信号 · 可继续手动填写</div>
      <div className="signal-path-results">
        {visible.map(signal => <button type="button" key={signal.path} title={signal.origins.map(origin => `${origin.source} · ${origin.kind}`).join('\n')}
          onClick={() => choose(signal.path)}>
          <code>{signal.path}</code>
          <small>{signal.origins.some(origin => origin.kind === 'graph-output' || origin.kind === 'xml-definition') ? '工程定义' : signal.origins.some(origin => origin.kind === 'graph-input' || origin.kind === 'xml-reference') ? '工程引用' : '运行缓存'}</small>
        </button>)}
        {!visible.length && <p>没有匹配信号；可手动输入新路径</p>}
      </div>
    </div>, document.body)}
  </div>;
}
