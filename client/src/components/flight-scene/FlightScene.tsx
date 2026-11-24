import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listenSceneFrames, listenTelemetry, simInstanceControl } from '../../utils/tauriApi';
import { captureGroundOrigin, FlightSceneFeed, demoPackets, localPosition, propertyAgeMs, SCENE_COLORS, STALE_MS, type CameraMode, type ScenePose } from '../../sim/flightSceneState';
import { listenSceneMonitor, mergeSceneMonitorKeys, sceneMonitorKeys, type SceneMonitorTarget } from '../../sim/sceneSignals';
import { canonicalMonitorProperty } from '../../sim/monitorIdentity';
import { loadSceneDisplay, SCENE_DISPLAY_KEY, sceneValueKeys, type SceneDisplay } from '../../sim/sceneInstruments';
import { CircularSceneHud, SceneIcon, SceneInstrumentSettings, SceneValueGrid } from './SceneInstruments';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';
import { rotorCount, rotorLabel, rotorReading } from '../../sim/sceneRotors';
import { isMorphQuad, MORPHQUAD_ARMS } from '../../sim/sceneMorphQuad';
import { windReading } from '../../sim/sceneWind';
import { PLATFORM_SIGNAL_KEYS } from '../../sim/sceneMovingPlatform';
import FlightSceneCanvas, { type SceneLayers } from './FlightSceneCanvas';
import SceneEditorPanel from './SceneEditorPanel';
import { useSceneEditor } from './useSceneEditor';
import { useSceneModelOrigin } from './useSceneModelOrigin';
import { preloadMovingPlatformAsset } from './useMovingPlatformAsset';
import { sessionIsActive, setTestDisplay, useFlightTestStore } from '../../flight-test/session';
import { SceneFlightTestPanel, SceneFlightTestStatus } from './SceneFlightTest';
import './flightScene.css';
import './flightSceneWorkspace.css';

const MODES: [CameraMode, string][] = [['free', '自由'], ['follow', '跟随'], ['ground', '地面'], ['cockpit', '机载'], ['fleet', '编队']];
const INITIAL_LAYERS: SceneLayers = { grid: true, trails: true, labels: true, thrust: false, axes: false };
const LAYERS: [keyof SceneLayers, string][] = [['grid', '地面网格'], ['trails', '飞行航迹'], ['labels', '飞机标签'], ['thrust', '推力方向'], ['axes', '机体坐标轴']];

// Keep telemetry and FPS renders from rewriting native checkbox state. Desktop
// WebKit can repaint the controls even when checked is assigned the same value.
const SceneLayerControls = memo(function SceneLayerControls({ layers, onChange }: {
  layers: SceneLayers; onChange: (key: keyof SceneLayers, checked: boolean) => void;
}) {
  return <section className="scene-layer-list"><strong>场景图层</strong>{LAYERS.map(([key, label]) => <label key={key}>
    <input type="checkbox" checked={layers[key]} onChange={event => onChange(key, event.target.checked)} />{label}
  </label>)}</section>;
});

