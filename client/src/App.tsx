import { useState, useCallback, useEffect, useRef, Component, type ReactNode, Suspense } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import Palette from './components/Palette';
import Canvas from './components/Canvas';
import PropertyPanel from './components/PropertyPanel';
import FileManager from './components/FileManager';
import ModuleExpressionCanvas from './components/expression/ModuleExpressionCanvas';
import Airplane3DViewer from './components/Airplane3DViewer';
import LiveView from './components/LiveView';
import { useFlowStore } from './store/flowStore';
import type { ComponentType } from './types';
import './App.css';

// Check WebGL before loading Three.js - must actually work, not just exist
function checkWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return false;
    // Verify the context is actually functional
    const glCtx = gl as WebGLRenderingContext;
    glCtx.clearColor(0, 0, 0, 0);
    glCtx.clear(glCtx.COLOR_BUFFER_BIT);
    // Check for essential extensions/capabilities
    const maxTexSize = glCtx.getParameter(glCtx.MAX_TEXTURE_SIZE);
    return maxTexSize > 0 && maxTexSize < 100000;
  } catch { return false; }
}

// Global error boundary
class GlobalErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error, info: any) {
    console.error('[GlobalError]', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100vw', height: '100vh', background: '#f5f7fa', fontFamily: 'sans-serif' }}>
          <div style={{ textAlign: 'center', padding: 40, background: '#fff',
            borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.1)', maxWidth: 500 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ color: '#1a2332', marginBottom: 8, fontSize: 18 }}>应用发生错误</h2>
            <p style={{ color: '#6b7b8d', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
              {this.state.error}
            </p>
            <button onClick={() => { this.setState({ hasError: false, error: '' }); window.location.reload(); }}
              style={{ padding: '10px 24px', background: '#3b82f6', color: '#fff', border: 'none',
                borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Safety boundary: catches Three.js crashes and auto-closes the 3D viewer
class Viewer3DSafety extends Component<{ children: ReactNode; onClose: () => void }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode; onClose: () => void }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error) {
    console.error('[3D Viewer Error]', error);
    // Auto-close after a brief delay so user sees the error
    setTimeout(() => this.props.onClose(), 100);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="viewer3d-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#fff', padding: 40, maxWidth: 400 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ marginBottom: 8 }}>3D 渲染失败</h2>
            <p style={{ color: '#aaa', marginBottom: 20, fontSize: 13 }}>{this.state.error}</p>
            <p style={{ color: '#888', marginBottom: 20, fontSize: 12 }}>
              可能原因：浏览器不支持 WebGL、显卡驱动过旧、或运行在远程/虚拟环境中
            </p>
            <button onClick={this.props.onClose} style={{
              padding: '10px 24px', background: '#3b82f6', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
            }}>← 返回编辑器</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [showJsbsimLog, setShowJsbsimLog] = useState(false);
  const [jsbsimLogs, setJsbsimLogs] = useState<string[]>([]);
  const [dragType, setDragType] = useState<ComponentType | null>(null);
  const [show3D, setShow3D] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [webglFail, setWebglFail] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-restore from localStorage on mount
  const CACHE_VERSION = 2;
  useEffect(() => {
    try {
      const ver = Number(localStorage.getItem('jsbsim-cache-version') || '0');
      if (ver < CACHE_VERSION) {
        localStorage.removeItem('jsbsim-project');
        localStorage.removeItem('jsbsim-raw-xml');
        localStorage.setItem('jsbsim-cache-version', String(CACHE_VERSION));
        return;
      }
      const saved = localStorage.getItem('jsbsim-project');
      if (saved) {
        const data = JSON.parse(saved);
        if (data && data.nodes && data.nodes.length > 0) {
          useFlowStore.getState().loadProject(data);
        }
      }
    } catch (e) {
      console.warn('[Restore] Failed to load from localStorage:', e);
    }
  }, []);

  // Auto-save to localStorage on state changes (debounced)
  useEffect(() => {
    const unsub = useFlowStore.subscribe((state) => {
      if (state.nodes.length === 0) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        try {
          const { nodes, edges, aircraft, subFiles } = useFlowStore.getState();
          localStorage.setItem('jsbsim-project', JSON.stringify({ nodes, edges, aircraft, subFiles }));
        } catch (e) {
          console.warn('[AutoSave] Failed:', e);
        }
      }, 500);
    });
    return () => { unsub(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const handleDragStart = useCallback((type: ComponentType) => {
    setDragType(type);
  }, []);

  const handleShow3D = useCallback(() => {
    if (!checkWebGL()) {
      setWebglFail(true);
      return;
    }
    setShow3D(true);
  }, []);

  // Module (flight_control / system) drill-down: when a module node is focused,
  // the main workspace area is replaced by its internal signal-flow canvas.
  const focusedNode = useFlowStore((s) => s.nodes.find((n) => n.id === s.focusedNodeId) || null);
  const setFocusedNodeId = useFlowStore((s) => s.setFocusedNodeId);
  const updateNodeParams = useFlowStore((s) => s.updateNodeParams);
  const focusedModule =
    focusedNode &&
    (focusedNode.data.componentType === 'system' || focusedNode.data.componentType === 'flight_control') &&
    focusedNode.data.params?.channels
      ? focusedNode
      : null;
  let focusedChannels: any[] = [];
  let focusedLayout: Record<string, { x: number; y: number }> | undefined;
  if (focusedModule) {
    try {
      const parsed = JSON.parse(focusedModule.data.params.channels);
      if (Array.isArray(parsed)) focusedChannels = parsed;
    } catch { /* ignore malformed */ }
    try {
      if (focusedModule.data.params.layout) {
        const lp = JSON.parse(focusedModule.data.params.layout);
        if (lp && typeof lp === 'object') focusedLayout = lp;
      }
    } catch { /* ignore malformed */ }
  }

  return (
    <div className="app">
      <Toolbar onShow3D={handleShow3D} onShowLive={() => setShowLive(true)}
        jsbsimLogs={jsbsimLogs}
        onToggleJsbsimLog={() => setShowJsbsimLog(value => !value)}
        onLog={(line) => setJsbsimLogs(lines => [...lines, line].slice(-200))} />
      <div className="main-content">
        {focusedModule ? (
          <ModuleExpressionCanvas
            embedded
            mode="signal"
            title={`${focusedModule.data.componentType === 'flight_control' ? '飞控' : '系统'} 信号流`}
            channels={focusedChannels}
            topLevelProps={(focusedModule.data.params.properties || '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)}
            modelId={focusedModule.id}
            initialLayout={focusedLayout}
            onChannelsChange={(chs) => updateNodeParams(focusedModule.id, { channels: JSON.stringify(chs) })}
            onLayoutChange={(layout) => updateNodeParams(focusedModule.id, { layout: JSON.stringify(layout) })}
            onBack={() => setFocusedNodeId(null)}
          />
        ) : (
          <>
            <Palette onDragStart={handleDragStart} />
            <Canvas dragType={dragType} onDragStart={handleDragStart} />
            <div className="right-sidebar">
              {showJsbsimLog ? (
                <div className="jsbsim-log-sidebar">
                  <div className="jsbsim-log-sidebar-head"><span>🖥️ JSBSim 信息</span><button onClick={() => setShowJsbsimLog(false)}>×</button></div>
                  <div className="sim-log-window jsbsim-log-sidebar-window">
                    {jsbsimLogs.length === 0 ? <span className="sim-log-empty">暂无信息</span> : jsbsimLogs.map((line, i) => <div key={`${i}-${line}`} className="sim-log-line">{line}</div>)}
                  </div>
                </div>
              ) : <><PropertyPanel /><FileManager /></>}
            </div>
          </>
        )}
      </div>

      {/* WebGL not available dialog */}
      {webglFail && (
        <div className="viewer3d-overlay" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#fff', padding: 40, maxWidth: 400 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🖥️</div>
            <h2 style={{ marginBottom: 8 }}>WebGL 不可用</h2>
            <p style={{ color: '#aaa', marginBottom: 20, lineHeight: 1.6 }}>
              您的浏览器不支持 WebGL 3D 渲染。<br />
              请尝试使用最新版 Chrome / Firefox / Edge 浏览器。
            </p>
            <button onClick={() => setWebglFail(false)} style={{
              padding: '10px 24px', background: '#3b82f6', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
            }}>← 返回编辑器</button>
          </div>
        </div>
      )}

      {/* 3D Viewer overlay with safety error boundary */}
      {show3D && (
        <Suspense fallback={
          <div className="viewer3d-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ color: '#fff', fontSize: 16 }}>🛩️ 加载 3D 引擎...</div>
          </div>
        }>
          <Viewer3DSafety onClose={() => setShow3D(false)}>
            <Airplane3DViewer onClose={() => setShow3D(false)} />
          </Viewer3DSafety>
        </Suspense>
      )}

      {/* 实时融合显示 overlay */}
      {showLive && (
        <Suspense fallback={
          <div className="viewer3d-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ color: '#fff', fontSize: 16 }}>🔴 连接仿真机...</div>
          </div>
        }>
          <Viewer3DSafety onClose={() => setShowLive(false)}>
            <LiveView onClose={() => setShowLive(false)} />
          </Viewer3DSafety>
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  return (
    <GlobalErrorBoundary>
      <ReactFlowProvider>
        <AppContent />
      </ReactFlowProvider>
    </GlobalErrorBoundary>
  );
}
