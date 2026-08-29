import { useState, useEffect, useRef } from 'react';
import { useSimSocket } from '../sim/useSimSocket';
import PropertyTree from './PropertyTree';
import Dashboard from './Dashboard';
import FlightHud from './FlightHud';

const PINNED_STORAGE_KEY = 'jsbsim-pinned-properties';
const UNIT_STORAGE_KEY = 'jsbsim-unit-system';

export type UnitSystem = 'imperial' | 'metric';

interface LiveViewProps {
  onClose: () => void;
}

export default function LiveView({ onClose }: LiveViewProps) {
  const { telemetry, connected } = useSimSocket();
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(PINNED_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => {
    try {
      return (localStorage.getItem(UNIT_STORAGE_KEY) as UnitSystem) || 'imperial';
    } catch {
      return 'imperial';
    }
  });
  const [propertyBrowserCollapsed, setPropertyBrowserCollapsed] = useState(true);

  // Floating window state
  const [position, setPosition] = useState({ x: 100, y: 80 });
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 });

  // Persist pinned properties to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedPaths));
    } catch {
      // ignore
    }
  }, [pinnedPaths]);

  // Persist unit system
  useEffect(() => {
    try {
      localStorage.setItem(UNIT_STORAGE_KEY, unitSystem);
    } catch {
      // ignore
    }
  }, [unitSystem]);

  const handlePin = (path: string) => {
    setPinnedPaths(prev => prev.includes(path) ? prev : [...prev, path]);
  };

  const handleUnpin = (path: string) => {
    setPinnedPaths(prev => prev.filter(p => p !== path));
  };

  const toggleUnit = () => {
    setUnitSystem(prev => prev === 'imperial' ? 'metric' : 'imperial');
  };

  // Keep the gesture alive even when the pointer leaves the floating window.
  // Listening on window also avoids losing the last few pixels of a fast drag.
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        setPosition({ x: dragStart.current.posX + dx, y: dragStart.current.posY + dy });
      } else {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        setSize({
          width: Math.max(600, resizeStart.current.width + dx),
          height: Math.max(400, resizeStart.current.height + dy),
        });
      }
    };
    const stopGesture = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopGesture);
    window.addEventListener('pointercancel', stopGesture);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopGesture);
      window.removeEventListener('pointercancel', stopGesture);
    };
  }, [isDragging, isResizing]);

  // Drag handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.live-window-controls')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, posX: position.x, posY: position.y };
  };

  const handleResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setIsResizing(true);
    resizeStart.current = { x: e.clientX, y: e.clientY, width: size.width, height: size.height };
  };

  return (
    <div
      className="live-window"
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar - draggable */}
      <div
        className="live-titlebar"
        onPointerDown={handlePointerDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 16 }}>📊</span>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
            JSBSim 属性树
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {connected ? `已连接 · ${telemetry?.t?.toFixed(1) ?? '0.0'}s` : '未连接'}
          </span>
        </div>
        <div className="live-window-controls" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={toggleUnit}
            style={{
              padding: '5px 10px',
              background: unitSystem === 'metric' ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: unitSystem === 'metric' ? '#fff' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
            title={unitSystem === 'metric' ? '切换到英制' : '切换到公制'}
          >
            {unitSystem === 'metric' ? '🇨🇳 公制' : '🇺🇸 英制'}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '5px 10px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      <FlightHud telemetry={telemetry} connected={connected} />

      {/* Content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left panel: Property tree */}
        <div className="live-property-panel" style={{ width: propertyBrowserCollapsed ? 42 : '45%', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
          <div className="live-property-header" style={{ padding: propertyBrowserCollapsed ? '8px 4px' : '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
            <button type="button" onClick={() => setPropertyBrowserCollapsed(value => !value)} title={propertyBrowserCollapsed ? '展开属性浏览器' : '折叠属性浏览器'} style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
              {propertyBrowserCollapsed ? '▶' : '◀'}{!propertyBrowserCollapsed && ' 属性浏览器'}
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: propertyBrowserCollapsed ? 'none' : 'block' }}>
            <PropertyTree
              telemetry={telemetry}
              pinnedPaths={pinnedPaths}
              onPin={handlePin}
              onUnpin={handleUnpin}
              unitSystem={unitSystem}
            />
          </div>
        </div>

        {/* Right panel: Dashboard */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
            仪表盘
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Dashboard
              telemetry={telemetry}
              pinnedPaths={pinnedPaths}
              onUnpin={handleUnpin}
              unitSystem={unitSystem}
            />
            <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px 12px', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 8 }}>
                NuttX 任务统计 · Top 12 · 1 Hz
              </div>
              {telemetry?.task_top?.tasks?.length ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  <thead style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <tr><th>任务</th><th>PID</th><th>CPU</th><th>负载</th><th>栈</th><th>状态</th></tr>
                  </thead>
                  <tbody>
                    {telemetry.task_top.tasks.map(task => (
                      <tr key={task.pid} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px 2px', fontWeight: 600 }}>{task.name}</td>
                        <td>{task.pid}</td><td>{task.cpu}</td><td style={{ color: task.load >= 80 ? '#ef4444' : 'var(--accent)' }}>{task.load.toFixed(1)}%</td>
                        <td>{task.stack_used}/{task.stack_size}</td><td>{task.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>等待 NuttX top 遥测…</div>}
            </div>
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div
          onPointerDown={handleResizeStart}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 20,
          height: 20,
          cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 50%, var(--text-muted) 50%)',
          opacity: 0.3,
        }}
      />
    </div>
  );
}
