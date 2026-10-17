import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getSimulatorTransportMode, nshExecute } from '../utils/tauriApi';

const cleanTerminalOutput = (value: string) => value
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

const HISTORY_KEY = 'jsbsim-nsh-command-history';
const HISTORY_LIMIT = 100;
const OUTPUT_LIMIT = 120_000;

const loadHistory = (): string[] => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(saved)
      ? saved.filter((value): value is string => typeof value === 'string' && !!value.trim()).slice(0, HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
};

export default function NshConsoleDialog({ onClose }: { onClose: () => void }) {
  const transportMode = getSimulatorTransportMode();
  const transportLabel = transportMode === 'usb' ? '仅 USB' : transportMode === 'network' ? '仅 TCP' : 'USB / TCP 自动选择';
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState(`NuttX NSH console · ${transportLabel}\n`);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();
  const draftRef = useRef('');
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => { queueRef.current = []; }, []);
  useEffect(() => { terminalRef.current?.scrollTo(0, terminalRef.current.scrollHeight); }, [output, command]);

  const appendOutput = (value: string) => setOutput(previous => {
    const next = previous + value;
    return next.length > OUTPUT_LIMIT ? `[较早输出已省略]\n${next.slice(-OUTPUT_LIMIT)}` : next;
  });

  const drainQueue = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      while (queueRef.current.length) {
        const line = queueRef.current.shift()!;
        setQueued(queueRef.current.length);
        appendOutput(`nsh> ${line}\n`);
        try {
          const result = cleanTerminalOutput(await nshExecute(line));
          appendOutput(result || '(no output)\n');
        } catch (error: unknown) {
          const message = String(error instanceof Error ? error.message : error);
          const hint = transportMode === 'usb' && message.includes('USB file response timed out')
            ? '提示：当前设为「仅 USB」。可在本地配置中选择「网络」或「自动」后重试。\n'
            : '';
          appendOutput(`error: ${message}\n${hint}`);
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const submit = () => {
    const line = command;
    if (!line.trim()) return;
    const nextHistory = [line, ...history.filter(item => item !== line)].slice(0, HISTORY_LIMIT);
    setHistory(nextHistory);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory)); } catch { /* Keep this session's history. */ }
    setCommand('');
    setHistoryIndex(-1);
    draftRef.current = '';
    queueRef.current.push(line);
    setQueued(queueRef.current.length - (runningRef.current ? 0 : 1));
    void drainQueue();
  };

  const navigateHistory = (direction: 1 | -1) => {
    if (!history.length) return;
    if (historyIndex < 0 && direction < 0) draftRef.current = command;
    const next = direction < 0 ? Math.min(historyIndex + 1, history.length - 1) : Math.max(historyIndex - 1, -1);
    setHistoryIndex(next);
    setCommand(next < 0 ? draftRef.current : history[next]);
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

  return <div className="nsh-console-overlay" role="dialog" aria-label="NuttX NSH 控制台" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="nsh-console" style={position ? { position: 'fixed', left: position.left, top: position.top, margin: 0 } : undefined} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}>
      <header onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}><div><b>⌨ NuttX NSH 控制台</b><small>{transportLabel} · 回车执行 · ↑↓ 历史命令（本机保存） · 标题栏拖动 · 右下角缩放</small></div><div className="nsh-console-actions"><button onClick={() => setOutput('')}>清屏</button><button onClick={onClose}>×</button></div></header>
      <div className="nsh-terminal" ref={terminalRef} onClick={() => {
        if (window.getSelection()?.isCollapsed !== false) inputRef.current?.focus();
      }}>
        <pre>{output}</pre>
        <div className="nsh-prompt"><span>nsh&gt;</span><input ref={inputRef} value={command} spellCheck={false} onChange={event => { setCommand(event.target.value); setHistoryIndex(-1); }} onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); submit(); }
          if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); }
          if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); }
          if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); setOutput(''); }
        }} autoComplete="off" aria-label="NSH command" />{running && <span className="nsh-running">执行中…{queued > 0 ? ` 待执行 ${queued}` : ''}</span>}</div>
      </div>
      <span className="nsh-resize-corner" aria-hidden="true" />
    </section>
  </div>;
}
