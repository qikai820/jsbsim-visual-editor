import { useState, useCallback, Component, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import Palette from './components/Palette';
import Canvas from './components/Canvas';
import PropertyPanel from './components/PropertyPanel';
import FileManager from './components/FileManager';
import type { ComponentType } from './types';
import './App.css';

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

function AppContent() {
  const [dragType, setDragType] = useState<ComponentType | null>(null);

  const handleDragStart = useCallback((type: ComponentType) => {
    setDragType(type);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="main-content">
        <Palette onDragStart={handleDragStart} />
        <Canvas dragType={dragType} onDragStart={handleDragStart} />
        <div className="right-sidebar">
          <PropertyPanel />
          <FileManager />
        </div>
      </div>
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
