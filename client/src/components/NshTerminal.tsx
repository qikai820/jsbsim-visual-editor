import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TerminalChannel } from '../px4/shell';
import '@xterm/xterm/css/xterm.css';
import './NshTerminal.css';

/** The simulator dialog and PX4 toolbox share the same terminal and keyboard path. */
export default function NshTerminal({ channel, connected, historyKey = 'jsbsim-nsh-command-history' }: { channel: TerminalChannel; connected: boolean; historyKey?: string }) {
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal>();
  const ready = useRef(connected), [error, setError] = useState('');
  ready.current = connected;
  useEffect(() => {
    let disposed = false, dispose = () => {};
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !host.current) return;
      // NSH streams can contain bare LF without a PTY translating it to CRLF.
      const term = new Terminal({ cursorBlink: true, cursorStyle: 'bar', cursorWidth: 1, cursorInactiveStyle: 'bar', fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: 5000,
        theme: { background: '#111827', foreground: '#d1fae5', cursor: '#f8fafc', selectionBackground: '#475569' }, convertEol: true });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
      const resize = () => { if (host.current?.clientWidth && host.current.clientHeight) { fit.fit(); } };
      const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
      let queue = Promise.resolve(), history: string[] = [], historyIndex = -1, draft = '';
      try { const stored = JSON.parse(localStorage.getItem(historyKey) || '[]'); if (Array.isArray(stored)) history = stored.filter(v => typeof v === 'string').slice(0, 100); } catch { /* retain session-only history */ }
      const send = (data: string) => { queue = queue.then(() => channel.write(data)).catch(e => setError(String(e))); };
      const input = term.onData(data => {
        if (!ready.current) { setError('请先连接终端会话'); return; } setError('');
        const line = term.buffer.active.getLine(term.buffer.active.cursorY + term.buffer.active.baseY)?.translateToString(true) || '';
        const prompt = line.lastIndexOf('nsh> ');
        // Outside an NSH prompt (e.g. top/editor), keys go directly to the remote process.
        if ((data === '\x1b[A' || data === '\x1b[B') && prompt >= 0 && history.length) {
          if (historyIndex < 0) draft = line.slice(prompt + 5);
          historyIndex = data === '\x1b[A' ? Math.min(history.length-1, historyIndex+1) : Math.max(-1, historyIndex-1);
          send('\x15' + (historyIndex < 0 ? draft : history[historyIndex])); return;
        }
        if (data === '\r' && prompt >= 0) {
          const command = line.slice(prompt + 5).trim(); if (command) { history = [command, ...history.filter(c => c !== command)].slice(0, 100); try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch { /* full storage does not stop the terminal */ } }
        }
        historyIndex = -1; send(data);
      });
      term.attachCustomKeyEventHandler(event => {
        if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); term.clear(); return false; }
        // Keep browser copy available when output is selected.
        if (event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()) return false;
        return true;
      });
      const unsubscribe = channel.subscribe(bytes => term.write(bytes));
      term.focus();
      dispose = () => { observer.disconnect(); unsubscribe(); input.dispose(); terminal.current = undefined; term.dispose(); };
    }).catch(e => setError(String(e)));
    return () => { disposed = true; dispose(); };
  }, [channel, historyKey]);
  return <div className="nsh-terminal-wrapper">
    <div className="nsh-terminal-toolbar"><span>{connected ? '会话已连接' : '会话未连接'} · Enter 执行 · ↑↓ 历史 · Ctrl+L 清屏</span><div><button type="button" onClick={() => { terminal.current?.clear(); terminal.current?.focus(); }}>清屏</button><button type="button" disabled={!connected} onClick={() => { void channel.write('\x03').catch(e => setError(String(e))); terminal.current?.focus(); }}>Ctrl+C</button></div></div>
    <div ref={host} onKeyDown={e => e.stopPropagation()} onKeyUp={e => e.stopPropagation()} className="nsh-terminal-host" aria-label="NSH 交互终端" />
    {error && <div role="alert" className="nsh-terminal-error">{error}</div>}
  </div>;
}
