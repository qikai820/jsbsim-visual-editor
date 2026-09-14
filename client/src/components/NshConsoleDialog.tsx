import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { nshExecute } from '../utils/tauriApi';

const cleanTerminalOutput = (value: string) => value
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

export default function NshConsoleDialog({ onClose }: { onClose: () => void }) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('NuttX NSH console · 192.168.101.81:23\n');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [running, setRunning] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { terminalRef.current?.scrollTo(0, terminalRef.current.scrollHeight); }, [output, command]);

  const run = async () => {
    const line = command.trim();
    if (!line || running) return;
    setCommand('');
    setHistory(previous => [line, ...previous.filter(item => item !== line)].slice(0, 50));
    setHistoryIndex(-1);
    setRunning(true);
    setOutput(previous => `${previous}nsh> ${line}\n`);
    try {
      const result = cleanTerminalOutput(await nshExecute(line));
      setOutput(previous => `${previous}${result || '(no output)\n'}`);
    } catch (error: any) {
      setOutput(previous => `${previous}error: ${error?.message || error}\n`);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const navigateHistory = (direction: 1 | -1) => {
    if (!history.length) return;
    const next = direction < 0 ? Math.min(historyIndex + 1, history.length - 1) : Math.max(historyIndex - 1, -1);
    setHistoryIndex(next);
    setCommand(next < 0 ? '' : history[next]);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    setPosition({ left: rect.left, top: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.stopPropagation();
    setPosition({ left: start.left + event.clientX - start.x, top: start.top + event.clientY - start.y });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className="nsh-console-overlay" role="dialog" aria-modal="true" aria-label="NuttX NSH 控制台" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="nsh-console" style={position ? { position: 'fixed', left: position.left, top: position.top, margin: 0 } : undefined} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}>
      <header onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}><div><b>⌨ NuttX NSH 控制台</b><small>TCP 23 · 回车执行 · ↑↓ 历史命令 · 标题栏拖动 · 右下角缩放</small></div><div className="nsh-console-actions"><button onClick={() => setOutput('')}>清屏</button><button onClick={onClose}>×</button></div></header>
      <div className="nsh-terminal" ref={terminalRef} onMouseDown={() => inputRef.current?.focus()}>
        <pre>{output}</pre>
        <div className="nsh-prompt"><span>nsh&gt;</span><input ref={inputRef} value={command} disabled={running} spellCheck={false} onChange={event => { setCommand(event.target.value); setHistoryIndex(-1); }} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void run(); }
          if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); }
          if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); }
          if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); setOutput(''); }
        }} autoComplete="off" aria-label="NSH command" />{running && <span className="nsh-running">执行中…</span>}</div>
      </div>
      <span className="nsh-resize-corner" aria-hidden="true" />
    </section>
  </div>;
}