const format = (n: number | null | undefined, digits = 1) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);
const color = (id: string) => SCENE_COLORS[(Number(id) - 1) % SCENE_COLORS.length];
const fresh = (p: ScenePose | undefined, now: number) => !!p && now - p.receivedAt < STALE_MS;
function clock(t?: number) {
  if (t === undefined) return '—';
  return `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
}

class SceneBoundary extends Component<{ children: ReactNode; resetKey: number }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: number }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: false });
  }
  render() { return this.state.error ? <div className="scene-webgl-error"><strong>三维视窗暂不可用</strong><p>请检查 WebGL 和显卡驱动。遥测与列表仍可查看。</p></div> : this.props.children; }
}

function Trend({ history, selected }: { history: ScenePose[]; selected: string }) {
  const latest = history[history.length - 1];
  const end = Math.max(30, latest?.time ?? 30), start = end - 30;
  const samples = history.filter(p => p.time >= start);
  const max = Math.max(10, ...samples.flatMap(p => [Math.abs(p.roll), Math.abs(p.pitch)]));
  const line = (key: 'roll' | 'pitch') => samples.map((p, i) => `${i ? 'L' : 'M'}${50 + (p.time - start) / 30 * 850},${55 - p[key] / max * 32}`).join(' ');
  return <section className="scene-trend" aria-label="姿态趋势">
    <header><strong>飞行趋势</strong><span className="scene-trend-tab">姿态 · {selected}</span><small>最近 30 s 仿真时间</small>
      <span className="scene-legend"><i style={{ background: '#3b82f6' }} />横滚 <i style={{ background: '#12b9b1' }} />俯仰</span></header>
    <svg viewBox="0 0 940 115" role="img" aria-label="横滚与俯仰角时间曲线" preserveAspectRatio="none">
      {[-1, 0, 1].map(v => <g key={v}><line x1="50" x2="900" y1={55 - v * 32} y2={55 - v * 32} stroke="#e8edf3" /><text x="40" y={59 - v * 32} textAnchor="end">{(v * max).toFixed(0)}°</text></g>)}
      {[0, 1, 2, 3].map(i => <text key={i} x={50 + i * 850 / 3} y="107" textAnchor="middle">{clock(Math.max(0, start + i * 10))}</text>)}
      <path d={line('roll')} stroke="#3b82f6" strokeWidth="1.6" fill="none" /><path d={line('pitch')} stroke="#12b9b1" strokeWidth="1.6" fill="none" />
      {!samples.length && <text x="475" y="58" textAnchor="middle">等待姿态数据</text>}
    </svg>
  </section>;
}

function MiniMap({ feed, selected, onSelect }: { feed: FlightSceneFeed; selected: string; onSelect: (id: string) => void }) {
  const positions = feed.origin ? [...feed.aircraft].map(([id, entry]) => ({ id, p: localPosition(entry.latest, feed.origin!) })) : [];
  const extent = Math.max(30, ...positions.flatMap(({ p }) => [Math.abs(p.x), Math.abs(p.z)]));
  return <svg className="scene-minimap" viewBox="0 0 170 125" role="img" aria-label="编队局部位置图">
    <rect x="1" y="1" width="168" height="123" rx="8" fill="#263d3b" fillOpacity=".88" stroke="#91a69f" />
    {[1, 2, 3].map(i => <g key={i} stroke="#49635d"><line x1={i * 42.5} x2={i * 42.5} y1="0" y2="125" /><line y1={i * 31.25} y2={i * 31.25} x1="0" x2="170" /></g>)}
    <text x="10" y="17" fill="#e7eef0">N ↑</text><text x="160" y="116" fill="#c4d1ce" textAnchor="end">±{extent.toFixed(0)} m</text>
    {positions.map(({ id, p }) => <g key={id} role="button" tabIndex={0} aria-label={`定位飞机 ${id}`} onClick={() => onSelect(id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(id); }}>
      <circle cx={85 + p.x / extent * 67} cy={62.5 + p.z / extent * 44} r={selected === id ? 5 : 3.5} fill={color(id)} stroke="white" strokeWidth="1" />
    </g>)}
  </svg>;
}

function WindStatus({ pose, instance, demo, now }: { pose?: ScenePose; instance: string; demo: boolean; now: number }) {
  const wind = windReading(pose, now);
  const state = !wind.wind ? 'waiting' : !wind.fresh ? 'stale' : pose?.state === 'paused' ? 'paused'
    : pose?.state !== 'running' ? 'stopped' : 'live';
  return <div className={`scene-wind-status ${state}`} data-state={state} aria-label="环境风">
    <strong>风袋 · 环境风 <span>{instance}</span></strong>
    <b>{format(wind.horizontal)} <small>m/s</small><span>{wind.fromDegrees === null ? wind.wind ? '水平静风' : '来向 —' : `来向 ${format(wind.fromDegrees, 0)}°`}</span></b>
    <span>{!wind.wind ? '等待环境风采样' : !wind.fresh ? '风数据过期 · 保留最后外形' : pose?.state === 'paused' ? '已暂停 · 风袋冻结'
      : pose?.state !== 'running' ? '已停止 · 风袋冻结' : demo ? '演示风场' : 'JSBSim 总环境风'}</span>
    {wind.wind && <small>垂直风 {format(-wind.wind.down)} m/s（向上为正）</small>}
    <small>袋尾朝下风向 · 随所选实例切换</small>
  </div>;
}

export default function FlightScene({ onClose, slots = {}, initialSelected = '01', onMonitorTargetChange, toolbarHost }: {
  onClose: () => void; slots?: Record<string, string>; initialSelected?: string;
  onMonitorTargetChange?: (target: SceneMonitorTarget | null) => void;
  toolbarHost?: HTMLElement | null;
}) {
  const [feed, setFeed] = useState(() => new FlightSceneFeed());
  const [demo, setDemo] = useState(false);
  const [demoPaused, setDemoPaused] = useState(false);
  const [selected, setSelected] = useState(initialSelected);
  const [mode, setMode] = useState<CameraMode>('follow');
  const [layers, setLayers] = useState(INITIAL_LAYERS);
  const changeLayer = useCallback((key: keyof SceneLayers, checked: boolean) => {
    setLayers(current => ({ ...current, [key]: checked }));
  }, []);
  const [revision, setRevision] = useState(0);
  const [cameraVersion, setCameraVersion] = useState(0);
  const [groundAltitude, setGroundAltitude] = useState<number | null>(null);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [display, setDisplay] = useState<SceneDisplay>(loadSceneDisplay);
  const [panel, setPanel] = useState<'aircraft' | 'layers' | 'settings' | 'telemetry' | 'instruments' | 'editor' | null>(null);
  const [focus, setFocus] = useState(false), [valueSelected, setValueSelected] = useState(0), [hudSettings, setHudSettings] = useState(false);
  const testDisplay = useFlightTestStore(state => state.display), testRunning = useFlightTestStore(sessionIsActive);
  const [storageError, setStorageError] = useState(false);
  const customKeys = useMemo(() => sceneValueKeys(display.values), [display.values]);
  const customSignature = customKeys.join('\n');
  useEffect(() => { try { localStorage.setItem(SCENE_DISPLAY_KEY, JSON.stringify(display)); setStorageError(false); } catch { setStorageError(true); } }, [display]);
  const togglePanel = (next: typeof panel) => { setFocus(false); setPanel(current => current === next ? null : next); };
  const editor = useSceneEditor();
  useEffect(() => { if (!editor.enabled) setPanel(current => current === 'editor' ? null : current); }, [editor.enabled]);
  const viewMode = editor.enabled ? 'free' : mode;
  const demoTime = useRef(0);
  useEffect(() => { void preloadMovingPlatformAsset().catch(() => {}); }, []);
  const groundPlane = useRef<{ feed: FlightSceneFeed; altitude: number | null }>({ feed, altitude: null });
  useEffect(() => {
    const listener = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setRevision(v => v + 1), 200); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let alive = true;
    const stops: (() => void)[] = [];
    if (demo) {
      const tick = () => {
        if (!demoPaused) demoTime.current += .04;
        for (const packet of demoPackets(demoTime.current)) feed.ingest({ ...packet, capture_monotonic_us: performance.now() * 1000, state: demoPaused ? 'paused' : 'running' });
      };
      tick(); const timer = window.setInterval(tick, 40);
      return () => clearInterval(timer);
    }
    const register = (promise: Promise<() => void>) => { void promise.then(stop => { if (alive) stops.push(stop); else stop(); }).catch(e => { if (alive) setError(String(e)); }); };
    stops.push(listenSceneMonitor(frame => { if (alive) feed.ingestMonitor(frame); }));
    register(listenSceneFrames(packets => { if (alive) for (const packet of packets) feed.ingest(packet); }));
    // Local JSBSim processes and older desktops still publish the ordinary event.
    register(listenTelemetry(packet => { if (alive) feed.ingest(packet, performance.now(), 'fallback'); }, false));
    return () => { alive = false; for (const stop of stops) stop(); };
  }, [demo, demoPaused, feed]);

  const now = performance.now();
  const entry = feed.aircraft.get(selected), pose = entry?.latest;
  const selectedModel = pose?.model || slots[selected] || '';
  const platformEnabled = pose?.platformEnabled === true;
  const platformProbe = !!selectedModel && pose?.platformAvailable !== false && pose?.platformEnabled === undefined;
  const monitorExtras = useMemo(() => [...customKeys, ...(platformEnabled ? PLATFORM_SIGNAL_KEYS : platformProbe ? ['moving-platform/enabled'] : [])], [platformEnabled, platformProbe, customSignature]);
  const monitorSignature = monitorExtras.join('\n');
  const modelOrigin = useSceneModelOrigin(selectedModel, !demo, editor.applyModelOrigin, captureGroundOrigin(entry, now));
  useEffect(() => {
    onMonitorTargetChange?.(demo ? null : { instance: selected, model: selectedModel, extraKeys: monitorSignature ? monitorSignature.split('\n') : [] });
    return () => onMonitorTargetChange?.(null);
  }, [onMonitorTargetChange, demo, selected, selectedModel, monitorSignature]);
  const online = [...feed.aircraft.values()].filter(item => fresh(item.latest, now)).length;
  const ids = [...new Set([...Object.keys(slots).filter(id => slots[id]), ...feed.aircraft.keys()])].sort();
  const selectedFresh = fresh(pose, now);
  const state = !pose ? '等待数据' : !selectedFresh ? '数据过期' : pose.state === 'running' ? '运行中' : pose.state === 'paused' ? '已暂停' : '已停止';
  const ground = groundAltitude ?? pose?.ground ?? (pose?.agl != null ? pose.altitude - pose.agl : null);
  useEffect(() => {
    const geo = editor.document.georeference;
    if (geo) { if (feed.origin !== geo) feed.origin = geo; }
    else if (demo && feed.origin && ground !== null) editor.applyModelOrigin({ ...feed.origin, altitude: ground });
  }, [feed, revision, editor.document.georeference, ground, demo, editor.applyModelOrigin]);
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_SCENE_DIAGNOSTICS !== '1') return;
    const publish = () => {
      const measured = feed.aircraft.get(selected)?.latest, monitorState = useSignalMonitorStore.getState();
      const observed = monitorState.running[selected];
      import.meta.hot?.send('jsbsim:scene-diagnostics', { selected, demo, model: measured?.model,
        state: measured?.state, monitorError: monitorState.error, source: measured?.tiltSource, tilt: measured?.tilt, tiltAgeMs: propertyAgeMs(measured?.tiltSampleAt),
        motors: measured?.motors, motorAgeMs: measured?.motorSampleAt.map(time => propertyAgeMs(time)),
        bodyAgeMs: measured ? performance.now() - measured.receivedAt : null,
        rpm: measured?.rpm, rpmModelVersion: measured?.rpmModelVersion, rpmTailCalibrated: measured?.rpmTailCalibrated,
        observer: observed ? { source: observed.source, sequence: observed.sequence, generation: observed.generation,
          ageMs: performance.now() - observed.seen } : null, requestedRevision: monitorState.revisions[selected] });
    };
    const timer = window.setInterval(publish, 1000);
    return () => clearInterval(timer);
  }, [feed, selected, demo]);
  // Keep the field at the last known elevation when property samples expire.
  // Fresh AGL still requires a known current ground value in the inspector.
  if (groundPlane.current.feed !== feed) groundPlane.current = { feed, altitude: null };
  if (ground !== null) groundPlane.current.altitude = ground;
  const agl = ground !== null && pose ? pose.altitude - ground : null;
  const recent = entry?.samples ?? [];
  const elapsed = recent.length > 1 ? recent[recent.length - 1].receivedAt - recent[0].receivedAt : 0;
  const hz = selectedFresh && elapsed > 0 ? (recent.length - 1) * 1000 / elapsed : null;
  const toggleDemo = () => {
    setDemo(value => !value); setDemoPaused(false); demoTime.current = 0; setFeed(new FlightSceneFeed());
    setSelected(initialSelected); setGroundAltitude(null); setError(''); setCameraVersion(v => v + 1);
  };
  const command = async () => {
    if (demo) { setDemoPaused(value => !value); return; }
    if (!pose || !selectedFresh || busy) return;
    setBusy(true); setError('');
    try { await simInstanceControl({ instanceId: selected, action: pose.state === 'paused' ? 'resume' : 'pause' }); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const editScene = () => { const enabled = !editor.enabled; editor.setEnabled(enabled); setFocus(false); setPanel(enabled ? 'editor' : null); };
  const toggleTrend = () => { setFocus(false); setDisplay(current => ({ ...current, trend: !current.trend })); };
  const openInstruments = (hud = false, index = valueSelected) => { setFocus(false); setHudSettings(hud); setValueSelected(index); setPanel('instruments'); };
  const userProject = useSignalMonitorStore.getState().project;
  const userKeys = [...Object.values(userProject.labels).flatMap(label => label.bindings), ...userProject.scopes.flatMap(scope => scope.channels)].map(binding => binding.key);
  const subscribed = new Set(mergeSceneMonitorKeys(userKeys, sceneMonitorKeys(selectedModel, monitorExtras)).map(canonicalMonitorProperty));
  const platformChannelsAvailable = PLATFORM_SIGNAL_KEYS.every(key => subscribed.has(canonicalMonitorProperty(key)));
  const unavailableKeys = demo ? [] : customKeys.filter(key => !subscribed.has(canonicalMonitorProperty(key)));
  const rightOpen = !focus && (panel === 'telemetry' || panel === 'instruments' || editor.enabled && panel === 'editor');
  const testVisible = testDisplay !== 'hidden' && !focus && !editor.enabled && !['aircraft', 'layers', 'settings'].includes(panel ?? '');
  const restoreTest = () => { setFocus(false); setPanel(null); editor.setEnabled(false); setTestDisplay('compact'); };
  const toolbar = <div className={`scene-toolbar ${toolbarHost ? 'scene-toolbar-embedded' : ''}`}>
      <div className="scene-breadcrumb"><button onClick={onClose} title="返回模型编辑" aria-label="返回模型编辑">←</button><strong>飞行视景</strong></div>
      <select className="scene-aircraft-select" aria-label="选择视景飞行器" value={selected} onChange={event => setSelected(event.target.value)}>
        {!ids.includes(selected) && <option value={selected}>{selected} · 等待飞机</option>}
        {ids.map(id => <option key={id} value={id}>{id} · {feed.aircraft.get(id)?.latest.model || slots[id]}</option>)}
      </select>
      <span className={`scene-state ${selectedFresh ? 'online' : ''}`}><i />{state}</span>
      <button className="scene-action" disabled={!demo && (!selectedFresh || busy || !['running', 'paused'].includes(pose?.state ?? ''))} onClick={() => void command()}>{(demo ? demoPaused : pose?.state === 'paused') ? '▶ 继续' : 'Ⅱ 暂停'}<small> {selected}</small></button>
      <div className="scene-toolbar-right">
        <button className={`scene-action ${editor.enabled ? 'active' : ''}`} aria-pressed={editor.enabled} onClick={editScene}>{editor.enabled ? '完成编辑' : '编辑场景'}</button>
        <button className="scene-action scene-focus-toggle" aria-pressed={focus} onClick={() => setFocus(value => !value)}><SceneIcon name="focus" />{focus ? '退出专注' : '专注'}</button>
        <details className="scene-more" onClick={event => { if ((event.target as Element).closest('button')) event.currentTarget.open = false; }}><summary aria-label="更多视景操作">•••</summary><div>
          <button onClick={() => { feed.clearTrails(); setRevision(v => v + 1); }}>清除航迹</button>
          <button onClick={toggleDemo}>{demo ? '退出演示' : '演示场景'}</button>
          <button onClick={() => togglePanel('settings')}>视图设置</button>
          <button onClick={() => openInstruments()}>自定义数值与 HUD</button>
        </div></details>
      </div>
    </div>;
  return <div className={`flight-scene flight-scene-immersive ${focus ? 'scene-focus' : ''}`} data-testid="flight-scene" data-mode={demo ? 'demo' : 'live'}>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    {error && <div className="scene-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
    {storageError && <div className="scene-error" role="status">本机存储不可用，本次数值布局将在当前窗口内保留。</div>}
    <div className={`scene-layout ${rightOpen && (display.pinned || editor.enabled || panel === 'instruments') ? 'scene-panel-docked' : ''}`}>
      <nav className="scene-tool-rail" aria-label="视景工具">
        <button aria-label="飞行器列表" aria-pressed={panel === 'aircraft'} onClick={() => togglePanel('aircraft')}><SceneIcon name="plane" /><span>飞机</span></button>
        <button aria-label="场景图层" aria-pressed={panel === 'layers'} onClick={() => togglePanel('layers')}><SceneIcon name="layers" /><span>图层</span></button>
        <button aria-label={editor.enabled ? '场景属性' : '飞行遥测'} aria-pressed={panel === 'telemetry' || panel === 'editor'} onClick={() => togglePanel(editor.enabled ? 'editor' : 'telemetry')}><SceneIcon name="gauge" /><span>{editor.enabled ? '属性' : '遥测'}</span></button>
        <button aria-label="姿态趋势" aria-pressed={display.trend} disabled={editor.enabled} onClick={toggleTrend}><SceneIcon name="chart" /><span>趋势</span></button>
        <button className="scene-test-tool" aria-label={testVisible ? '隐藏仿真测试' : '显示仿真测试'} aria-pressed={testVisible} onClick={() => testVisible ? setTestDisplay('hidden') : restoreTest()}><SceneIcon name="test" /><span>测试</span>{testRunning && <i />}</button>
        <button aria-label="视图设置" aria-pressed={panel === 'settings'} onClick={() => togglePanel('settings')}><SceneIcon name="settings" /><span>设置</span></button>
      </nav>
      <aside className="scene-sidebar" hidden={focus || !['aircraft', 'layers', 'settings'].includes(panel ?? '')}><header><strong>{panel === 'layers' ? '场景图层' : panel === 'settings' ? '视图设置' : `飞行器 · ${ids.length} 架`}</strong><button className="scene-panel-close" aria-label="收起侧栏" onClick={() => setPanel(null)}><SceneIcon name="close" /></button></header>
        <div hidden={panel !== 'aircraft'}>
        <div className="scene-aircraft-list">{ids.length ? ids.map(id => {
          const item = feed.aircraft.get(id)?.latest;
          return <button key={id} data-aircraft={id} className={selected === id ? 'selected' : ''} onClick={() => setSelected(id)} aria-pressed={selected === id}>
            <i className={`scene-dot ${fresh(item, now) ? 'online' : ''}`} /><span><b>{id} · {item?.model || slots[id]}</b><small>{selected === id ? `已选中 · ${MODES.find(m => m[0] === mode)?.[1]}` : fresh(item, now) ? item?.state === 'paused' ? '已暂停' : '实时遥测' : '等待数据'}</small></span><em style={{ background: color(id) }} />
          </button>;
        }) : <p className="scene-muted">尚无飞行器数据</p>}</div>
        </div><div hidden={panel !== 'layers'}>
        <SceneLayerControls layers={layers} onChange={changeLayer} />
        <WindStatus pose={pose} instance={selected} demo={demo} now={now} />
        <details className="scene-resource-info"><summary>环境与资源信息</summary><div className="scene-environment"><strong>△ 离线试验场</strong><span>{ground === null ? '参考平面 · 地面高程未知' : `地面海拔 ${format(ground)} m`}</span><small>{editor.document.georeference ? `固定场景基准 ${format(editor.document.georeference.altitude)} m` : "场景尚未固定地理基准"}</small><small>场景比例 1 m / 单位</small><small>场景素材：Poly Haven · CC0</small>
          {editor.document.objects.some(object => object.builtin === 'f35') && <small>F-35A：<a href="https://sketchfab.com/3d-models/f-35a-lightning-ii-a06d6113cfb44a0aa7b8f17106aca9c4" target="_blank" rel="noreferrer">shangus930</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · 已转换为静态模型</small>}
        </div></details></div>
        <div className="scene-view-settings" hidden={panel !== 'settings'}>
          <label className="scene-view-check"><input type="checkbox" checked={display.numbers} onChange={event => setDisplay(current => ({ ...current, numbers: event.target.checked }))} />显示数值信息条</label>
          <label className="scene-view-check"><input type="checkbox" checked={display.hud} onChange={event => setDisplay(current => ({ ...current, hud: event.target.checked }))} />显示圆形 HUD</label>
          <label className="scene-view-check"><input type="checkbox" checked={display.minimap} onChange={event => setDisplay(current => ({ ...current, minimap: event.target.checked }))} />显示小地图</label>
          <button className="scene-action" onClick={() => openInstruments()}>自定义数值与 HUD</button>
          <details><summary>参考地面与场景原点</summary><label>参考地面海拔 / m<input aria-label="参考地面海拔" type="number" placeholder="使用遥测地面" value={groundAltitude ?? ''} onChange={event => setGroundAltitude(event.target.value === '' || !Number.isFinite(event.target.valueAsNumber) ? null : event.target.valueAsNumber)} /></label>
            <p className="scene-muted">未收到地面高程时显示参考平面，离地高度留空。</p><button className="scene-action" disabled={!pose || !!editor.document.georeference} onClick={() => { feed.recenter(selected); setCameraVersion(v => v + 1); }}>以所选飞机重设场景原点</button></details>
        </div>
      </aside>
      <main className="scene-main"><div className="scene-viewport" data-test-open={testVisible}>
        <SceneBoundary resetKey={cameraVersion}>{visible && <FlightSceneCanvas feed={feed} revision={revision} selected={selected} onSelect={setSelected} mode={viewMode} layers={layers} onFps={setFps} groundAltitude={groundPlane.current.altitude} cameraVersion={cameraVersion} editor={editor} />}</SceneBoundary>
        {platformEnabled && <div style={{ position: 'absolute', left: 12, top: 48, color: '#d4e9ed', background: '#17303cdd', padding: '6px 10px', borderRadius: 5, fontSize: 12 }} role="status">移动平台 · {!platformChannelsAvailable ? '订阅通道不足，请减少观察信号' : pose?.platform ? (propertyAgeMs(pose.platform.sampleAt, now) ?? Infinity) < STALE_MS ? '仿真遥测' : '数据已过期 · 保持最后位姿' : '等待完整位姿和尺寸'} · Kenney CC0</div>}
        <div className="scene-viewport-caption">◉ {editor.enabled ? '场景编辑' : `${MODES.find(m => m[0] === mode)?.[1]}视角`} <span>{selected} · {pose?.model || slots[selected] || '等待数据'}</span></div>
        <div className="scene-viewport-tools"><span>N ↑</span><button title="重新定位相机" aria-label="重新定位相机" onClick={() => setCameraVersion(v => v + 1)}>◎</button></div>
        <SceneFlightTestPanel hidden={!testVisible} selected={selected} model={selectedModel} onSelectInstance={setSelected} />
        {!feed.aircraft.size && !editor.enabled && !editor.document.objects.some(object => object.assetId) && <div className="scene-empty"><span>飞行视景已就绪</span><p>连接仿真机后显示实时飞机与航迹</p><button onClick={toggleDemo}>浏览演示场景 →</button></div>}
        {pose && !selectedFresh && <div className="scene-stale" role="status">遥测已过期 · 飞机保持最后位姿</div>}
        <details className="scene-camera-select"><summary><SceneIcon name="camera" />{MODES.find(item => item[0] === viewMode)?.[1]}<SceneIcon name="chevron" /></summary><div className="scene-camera-tabs" aria-label="相机视角">{MODES.map(([key, label]) => <button key={key} disabled={editor.enabled && key !== 'free'} aria-pressed={viewMode === key} className={viewMode === key ? 'active' : ''} onClick={event => { setMode(key); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{label}</button>)}</div></details>
        <button className="scene-minimap-toggle" aria-label="切换小地图" aria-pressed={display.minimap} onClick={() => setDisplay(current => ({ ...current, minimap: !current.minimap }))}><SceneIcon name="map" /><span>小地图</span></button>
        {display.minimap && <MiniMap feed={feed} selected={selected} onSelect={setSelected} />}
        {!editor.enabled && <div className={`scene-instruments ${display.hud ? 'with-hud' : ''}`}>
          {display.numbers && <SceneValueGrid layout={display.values} pose={pose} ground={ground} now={now} demo={demo} editing={panel === 'instruments'} selected={valueSelected}
            onSelect={index => openInstruments(false, index)} onConfigure={() => panel === 'instruments' ? setPanel(null) : openInstruments()}
            onMove={(from, to) => { setDisplay(current => { const cells = [...current.values.cells]; [cells[from], cells[to]] = [cells[to], cells[from]]; return { ...current, values: { ...current.values, cells } }; }); setValueSelected(to); }} />}
          {display.hud && <CircularSceneHud pose={pose} noseUp={display.noseUp} now={now} onConfigure={() => openInstruments(true)} />}
        </div>}
      </div>{display.trend && !editor.enabled && !focus && <div className="scene-trend-drawer"><button className="scene-trend-close" aria-label="收起姿态趋势" onClick={() => setDisplay(current => ({ ...current, trend: false }))}><SceneIcon name="chevron" /></button><Trend history={entry?.history ?? []} selected={selected} /></div>}</main>
      {panel === 'instruments' && !focus && <SceneInstrumentSettings display={display} selected={valueSelected} onSelected={setValueSelected} onChange={setDisplay} onClose={() => setPanel(null)} unavailableKeys={unavailableKeys} initialHud={hudSettings} />}
      {editor.enabled ? <div className="scene-editor-container" hidden={focus || panel !== 'editor'}><SceneEditorPanel model={selectedModel} modelOrigin={demo ? undefined : modelOrigin} sceneLoaded={selectedFresh && (propertyAgeMs(pose?.sceneStatusSampleAt) ?? Infinity) < 2000 ? pose?.sceneLoaded ?? null : null} sceneRevision={pose?.sceneRevision ?? null} sceneContacts={pose?.sceneContacts ?? null} editor={editor} groundAltitude={ground} onGroundLoaded={setGroundAltitude} onCollapse={() => setPanel(null)} /></div> : <aside className="scene-inspector scene-telemetry-inspector" hidden={focus || panel !== 'telemetry'}><header><strong>{selected} · {pose?.model || slots[selected] || '未选择'}</strong><span className={selectedFresh ? 'live' : ''}>{demo ? '演示' : selectedFresh ? '实时' : '等待'}</span><div className="scene-panel-buttons"><button aria-label="固定遥测面板" aria-pressed={display.pinned} onClick={() => setDisplay(current => ({ ...current, pinned: !current.pinned }))}><SceneIcon name="pin" /></button><button aria-label="收起遥测面板" onClick={() => setPanel(null)}><SceneIcon name="close" /></button></div></header>
        <section><h3>飞行状态</h3><div className="scene-metrics">
          <Metric label="离地高度" value={agl} unit="m" /><Metric label="地速" value={pose?.speed} unit="m/s" />
          <Metric label="海拔高度" value={pose?.altitude} unit="m" /><Metric label="航向" value={pose?.yaw} unit="°" />
        </div>{ground === null && <p className="scene-muted">地面高程未知，可在视图设置中指定。</p>}</section>
        <section><h3>地图碰撞</h3><p className="scene-muted">{!selectedFresh || (propertyAgeMs(pose?.sceneStatusSampleAt) ?? Infinity) >= 2000 ? '状态未知 / 数据过期' : pose?.sceneLoaded === 1 ? `已加载版本 ${pose.sceneRevision ?? '未知'} · 接触 ${pose.sceneContacts ?? '未知'}` : pose?.sceneLoaded === -1 ? '地图加载失败' : '未加载碰撞地图'}</p></section>
        <section><h3>姿态</h3><div className="scene-sampling-status scene-pose-status" data-source={pose?.poseSource ?? 'none'}>{!pose ? '等待位姿采样' : !selectedFresh ? '保留上次位姿' : pose.poseSource === 'monitor' ? '位姿高速采样' : '位姿遥测采样'}<span>{sampleAgeText(pose?.receivedAt, now)}</span></div><div className="scene-attitude">
          <div className="scene-horizon"><div style={{ transform: `rotate(${-(pose?.roll ?? 0)}deg) translateY(${Math.max(-25, Math.min(25, pose?.pitch ?? 0))}px)` }} /><i>— · —</i></div>
          <dl><dt>横滚</dt><dd>{format(pose?.roll)}°</dd><dt>俯仰</dt><dd>{format(pose?.pitch)}°</dd><dt>偏航</dt><dd>{format(pose?.yaw)}°</dd></dl>
        </div></section>
        {isMorphQuad(selectedModel) ? <section className="scene-gimbals"><h3>双轴云台 · 四组共轴桨</h3>
          {MORPHQUAD_ARMS.map((arm, i) => <div key={i} className="scene-gimbal-row" data-arm={i}>
            <span>{arm.label}<small>M{i * 2 + 1} / M{i * 2 + 2}</small></span>
            <div><span>外环 α <SampleValue sampleAt={pose?.gimbals[i]?.outerSampleAt} now={now}>{format(pose?.gimbals[i]?.outer == null ? null : pose.gimbals[i].outer! * 180 / Math.PI)}°</SampleValue></span>
              <span>内环 β <SampleValue sampleAt={pose?.gimbals[i]?.innerSampleAt} now={now}>{format(pose?.gimbals[i]?.inner == null ? null : pose.gimbals[i].inner! * 180 / Math.PI)}°</SampleValue></span></div>
          </div>)}
          <p className="scene-muted">显示模型云台角；灰色为上次采样，未收到的角度显示为空，外形暂用零位。</p>
        </section> : <section><h3>{/voliro/i.test(pose?.model ?? '') ? '倾转与推力' : '执行器状态'}</h3>
          <div className="scene-sampling-status scene-mechanism-status" data-source={pose?.tiltSource ?? 'none'}>{pose?.tilt == null ? '等待机构属性' : (propertyAgeMs(pose.tiltSampleAt, now) ?? Infinity) >= STALE_MS ? '保留上次采样' : pose.tiltSource === 'monitor' ? '机构高速采样' : '属性轮询采样'}<span>{sampleAgeText(pose?.tiltSampleAt, now)}</span></div>
          <div className="scene-tilt"><span>共用倾转角</span><SampleValue sampleAt={pose?.tiltSampleAt} now={now}>{pose?.tilt == null ? '—' : `${format(pose.tilt * 180 / Math.PI)}°`}</SampleValue></div>
          <div className="scene-tilt-track"><i style={{ width: `${Math.min(100, Math.abs(pose?.tilt ?? 0) / Math.PI * 100)}%` }} /></div>
          {(pose?.motors ?? [null, null, null, null, null]).map((value, i) => <div className={`scene-motor ${(propertyAgeMs(pose?.motorSampleAt[i], now) ?? 0) >= STALE_MS ? 'stale' : ''}`} key={i}><span>M{i + 1}</span><div className={i === 4 ? 'signed' : ''}>{value !== null && <i style={{ width: `${Math.min(1, Math.abs(value)) * (i === 4 ? 50 : 100)}%`, ...(i === 4 ? { left: value < 0 ? `${50 - Math.min(1, Math.abs(value)) * 50}%` : '50%' } : {}) }} />}</div><SampleValue sampleAt={pose?.motorSampleAt[i]} now={now}>{value === null ? '—' : `${Math.round(value * 100)}%`}</SampleValue></div>)}
          <div className="scene-total"><span>合计有符号推力</span><SampleValue sampleAt={pose?.thrustSampleAt} now={now}>{format(pose?.thrust)} N</SampleValue></div><p className="scene-muted">显示实际采样值；灰色数值为上次采样，悬停可查看采样年龄。尚未收到的属性显示为空。</p>
        </section>}
        <RotorMetrics pose={pose} model={selectedModel} now={now} />
        <section className="scene-position"><h3>位置</h3><span>纬度 <b>{format(pose?.latitude, 7)}°</b></span><span>经度 <b>{format(pose?.longitude, 7)}°</b></span><span>垂直速度 <b>{format(pose?.verticalSpeed)} m/s</b></span></section>
      </aside>}
    </div>
    <footer className="scene-status"><span><i className={`scene-dot ${online ? 'online' : ''}`} />{demo ? '演示模式' : online ? '正在接收仿真数据' : '等待仿真遥测'}</span><span>位姿 {format(hz, 0)} Hz</span><span>渲染 {visible ? fps : 0} FPS</span><span>数据年龄 {pose ? Math.max(0, Math.round(now - pose.receivedAt)) : '—'} ms</span><span>{online} / {ids.length} 在线</span><SceneFlightTestStatus hidden={!testVisible} onRestore={restoreTest} /><small>{demo ? '演示数据 · 不控制仿真机' : '实时视景 · 本地资源'}</small><button aria-pressed={display.trend} disabled={editor.enabled} onClick={toggleTrend}>姿态趋势 <SceneIcon name="chevron" /></button></footer>
  </div>;
}

function sampleAgeText(sampleAt: number | null | undefined, now: number) {
  const age = propertyAgeMs(sampleAt, now);
  return age === null ? '未收到采样' : age < 1000 ? `${Math.round(age)} ms 前` : `${(age / 1000).toFixed(1)} s 前`;
}
function SampleValue({ children, sampleAt, now }: { children: ReactNode; sampleAt: number | null | undefined; now: number }) {
  const age = propertyAgeMs(sampleAt, now);
  return <b className={age !== null && age >= STALE_MS ? 'scene-value-stale' : undefined} title={age === null ? '尚未收到实际采样' : `实际采样于 ${sampleAgeText(sampleAt, now)}`}>{children}</b>;
}

function Metric({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
  return <div><span>{label}</span><strong>{format(value)}<small>{unit}</small></strong></div>;
}

function RotorMetrics({ pose, model, now }: { pose: ScenePose | undefined; model: string; now: number }) {
  const labels = { model: 'JSBSim RPM 状态', bench: '台架估算 · 非模型 RPM', visual: '旋转示意 · 未提供 RPM', none: '未提供模型 RPM' };
  return <section className="scene-rpm"><h3>螺旋桨转速</h3>
    {Array.from({ length: rotorCount(model) }, (_, index) => {
      const reading = pose ? rotorReading(pose, index, now) : null;
      const source = reading?.source ?? 'none';
      return <div className="scene-rpm-row" key={index} data-rotor={index} data-source={source}>
        <span>{rotorLabel(model, index)}<small>{labels[source]}{source === 'model' && index === 4 && pose?.rpmModelVersion != null && pose.rpmTailCalibrated !== true ? ' · 未标定' : ''}</small></span>
        <div><SampleValue sampleAt={reading?.sampleAt} now={now}>{reading?.rpm != null ? `${source === 'bench' ? '≈ ' : ''}${format(reading.rpm, 0)}` : source === 'visual' ? '随输出' : '—'}</SampleValue>{reading?.rpm != null && <small>RPM</small>}</div>
      </div>;
    })}
    <p className="scene-muted">{pose?.rpmModelVersion != null ? '直接读取 JSBSim 独立转速状态。尾桨未标定时采用 KV 空载参考模型。' : /voliro/i.test(model) ? '尚未收到模型 RPM；≈ 为台架估算，尾桨仅旋转示意。' : '显示 JSBSim 螺旋桨 RPM；未提供的转速留空。'} 动画作可视化降速，RPM 数值保持原值。</p>
  </section>;
}
