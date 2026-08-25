import { useState, useEffect, useRef } from 'react';
import { useSimSocket } from '../sim/useSimSocket';
import PropertyTree from './PropertyTree';
import Dashboard from './Dashboard';

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

  // Drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.live-window-controls')) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, posX: position.x, posY: position.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPosition({ x: dragStart.current.posX + dx, y: dragStart.current.posY + dy });
    } else if (isResizing) {
      const dx = e.clientX - resizeStart.current.x;
      const dy = e.clientY - resizeStart.current.y;
      setSize({
        width: Math.max(600, resizeStart.current.width + dx),
        height: Math.max(400, resizeStart.current.height + dy),
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setIsResizing(false);
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
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
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Title bar - draggable */}
      <div
        className="live-titlebar"
        onMouseDown={handleMouseDown}
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

      {/* Content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left panel: Property tree */}
        <div style={{ width: '45%', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
            属性浏览器
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
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
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
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
