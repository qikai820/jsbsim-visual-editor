import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ToolTransport } from '../px4/transport';
import { TelnetDecoder, type TerminalChannel } from '../px4/shell';
import NshTerminal from './NshTerminal';
import NshCommandConsoleDialog from './NshCommandConsoleDialog';
import { getSimulatorTransportMode } from '../utils/tauriApi';

export default function NshConsoleDialog({ onClose }: { onClose: () => void }) {
  const transport = useMemo(() => new ToolTransport('nsh'), []);
  const [connected, setConnected] = useState(false), [error, setError] = useState(''), [target, setTarget] = useState('等待仿真机');
  const [legacy, setLegacy] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();
  const listeners = useRef(new Set<(bytes: Uint8Array) => void>());
  const outputCache = useRef(new Uint8Array());
  const telnet = useRef(new TelnetDecoder());
  const channel = useMemo<TerminalChannel>(() => ({
    write: data => { const bytes = new TextEncoder().encode(data); return transport.write(Uint8Array.from(Array.from(bytes).flatMap(b => b === 255 ? [255,255] : [b]))); },
    subscribe: fn => { listeners.current.add(fn); if(outputCache.current.length)fn(outputCache.current); return () => { listeners.current.delete(fn); }; },
  }), [transport]);
  useEffect(() => {
    let mounted = true, opening = false, active = false, fallback = false;
    const mode = getSimulatorTransportMode();
    if (mode === 'usb') { setLegacy(true); return; }
    transport.onStatus = (status, message) => { active=status;if(mounted){setConnected(status);if(message)setError(message);} };
    transport.onPacket = bytes => {const data=telnet.current.push(bytes);if(data.reply.length)void transport.write(data.reply).catch(e=>{if(mounted)setError(String(e));});if(data.bytes.length){const cache=new Uint8Array(outputCache.current.length+data.bytes.length);cache.set(outputCache.current);cache.set(data.bytes,outputCache.current.length);outputCache.current=cache.slice(-256*1024);listeners.current.forEach(fn=>fn(data.bytes));}};
    const attach = async () => {
      if(!mounted||opening||active||fallback)return;opening=true;
      try {
        const endpoint=await invoke<{host:string;port:number}|null>('tool_simulator_nsh_target');if(!mounted)return;const host=endpoint?.host;
        if(!host){if(mode==='auto'){fallback=true;setLegacy(true);}else setTarget('等待仿真机网络终端');return;}
        setTarget('仿真机 '+host+' · TCP / Telnet');telnet.current=new TelnetDecoder();
        await transport.open({network:{mode:'tcpClient',host,port:endpoint!.port,localHost:'0.0.0.0',localPort:0}});
        if(!mounted){await transport.close();return;}
        setError('');await channel.write('\r');
      }catch(e){if(mounted){if(mode==='auto'){fallback=true;setLegacy(true);}else setError(String(e));}}finally{opening=false;}
    };
    void attach();const timer=setInterval(()=>void attach(),2500);
    return()=>{mounted=false;clearInterval(timer);void transport.write(new TextEncoder().encode('\x03exit\n')).catch(()=>{}).finally(()=>transport.close().catch(()=>{}));};
  },[transport,channel]);
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

  if (legacy) return <NshCommandConsoleDialog onClose={onClose}/>;
  return <div className="nsh-console-overlay" role="dialog" aria-label="NuttX NSH 控制台" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="nsh-console" style={position ? { position: 'fixed', left: position.left, top: position.top, margin: 0 } : undefined} onMouseDown={event => event.stopPropagation()}>
      <header onPointerDown={beginDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}><div><b>⌨ NuttX NSH 控制台</b><small>{target} · 持续交互会话 · 标题栏拖动 · 右下角缩放</small></div><button onClick={onClose}>×</button></header>
      {error && <div className="nsh-terminal-error" role="alert">{error}</div>}
      <NshTerminal channel={channel} connected={connected} />
      <span className="nsh-resize-corner" aria-hidden="true" />
    </section>
  </div>;
}
