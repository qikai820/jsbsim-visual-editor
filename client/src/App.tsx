import { useState, useCallback, useEffect, useRef, Component, type ReactNode, lazy, Suspense } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import Palette from './components/Palette';
import Canvas from './components/Canvas';
import PropertyPanel from './components/PropertyPanel';
import FileManager from './components/FileManager';
import { useFlowStore } from './store/flowStore';
import type { ComponentType } from './types';
import './App.css';

// Lazy load 3D viewer with error-safe wrapper
const Airplane3DViewer = lazy(() =>
  import('./components/Airplane3DViewer').catch(err => {
    console.error('[3D] Failed to load viewer:', err);
    // Return a fallback component that shows the error
    return {
      default: ({ onClose }: { onClose: () => void }) => (
        <div className="viewer3d-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#fff', padding: 40, maxWidth: 420 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ marginBottom: 8 }}>3D 引擎加载失败</h2>
            <p style={{ color: '#aaa', marginBottom: 12, fontSize: 13 }}>
              {err?.message || 'Three.js 加载出错'}
            </p>
            <p style={{ color: '#888', marginBottom: 20, fontSize: 12 }}>
              可能原因：浏览器不支持 WebGL、显卡驱动过旧、或运行在远程/虚拟环境中。<br />
              请尝试使用最新版 Chrome / Firefox / Edge 浏览器。
            </p>
            <button onClick={onClose} style={{
              padding: '10px 24px', background: '#3b82f6', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
            }}>← 返回编辑器</button>
          </div>
        </div>
      ),
    };
  })
);

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
  const [dragType, setDragType] = useState<ComponentType | null>(null);
  const [show3D, setShow3D] = useState(false);
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

  return (
    <div className="app">
      <Toolbar onShow3D={handleShow3D} />
      <div className="main-content">
        <Palette onDragStart={handleDragStart} />
        <Canvas dragType={dragType} onDragStart={handleDragStart} />
        <div className="right-sidebar">
          <PropertyPanel />
          <FileManager />
        </div>
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
