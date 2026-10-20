import { useState, useCallback, useEffect, useRef, Component, type ReactNode, Suspense } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import Toolbar from './components/Toolbar';
import XmlDiagnosticDialog from './components/XmlDiagnosticDialog';
import Palette from './components/Palette';
import Canvas from './components/Canvas';
import PropertyPanel from './components/PropertyPanel';
import FileManager from './components/FileManager';
import ModuleExpressionCanvas from './components/expression/ModuleExpressionCanvas';
import Airplane3DViewer from './components/Airplane3DViewer';
import FlightHud from './components/FlightHud';
import LogCenter from './components/LogCenter';
import MultiSimPanel from './components/MultiSimPanel';
import { useSimSocket, type Telemetry } from './sim/useSimSocket';
import { resolveNodeOwnedPath, useFlowStore } from './store/flowStore';
import type { ComponentType } from './types';
import './App.css';
import { initializeSimulatorTransport, isTauri, listenJsbsimLog, simInstanceControl, simInstanceSnapshot, simSyncTime, usbConsoleRead, type SimInstanceSummary } from './utils/tauriApi';
import { systemCanvasChannels, splitSystemCanvasChannels } from './utils/systemSignalCanvas';
import { extractOutputSignal, type ChannelItem } from './utils/signalGraph';
import { installDialogDragging } from './utils/dialogDragging';
import { normalizeFleetInitialOverrides, normalizeFleetNetworkOverrides, type FleetInitialOverrides, type FleetNetworkOverrides, type FleetModelGroup } from './utils/fleetModelGroups';

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

// Aerodynamic functions use the same expression language as FCS functions.
// Adapt them to channels so the signal-flow canvas can visualise dependencies
// between coefficients and external aerodynamic properties.
function aeroCoefficientsToChannels(coefficients: any[]): any[] {
  const containsTable = (expr: any): boolean => {
    if (!expr || typeof expr !== 'object') return false;
    if (expr.kind === 'table') return true;
    return Object.values(expr).some(value => Array.isArray(value)
      ? value.some(containsTable)
      : value && typeof value === 'object' && containsTable(value));
  };
  const byAxis = new Map<string, any[]>();
  for (const coefficient of coefficients) {
    const axis = String(coefficient?.axis || 'LIFT').toUpperCase();
    if (!byAxis.has(axis)) byAxis.set(axis, []);
    byAxis.get(axis)!.push({
      type: containsTable(coefficient?.expression) ? 'aero_table' : 'function',
      name: coefficient?.name || `coefficient-${byAxis.get(axis)!.length + 1}`,
      expression: coefficient?.expression || { kind: 'value', value: 0 },
    });
  }
  return [...byAxis.entries()].map(([name, items]) => ({ name, items }));
}

function channelsToAeroCoefficients(channels: any[], previous: any[]): any[] {
  const metadata = new Map(previous.map(c => [String(c?.name || ''), c]));
  const coefficients: any[] = [];
  for (const channel of channels || []) {
    const axis = String(channel?.name || 'LIFT').toUpperCase();
    for (const item of channel?.items || []) {
      const name = String(item?.name || '');
      if (!name) continue;
      const old = metadata.get(name);
      coefficients.push({
        name,
        axis,
        description: old?.description || '',
        expression: item?.expression || old?.expression || { kind: 'value', value: 0 },
      });
    }
  }
  return coefficients;
}

