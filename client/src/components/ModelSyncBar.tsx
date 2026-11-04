import { useEffect, useRef, useState } from 'react';

interface ModelSyncBarProps {
  paths: string[];
  initialUpload: boolean;
  busy: boolean;
  canDiscard: boolean;
  onSave: () => void;
  onDiscard: () => string | null;
}

function SyncIcon({ kind }: { kind: 'pending' | 'save' | 'undo' | 'file' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'pending' && <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M12 12v3m0 3h.01" /></>}
    {kind === 'save' && <><path d="M12 16V3m-4 4 4-4 4 4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></>}
    {kind === 'undo' && <><path d="M4 9h10a6 6 0 0 1 0 12" /><path d="m9 4-5 5 5 5" /></>}
    {kind === 'file' && <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8m-8 4h5" /></>}
  </svg>;
}

export default function ModelSyncBar({ paths, initialUpload, busy, canDiscard, onSave, onDiscard }: ModelSyncBarProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [discardError, setDiscardError] = useState('');
  useEffect(() => {
    const element = bar.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    // Floating HUD windows start below the notice, including when it wraps.
    const update = () => parent.style.setProperty('--model-sync-height', `${element.offsetHeight}px`);
    const observer = new ResizeObserver(update);
    update();
    observer.observe(element);
    return () => { observer.disconnect(); parent.style.removeProperty('--model-sync-height'); };
  }, []);
  return <>
    <div ref={bar} className="model-sync-bar" role="status" aria-label="模型待保存状态">
      <span className="model-sync-mark"><SyncIcon kind="pending" /></span>
      <div className="model-sync-summary">
        <div className="model-sync-heading">
          <strong>{initialUpload ? '本地模型尚未保存到仿真机' : '有本地修改，需要保存到仿真机'}</strong>
          <span className="model-sync-count">{paths.length} 个文件待核对</span>
        </div>
        <small title={paths.join('、')}><SyncIcon kind="file" /><span>{paths.join('、')}</span></small>
      </div>
      <div className="model-sync-actions">
        <button type="button" className="model-sync-discard" disabled={busy || !canDiscard}
          title={canDiscard ? '恢复到上次加载或成功保存时的版本' : '没有可取消的本地更改'} onClick={() => { setDiscardError(''); dialog.current?.showModal(); continueButton.current?.focus(); }}>
          <SyncIcon kind="undo" />取消本地更改
        </button>
        <button type="button" className="model-sync-save" disabled={busy} onClick={onSave} aria-busy={busy}>
          <SyncIcon kind="save" />{busy ? '正在核对…' : '对比并保存到仿真机'}
        </button>
      </div>
    </div>
    <dialog ref={dialog} className="model-discard-dialog" aria-labelledby="model-discard-title" aria-describedby="model-discard-description"
      onKeyDown={event => event.stopPropagation()}>
      <header>
        <span className="model-discard-mark"><SyncIcon kind="undo" /></span>
        <div><h2 id="model-discard-title">取消本地更改？</h2><p>恢复模型的上次版本</p></div>
        <button type="button" className="model-discard-close" aria-label="关闭取消本地更改弹窗" onClick={() => dialog.current?.close()}>×</button>
      </header>
      <div className="model-discard-body">
        <p id="model-discard-description">{initialUpload ? '将恢复到导入时的模型，放弃之后的本地修改。' : '将恢复到上次从仿真机加载或成功保存时的版本，放弃当前本地修改。'}</p>
        <div className="model-discard-files"><strong>涉及 {paths.length} 个文件</strong><ul>{paths.map(path => <li key={path}><SyncIcon kind="file" /><span>{path}</span></li>)}</ul></div>
        <p className="model-discard-note">画布布局会保留，仿真机上的文件不会更改。</p>
        {discardError && <p className="model-discard-error" role="alert">{discardError}</p>}
      </div>
      <footer>
        <button ref={continueButton} type="button" onClick={() => dialog.current?.close()}>继续编辑</button>
        <button type="button" className="danger" onClick={() => { const error = onDiscard(); if (error) setDiscardError(error); else dialog.current?.close(); }}>确认取消本地更改</button>
      </footer>
    </dialog>
  </>;
}
