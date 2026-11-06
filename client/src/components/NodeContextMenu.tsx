import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface NodeMenuAction { label: string; run: () => void; disabled?: boolean; hint?: string; danger?: boolean }
export default function NodeContextMenu({ x, y, title, actions, onClose }: {
  x: number; y: number; title: string; actions: NodeMenuAction[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', onClose);
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label="模块右键菜单" className="node-context-menu"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 248)), top: Math.max(8, Math.min(y, window.innerHeight - (actions.length * 40 + 64))) }}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
    <div className="node-context-title">{title}</div>
    {actions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled} title={action.hint}
      className={action.danger ? 'danger' : ''} onClick={() => { action.run(); onClose(); }}>
      {action.label}{action.hint && <small>{action.hint}</small>}
    </button>)}
  </div>, document.body);
}