function findPropertyProducer(signal: string): { moduleId: string; componentId: string; label: string } | null {
  const matches: { moduleId: string; componentId: string; label: string }[] = [];
  for (const node of useFlowStore.getState().nodes) {
    if (node.data.componentType !== 'system' && node.data.componentType !== 'flight_control') continue;
    let channels: any[];
    try { channels = JSON.parse(node.data.params.channels || '[]'); }
    catch { continue; }
    if (!Array.isArray(channels)) continue;
    channels.forEach((channel, ci) => (channel.items || []).forEach((item: ChannelItem, ii: number) => {
      if ((item.type === 'function' || item.type === 'fcs_function') &&
          extractOutputSignal(item) === signal) {
        matches.push({
          moduleId: node.id,
          componentId: `c-${ci}-${ii}`,
          label: String(node.data.label || node.data.params.name || channel.name || '系统'),
        });
      }
    }));
  }
  return matches.length === 1 ? matches[0] : null;
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

const INSTANCE_IDS = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0'));
const SLOT_KEY = 'jsbsim-multi-model-slots-v1';
const INITIAL_OVERRIDE_KEY = 'jsbsim-multi-initial-overrides-v1';
const NETWORK_OVERRIDE_KEY = 'jsbsim-multi-network-overrides-v1';
function savedInitialOverrides(): FleetInitialOverrides {
  try { return normalizeFleetInitialOverrides(JSON.parse(localStorage.getItem(INITIAL_OVERRIDE_KEY) || '{}')); }
  catch { return {}; }
}
function savedNetworkOverrides(): FleetNetworkOverrides {
  try { return normalizeFleetNetworkOverrides(JSON.parse(localStorage.getItem(NETWORK_OVERRIDE_KEY) || '{}')); }
  catch { return {}; }
}
function savedInstanceSlots(): Record<string, string> {
  try {
    const stored = localStorage.getItem(SLOT_KEY);
    const value = JSON.parse(stored || '{}');
    const slots = Object.fromEntries(INSTANCE_IDS.map(id => [id, typeof value?.[id] === 'string' ? value[id] : '']));
    if (!stored && !slots['01']) slots['01'] = localStorage.getItem('jsbsim-remote-model') || '';
    return slots;
  } catch {
    return Object.fromEntries(INSTANCE_IDS.map(id => [id, '']));
  }
}

function AppContent() {
  useEffect(installDialogDragging, []);
  const selectedNodeId = useFlowStore(state => state.selectedNodeId);
  const editingSubFileId = useFlowStore(state => state.editingSubFileId);
  const [showJsbsimLog, setShowJsbsimLog] = useState(false);
  const [jsbsimLogs, setJsbsimLogs] = useState<string[]>([]);
  const [showNshPrints, setShowNshPrints] = useState(() => localStorage.getItem('jsbsim-log-show-nsh') === 'true');
  const nshCursor = useRef(0);
  const [xmlChangeNotice, setXmlChangeNotice] = useState<string[]>([]);
  const [modifiedXmlFiles, setModifiedXmlFiles] = useState<string[]>([]);
  const xmlNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [logReservedHeight, setLogReservedHeight] = useState(82);
  const [dragType, setDragType] = useState<ComponentType | null>(null);
  const [paletteCollapsed, setPaletteCollapsed] = useState(() => localStorage.getItem('jsbsim-palette-collapsed') === 'true');
  const [paletteWidth, setPaletteWidth] = useState(() => Number(localStorage.getItem('jsbsim-palette-width') || 250));
  const paletteResize = useRef<{ x: number; width: number } | null>(null);
  const [show3D, setShow3D] = useState(false);
  const [showLogCenter, setShowLogCenter] = useState(false);
  const [workspace, setWorkspace] = useState<'editor' | 'multi'>(() =>
    new URLSearchParams(window.location.search).get('workspace') === 'multi' ? 'multi' : 'editor');
  const [multiConfigEdited, setMultiConfigEdited] = useState(false);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetError, setFleetError] = useState('');
  const [fleetState, setFleetState] = useState({ running: 0, paused: 0 });
  const [activeInstance, setActiveInstance] = useState('01');
  const [multiSelectedInstance, setMultiSelectedInstance] = useState('01');
  const [instanceSlots, setInstanceSlots] = useState(savedInstanceSlots);
  const [initialOverrides, setInitialOverrides] = useState(savedInitialOverrides);
  const [networkOverrides, setNetworkOverrides] = useState(savedNetworkOverrides);
  const [editorSwitchRequest, setEditorSwitchRequest] = useState<string | null>(null);
  const [sourceJump, setSourceJump] = useState<{ moduleId: string; componentId: string } | null>(null);
  const [webglFail, setWebglFail] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logWindowRef = useRef<HTMLDivElement | null>(null);
  const followLogTailRef = useRef(true);
  const { telemetry, connected } = useSimSocket();
  const [editorSnapshot, setEditorSnapshot] = useState<SimInstanceSummary | null>(null);
  useEffect(() => {
    if (!isTauri || workspace !== 'editor' || activeInstance === '01') { setEditorSnapshot(null); return; }
    let active = true;
    setEditorSnapshot(null);
    const refresh = () => { void simInstanceSnapshot(activeInstance)
      .then(value => { if (active) setEditorSnapshot(value); })
      .catch(() => { if (active) setEditorSnapshot(null); }); };
    refresh();
    const timer = window.setInterval(refresh, 750);
    return () => { active = false; window.clearInterval(timer); };
  }, [workspace, activeInstance]);
  const hudTelemetry: Telemetry | null = activeInstance === '01' ? telemetry : editorSnapshot && editorSnapshot.instance_id === activeInstance
    ? { ...editorSnapshot.properties, t: editorSnapshot.timestamp, model: editorSnapshot.model,
        altitude_m: editorSnapshot.altitude_m, airspeed_mps: editorSnapshot.airspeed_mps,
        groundspeed_mps: editorSnapshot.groundspeed_mps } : null;
  const hudConnected = activeInstance === '01' ? connected : connected && !!editorSnapshot &&
    editorSnapshot.instance_id === activeInstance && (editorSnapshot.age_ms ?? Infinity) < 2000;
  const [logPos, setLogPos] = useState<{ x: number; y: number }>(() => JSON.parse(localStorage.getItem('jsbsim-log-position') || '{"x":0,"y":0}'));
  const logDrag = useRef({ x: 0, y: 0, left: 0, top: 0 });
  const [draggingLog, setDraggingLog] = useState(false);
  const [hudPos, setHudPos] = useState<{ x: number; y: number }>(() => JSON.parse(localStorage.getItem('jsbsim-hud-position') || '{"x":0,"y":0}'));
  const [hudVisible, setHudVisible] = useState(() => localStorage.getItem('jsbsim-hud-visible') !== 'false');
  const [draggingHud, setDraggingHud] = useState(false);
  const hudDrag = useRef({ x: 0, y: 0, left: 0, top: 0 });
  const undoStack = useRef<any[]>([]);
  const redoStack = useRef<any[]>([]);
  const historyCurrent = useRef<any>(null);
  const historyBurst = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingHistory = useRef(false);
  const copiedNode = useRef<any>(null);

  useEffect(() => { localStorage.setItem(SLOT_KEY, JSON.stringify(instanceSlots)); }, [instanceSlots]);
  useEffect(() => { localStorage.setItem(INITIAL_OVERRIDE_KEY, JSON.stringify(initialOverrides)); }, [initialOverrides]);
  useEffect(() => { localStorage.setItem(NETWORK_OVERRIDE_KEY, JSON.stringify(networkOverrides)); }, [networkOverrides]);
  useEffect(() => { localStorage.setItem('jsbsim-palette-collapsed', String(paletteCollapsed)); }, [paletteCollapsed]);
  useEffect(() => { localStorage.setItem('jsbsim-palette-width', String(paletteWidth)); }, [paletteWidth]);
  useEffect(() => { localStorage.setItem('jsbsim-hud-position', JSON.stringify(hudPos)); }, [hudPos]);
  useEffect(() => { localStorage.setItem('jsbsim-hud-visible', String(hudVisible)); }, [hudVisible]);
  useEffect(() => { localStorage.setItem('jsbsim-log-position', JSON.stringify(logPos)); }, [logPos]);
  useEffect(() => {
    void initializeSimulatorTransport().catch(error => {
      console.error('[transport] unable to apply saved simulator transport', error);
    });
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    const synchronize = () => {
      const threshold = Math.max(1, Number(localStorage.getItem('jsbsim-time-sync-threshold-secs') || 60));
      void simSyncTime(threshold).then(result => {
        if (active && result.synchronized) {
          setJsbsimLogs(lines => [...lines, `[${new Date().toLocaleTimeString()}] 已自动同步仿真机时间（偏差 ${result.differenceSeconds}s）`].slice(-200));
        }
      }).catch(() => { /* board may not have sent telemetry yet */ });
    };
    synchronize();
    const timer = window.setInterval(synchronize, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const restore = (event: Event) => {
      const settings = (event as CustomEvent).detail || {};
      setPaletteCollapsed(!!settings.paletteCollapsed);
      setPaletteWidth(Number(settings.paletteWidth || 250));
      setHudPos(settings.hudPosition || { x: 0, y: 0 });
      setLogPos(settings.logPosition || { x: 0, y: 0 });
    };
    window.addEventListener('jsbsim-project-settings-loaded', restore);
    return () => window.removeEventListener('jsbsim-project-settings-loaded', restore);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!paletteResize.current) return;
      setPaletteWidth(Math.max(180, Math.min(420, paletteResize.current.width + e.clientX - paletteResize.current.x)));
    };
    const up = () => { paletteResize.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  const snapshotProject = useCallback(() => {
    const state = useFlowStore.getState();
    return { nodes: state.nodes, edges: state.edges, aircraft: state.aircraft, subFiles: state.subFiles, xmlFiles: state.xmlFiles };
  }, []);

  useEffect(() => {
    historyCurrent.current = snapshotProject();
    return useFlowStore.subscribe(state => {
      const next = { nodes: state.nodes, edges: state.edges, aircraft: state.aircraft, subFiles: state.subFiles, xmlFiles: state.xmlFiles };
      if (applyingHistory.current || JSON.stringify(next) === JSON.stringify(historyCurrent.current)) return;
      const previous = historyCurrent.current;
      // Loading another aircraft replaces the whole project in one store
      // update. That is navigation, not an edit to the newly selected model;
      // otherwise the old model's graph is reported as a local XML change.
      const previousMainPath = previous?.xmlFiles?.find((file: any) => file.category === 'main')?.path;
      const nextMainPath = next.xmlFiles?.find((file: any) => file.category === 'main')?.path;
      if (previous && (previous.aircraft?.name !== next.aircraft?.name || previousMainPath !== nextMainPath)) {
        historyCurrent.current = next;
        undoStack.current = [];
        redoStack.current = [];
        if (historyBurst.current) clearTimeout(historyBurst.current);
        historyBurst.current = null;
        setModifiedXmlFiles([]);
        return;
      }
      if (previous) {
        const mainFile = (state.xmlFiles || []).find(file => file.category === 'main')?.path ||
          `${state.aircraft.name || 'aircraft'}.xml`;
        const files = new Set<string>();
        if (JSON.stringify(previous.aircraft) !== JSON.stringify(next.aircraft) || JSON.stringify(previous.edges) !== JSON.stringify(next.edges)) files.add(mainFile);
        const previousNodes = new Map((previous.nodes || []).map((node: any) => [node.id, node]));
        if ((previous.nodes || []).length !== next.nodes.length) files.add(mainFile);
        for (const node of next.nodes) {
          const oldNode: any = previousNodes.get(node.id);
          const xmlData = (data: any) => ({
            ...data,
            params: Object.fromEntries(Object.entries(data?.params || {}).filter(([key]) => key !== 'layout')),
          });
          if (oldNode && JSON.stringify(xmlData(oldNode.data)) === JSON.stringify(xmlData(node.data))) continue;
          const type = node.data?.componentType;
          if (['input', 'output', 'uavcan', 'serial_hil'].includes(type)) files.add(mainFile);
          if (type === 'serial_sensor') files.add(`config/models/${state.aircraft.name}.serial.xml`);
          if (type === 'pwm_capture') files.add(`config/models/${state.aircraft.name}.pwm.xml`);
          const rawSource = resolveNodeOwnedPath(node as any) || node.data?.params?.source?.path;
          if (rawSource) {
            const source = String(rawSource).includes('/') ? String(rawSource) :
              (type === 'system' || type === 'flight_control' ? `systems/${rawSource}` :
                type === 'engine' || type === 'propeller' ? `engine/${rawSource}` : String(rawSource));
            files.add(source.toLowerCase().endsWith('.xml') ? source : `${source}.xml`);
          }
        }
        for (const oldNode of previous.nodes || []) {
          if (next.nodes.some(node => node.id === oldNode.id)) continue;
          if (oldNode.data?.componentType === 'serial_sensor') files.add(`config/models/${state.aircraft.name}.serial.xml`);
          if (oldNode.data?.componentType === 'pwm_capture') files.add(`config/models/${state.aircraft.name}.pwm.xml`);
        }
        const previousSubFiles = new Map((previous.subFiles || []).map((file: any) => [file.id, file]));
        for (const file of next.subFiles) {
          if (JSON.stringify(previousSubFiles.get(file.id)) !== JSON.stringify(file)) files.add(file.fileName.toLowerCase().endsWith('.xml') ? file.fileName : `${file.fileName}.xml`);
        }
        if ((previous.subFiles || []).length !== next.subFiles.length) {
          const currentNames = next.subFiles.map(file => file.fileName.toLowerCase().endsWith('.xml') ? file.fileName : `${file.fileName}.xml`);
          currentNames.forEach(file => files.add(file));
          files.add(mainFile);
        }
        if (files.size) {
          const changed = Array.from(files);
          setXmlChangeNotice(changed);
          // An external system edit supersedes stale main-file notices left
          // by an earlier edit in the same session. Otherwise the toast can
          // keep showing aircraft/F450/F450.xml even though the current edit
          // belongs to systems/SensorImu.xml.
          const hasExternalChange = changed.some(file => !file.endsWith(`${mainFile}`) && !file.endsWith(`/${mainFile}`));
          setModifiedXmlFiles(current => {
            const cleaned = hasExternalChange
              ? current.filter(file => !file.endsWith(`${mainFile}`) && !file.endsWith(`/${mainFile}`))
              : current;
            return Array.from(new Set([...cleaned, ...changed]));
          });
          if (xmlNoticeTimer.current) clearTimeout(xmlNoticeTimer.current);
          xmlNoticeTimer.current = setTimeout(() => setXmlChangeNotice([]), 3600);
        }
      }
      if (!historyBurst.current && historyCurrent.current) undoStack.current.push(historyCurrent.current);
      redoStack.current = [];
      historyCurrent.current = next;
      if (historyBurst.current) clearTimeout(historyBurst.current);
      historyBurst.current = setTimeout(() => { historyBurst.current = null; }, 250);
    });
  }, [snapshotProject]);

  const applySnapshot = useCallback((snapshot: any) => {
    applyingHistory.current = true;
    useFlowStore.setState({ ...snapshot, selectedNodeId: null, focusedNodeId: null });
    historyCurrent.current = snapshot;
    queueMicrotask(() => { applyingHistory.current = false; });
  }, []);
  const handleUndo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(snapshotProject());
    applySnapshot(previous);
  }, [applySnapshot, snapshotProject]);
  const handleRedo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(snapshotProject());
    applySnapshot(next);
  }, [applySnapshot, snapshotProject]);
  const handleCopy = useCallback(() => {
    const state = useFlowStore.getState();
    copiedNode.current = state.nodes.find(node => node.id === state.selectedNodeId) || null;
  }, []);
  const handlePaste = useCallback(() => {
    if (!copiedNode.current) return;
    const source = copiedNode.current;
    const id = `node-copy-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const clone = { ...source, id, selected: false, position: { x: source.position.x + 35, y: source.position.y + 35 }, data: JSON.parse(JSON.stringify(source.data)) };
    useFlowStore.setState(state => ({ nodes: [...state.nodes, clone], selectedNodeId: id }));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && event.shiftKey) { event.preventDefault(); handleRedo(); }
      else if (key === 'z') { event.preventDefault(); handleUndo(); }
      else if (key === 'y') { event.preventDefault(); handleRedo(); }
      else if (key === 'c') { event.preventDefault(); handleCopy(); }
      else if (key === 'v') { event.preventDefault(); handlePaste(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCopy, handlePaste, handleRedo, handleUndo]);
  useEffect(() => {
    if (!draggingLog) return;
    const move = (e: PointerEvent) => setLogPos({ x: logDrag.current.left + e.clientX - logDrag.current.x, y: logDrag.current.top + e.clientY - logDrag.current.y });
    const up = () => {
      setLogPos(pos => ({ x: Math.abs(pos.x) < 18 ? 0 : pos.x, y: Math.abs(pos.y) < 18 ? 0 : pos.y }));
      setDraggingLog(false);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [draggingLog]);
  useEffect(() => {
    if (!draggingHud) return;
    const move = (e: PointerEvent) => setHudPos({ x: hudDrag.current.left + e.clientX - hudDrag.current.x, y: hudDrag.current.top + e.clientY - hudDrag.current.y });
    const up = () => {
      setHudPos(pos => ({ x: Math.abs(pos.x) < 18 ? 0 : pos.x, y: Math.abs(pos.y) < 18 ? 0 : pos.y }));
      setDraggingHud(false);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [draggingHud]);

  useEffect(() => {
    if (!showJsbsimLog || !logWindowRef.current) return;
    const update = () => setLogReservedHeight(Math.max(72, Math.min(window.innerHeight - 270, logWindowRef.current?.getBoundingClientRect().height || 40) + 40));
    const observer = new ResizeObserver(update);
    observer.observe(logWindowRef.current);
    update();
    return () => observer.disconnect();
  }, [showJsbsimLog, jsbsimLogs.length]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    listenJsbsimLog((payload: any) => {
      if (!active || !payload?.line) return;
      setJsbsimLogs(lines => [...lines, `[JSBSim/${payload.stream || 'output'}] ${payload.line}`].slice(-500));
      }).then(fn => {
        if (active) dispose = fn;
        else fn();
      });
    return () => { active = false; dispose?.(); };
  }, []);

  useEffect(() => {
    if (!showNshPrints || !isTauri) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pending = '';
    let lastWasCr = false;
    let failures = 0;
    const decoder = new TextDecoder();
    const poll = async () => {
      try {
        const chunk = await usbConsoleRead(nshCursor.current);
        if (!active) return;
        failures = 0;
        nshCursor.current = chunk.next;
        if (chunk.lost) {
          setJsbsimLogs(lines => [...lines, '[NSH/USB] 缓冲区已覆盖部分旧输出'].slice(-500));
        }
        let output = decoder.decode(new Uint8Array(chunk.data), { stream: true });
        if (lastWasCr && output.startsWith('\n')) output = output.slice(1);
        if (output) lastWasCr = output.endsWith('\r');
        pending += output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        if (chunk.data.length === 0 && pending) { lines.push(pending); pending = ''; }
        if (pending.length > 8192) { lines.push(pending); pending = ''; }
        if (lines.length) {
          setJsbsimLogs(previous => [...previous, ...lines.map(line => `[NSH/USB] ${line}`)].slice(-500));
        }
        timer = setTimeout(poll, chunk.data.length === 1024 ? 30 : 150);
      } catch (error) {
        if (!active) return;
        const message = String(error);
        if (message.includes('通道忙') || message.includes('transport busy')) {
          timer = setTimeout(poll, 300);
        } else if (++failures >= 3) {
          setJsbsimLogs(lines => [...lines, `[NSH/USB] 读取失败：${String(error)}；请确认板端固件支持 USB 控制台镜像`].slice(-500));
          setShowNshPrints(false);
          localStorage.setItem('jsbsim-log-show-nsh', 'false');
        } else {
          timer = setTimeout(poll, 600);
        }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [showNshPrints]);

  useEffect(() => {
    if (showJsbsimLog && followLogTailRef.current && logWindowRef.current) {
      logWindowRef.current.scrollTop = logWindowRef.current.scrollHeight;
    }
  }, [jsbsimLogs, showJsbsimLog]);

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
          const { nodes, edges, aircraft, subFiles, xmlFiles } = useFlowStore.getState();
          localStorage.setItem('jsbsim-project', JSON.stringify({ nodes, edges, aircraft, subFiles, xmlFiles }));
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
    (focusedNode.data.componentType === 'system' ||
      focusedNode.data.componentType === 'flight_control' ||
      focusedNode.data.componentType === 'aero_coefficients')
      ? focusedNode
      : null;
  const focusedAero = focusedModule?.data.componentType === 'aero_coefficients';
  const focusedXmlPath = (() => {
    if (!focusedModule) return '';
    return resolveNodeOwnedPath(focusedModule as any) || String(focusedModule.data.params?.source?.path || '');
  })();
  let focusedChannels: any[] = [];
  let focusedTopLevelItems: any[] = [];
  let focusedPropertyDefinitions: { name: string; attrs?: Record<string, string> }[] = [];
  let focusedCoefficients: any[] = [];
  let focusedLayout: Record<string, { x: number; y: number }> | undefined;
  if (focusedModule) {
    try {
      if (focusedAero) {
        const parsed = JSON.parse(focusedModule.data.params.coefficients || '[]');
        if (Array.isArray(parsed)) {
          focusedCoefficients = parsed;
          focusedChannels = aeroCoefficientsToChannels(parsed);
        }
      } else {
        const parsed = JSON.parse(focusedModule.data.params.channels);
        if (Array.isArray(parsed)) focusedChannels = parsed;
      }
    } catch { /* ignore malformed */ }
    if (focusedModule.data.componentType === 'system') {
      try {
        const parsed = JSON.parse(focusedModule.data.params.topLevelItems || '[]');
        if (Array.isArray(parsed)) focusedTopLevelItems = parsed;
      } catch { /* ignore malformed */ }
      try {
        const parsed = JSON.parse(focusedModule.data.params.propertyDefinitions || '[]');
        if (Array.isArray(parsed)) focusedPropertyDefinitions = parsed;
      } catch { /* ignore malformed */ }
    }
    try {
      if (focusedModule.data.params.layout) {
        const lp = JSON.parse(focusedModule.data.params.layout);
        if (lp && typeof lp === 'object') focusedLayout = lp;
      }
    } catch { /* ignore malformed */ }
  }

  const selectMultiInstanceFromToolbar = (id: string) => {
    if (id !== multiSelectedInstance && multiConfigEdited &&
        !window.confirm('当前模型配置尚未保存，切换实例会丢失本页修改。继续吗？')) return;
    setMultiSelectedInstance(id);
  };

  async function runFleetCommand(action: 'start' | 'pause' | 'resume' | 'stop') {
    if (fleetBusy || !connected) return;
    const ids = action === 'start' ? INSTANCE_IDS.filter(id => !!instanceSlots[id]) : INSTANCE_IDS;
    if (action === 'start' && multiConfigEdited) {
      setFleetError('请先保存当前多机配置，再启动编组。');
      return;
    }
    if (!ids.length) {
      setFleetError('请先为实例选择模型。');
      return;
    }
    setFleetBusy(true);
    setFleetError('');
    try {
      const results = await Promise.allSettled(ids.map(id => simInstanceControl({ instanceId: id, action,
        ...(action === 'start' ? { model: instanceSlots[id], initial: initialOverrides[id], network: networkOverrides[id] } : {}) })));
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${ids[index]}: ${String(result.reason)}`] : []);
      const sent = ids.length - failures.length;
      const actionName = { start: '启动', pause: '暂停', resume: '继续', stop: '停止' }[action];
      const result = failures.length
        ? `编组${actionName}：${sent} 架命令已发送；${failures.join('；')}`
        : `编组${actionName}：${sent} 架命令已发送。`;
      setJsbsimLogs(lines => [...lines, `[${new Date().toLocaleTimeString()}] ${result}`].slice(-200));
      if (failures.length) setFleetError(result);
    } finally {
      setFleetBusy(false);
    }
  }

  const handleModelContextChange = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setModifiedXmlFiles([]);
    setXmlChangeNotice([]);
    undoStack.current = [];
    redoStack.current = [];
    historyCurrent.current = snapshotProject();
  };

  return (
    <div className="app">
      <Toolbar onShow3D={handleShow3D}
        onShowLogCenter={() => setShowLogCenter(true)}
        workspace={workspace} onSelectWorkspace={next => {
          if (workspace === 'multi' && next !== 'multi' && multiConfigEdited &&
              !window.confirm('当前模型配置尚未保存，离开后会丢失本页修改。继续吗？')) return;
          setShow3D(false);
          if (workspace === 'multi' && next === 'editor') setEditorSwitchRequest(multiSelectedInstance);
          setWorkspace(next);
        }}
        fleetControls={{ connected, configuredCount: INSTANCE_IDS.filter(id => !!instanceSlots[id]).length,
          runningCount: fleetState.running, pausedCount: fleetState.paused,
          busy: fleetBusy, error: fleetError, onCommand: action => void runFleetCommand(action) }}
        activeInstance={workspace === 'multi' ? multiSelectedInstance : activeInstance} instanceSlots={instanceSlots}
        editorSwitchRequest={editorSwitchRequest} onEditorSwitchHandled={() => setEditorSwitchRequest(null)}
        onSelectInstance={id => { setActiveInstance(id); setMultiSelectedInstance(id); }}
        onSelectMultiInstance={selectMultiInstanceFromToolbar}
        onAssignInstanceModel={(id, model) => {
          if (workspace === 'multi' && id === multiSelectedInstance &&
              instanceSlots[id] !== model && multiConfigEdited &&
              !window.confirm('当前模型配置尚未保存，更换模型会丢失本页修改。继续吗？')) return;
          if (instanceSlots[id] !== model) setInitialOverrides(current => {
            const next = { ...current }; delete next[id]; return next;
          });
          if (instanceSlots[id] !== model) setNetworkOverrides(current => {
            const next = { ...current }; delete next[id]; return next;
          });
          setInstanceSlots(current => ({ ...current, [id]: model }));
        }}
        initialOverrides={initialOverrides}
        networkOverrides={networkOverrides}
        onLoadFleetGroup={(group: FleetModelGroup) => {
          if (workspace === 'multi' && multiConfigEdited &&
              !window.confirm('当前模型配置尚未保存，加载模型组会丢失本页修改。继续吗？')) return false;
          setInstanceSlots(group.slots);
          setInitialOverrides(group.initialOverrides);
          setNetworkOverrides(group.networkOverrides);
          return true;
        }}
        onModelContextChange={handleModelContextChange}
        onUndo={handleUndo} onRedo={handleRedo} onCopy={handleCopy} onPaste={handlePaste}
        modifiedXmlFiles={modifiedXmlFiles} onSaveComplete={savedFiles => setModifiedXmlFiles(current => savedFiles ? current.filter(file => !savedFiles.includes(file)) : [])}
        jsbsimLogs={jsbsimLogs}
        onToggleJsbsimLog={() => setShowJsbsimLog(value => !value)}
        hudVisible={hudVisible}
        onToggleHud={() => setHudVisible(value => !value)}
        onLog={(line) => setJsbsimLogs(lines => [...lines, line].slice(-200))} />
      {showLogCenter && <LogCenter onClose={() => setShowLogCenter(false)} />}
      {xmlChangeNotice.length > 0 && <div className="xml-change-notice" role="status">
        <span className="xml-change-notice-icon">✎</span>
        <span><strong>编辑内容已修改</strong><small>影响文件：{xmlChangeNotice.join('、')}</small></span>
        <button onClick={() => setXmlChangeNotice([])} aria-label="关闭提示">×</button>
      </div>}
      <div className="main-content">
        {workspace === 'multi' ? (
          <MultiSimPanel connected={connected} singleTelemetry={telemetry} onFleetStateChange={setFleetState}
            selected={multiSelectedInstance} onSelect={setMultiSelectedInstance}
            slots={instanceSlots} onSlotsChange={change => {
              const next = typeof change === 'function' ? change(instanceSlots) : change;
              setInitialOverrides(current => {
                const updated = { ...current };
                for (const id of Object.keys(next)) if (next[id] !== instanceSlots[id]) delete updated[id];
                return updated;
              });
              setNetworkOverrides(current => {
                const updated = { ...current };
                for (const id of Object.keys(next)) if (next[id] !== instanceSlots[id]) delete updated[id];
                return updated;
              });
              setInstanceSlots(next);
            }}
            initialOverrides={initialOverrides} onInitialOverridesChange={setInitialOverrides}
            networkOverrides={networkOverrides} onNetworkOverridesChange={setNetworkOverrides}
            onPendingChange={setMultiConfigEdited}
            onOpenLogCenter={() => setShowLogCenter(true)} onOpenEditor={() => {
              setEditorSwitchRequest(multiSelectedInstance);
              setWorkspace('editor');
            }} />
        ) : focusedModule ? (
          <ModuleExpressionCanvas
            key={focusedModule.id}
            embedded
            mode="signal"
            initialOpenComponentId={sourceJump?.moduleId === focusedModule.id ? sourceJump.componentId : undefined}
            findPropertySource={(signal) => findPropertyProducer(signal)}
            onOpenPropertySource={(signal) => {
              const source = findPropertyProducer(signal);
              if (!source) return;
              setSourceJump({ moduleId: source.moduleId, componentId: source.componentId });
              setFocusedNodeId(source.moduleId);
            }}
            title={`${focusedAero ? '气动系数数据流' : `${focusedModule.data.componentType === 'flight_control' ? '飞控' : '系统'} 信号流`}${focusedXmlPath ? `  ·  XML: ${focusedXmlPath}` : '  ·  XML: 未绑定'}`}
            channels={focusedModule.data.componentType === 'system'
              ? systemCanvasChannels(focusedChannels, focusedTopLevelItems)
              : focusedChannels}
            topLevelProps={focusedAero ? [] : (focusedModule.data.params.properties || '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)}
            propertyDefinitions={focusedPropertyDefinitions}
            onPropertyValueChange={(name, value) => {
              const definitions = focusedPropertyDefinitions.map(definition =>
                definition.name === name
                  ? { ...definition, attrs: { ...definition.attrs, value } }
                  : definition);
              updateNodeParams(focusedModule.id, {
                propertyDefinitions: JSON.stringify(definitions),
              });
            }}
            modelId={focusedModule.id}
            initialLayout={focusedLayout}
            onChannelsChange={(chs) => {
              if (focusedAero) {
                updateNodeParams(focusedModule.id, {
                  coefficients: JSON.stringify(channelsToAeroCoefficients(chs, focusedCoefficients)),
                });
              } else if (focusedModule.data.componentType === 'system') {
                const separated = splitSystemCanvasChannels(chs);
                updateNodeParams(focusedModule.id, {
                  channels: JSON.stringify(separated.channels),
                  topLevelItems: JSON.stringify(separated.topLevelItems),
                });
              } else {
                updateNodeParams(focusedModule.id, { channels: JSON.stringify(chs) });
              }
            }}
            onLayoutChange={(layout) => updateNodeParams(focusedModule.id, { layout: JSON.stringify(layout) })}
            onBack={() => { setSourceJump(null); setFocusedNodeId(null); }}
          />
        ) : (
          <>
            <Palette onDragStart={handleDragStart} collapsed={paletteCollapsed} onToggle={() => setPaletteCollapsed(value => !value)} width={paletteWidth}
              onResizeStart={e => { e.preventDefault(); paletteResize.current = { x: e.clientX, width: paletteWidth }; }} />
            <Canvas dragType={dragType} onDragStart={handleDragStart} />
            {(selectedNodeId || editingSubFileId) && <div className={`right-sidebar${showJsbsimLog ? ' has-detached-log' : ''}`} style={showJsbsimLog ? { paddingTop: logReservedHeight } : undefined}>
              <PropertyPanel /><FileManager />
            </div>}
          </>
        )}
      </div>

      {/* Keep the log independent from the property sidebar.  It docks below
       * the HUD by default but remains draggable like the HUD itself. */}
      {showJsbsimLog && (
        <div className="jsbsim-log-sidebar jsbsim-log-detached" style={logPos.x || logPos.y ? { transform: `translate(${logPos.x}px, ${logPos.y}px)` } : undefined}>
          <div className="jsbsim-log-sidebar-head" onPointerDown={e => { if ((e.target as HTMLElement).closest('button, input, label')) return; logDrag.current = { x: e.clientX, y: e.clientY, left: logPos.x, top: logPos.y }; setDraggingLog(true); }}><span>🖥️ JSBSim 信息</span><div><label className="jsbsim-log-nsh-toggle" title="通过 USB 显示板端调试控制台的打印"><input type="checkbox" checked={showNshPrints} onChange={event => { const enabled = event.target.checked; setShowNshPrints(enabled); localStorage.setItem('jsbsim-log-show-nsh', String(enabled)); }} />NSH 打印</label><button className="jsbsim-log-clear" onClick={() => setJsbsimLogs([])}>清理</button><button onClick={() => setShowJsbsimLog(false)}>×</button></div></div>
          <div ref={logWindowRef} className="sim-log-window jsbsim-log-sidebar-window" onScroll={event => {
            const element = event.currentTarget;
            followLogTailRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}>
            {jsbsimLogs.length === 0 ? <span className="sim-log-empty">暂无信息</span> : jsbsimLogs.map((line, i) => <div key={`${i}-${line}`} className="sim-log-line">{line}</div>)}
          </div>
        </div>
      )}

      {/* HUD belongs to the main model canvas. Full-screen editors and viewers
       * deliberately do not render it, so it cannot cover their controls. */}
      {hudVisible && workspace === 'editor' && !focusedModule && !show3D && !showLogCenter && (
        <div className="jsbsim-hud-window" style={{ transform: `translate(${hudPos.x}px, ${hudPos.y}px)` }}>
          <div className="jsbsim-hud-window-head" onPointerDown={e => {
            if ((e.target as HTMLElement).closest('button')) return;
            hudDrag.current = { x: e.clientX, y: e.clientY, left: hudPos.x, top: hudPos.y };
            setDraggingHud(true);
          }}><span>HUD · {activeInstance} · FLIGHT DISPLAY</span><span className="hud-window-actions"><span>↕ 拖动</span><button onClick={() => setHudVisible(false)} title="隐藏 HUD" aria-label="隐藏 HUD">×</button></span></div>
          <FlightHud telemetry={hudTelemetry} connected={hudConnected} />
        </div>
      )}

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
        <XmlDiagnosticDialog />
      </ReactFlowProvider>
    </GlobalErrorBoundary>
  );
}
