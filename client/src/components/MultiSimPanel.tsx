import { useEffect, useMemo, useState } from 'react';
import { ftpDownloadModel, ftpDownloadSimConfig, isTauri, listenSimInstances, simInstanceControl, simInstanceSnapshot, simListModels, type SimInstanceSummary } from '../utils/tauriApi';
import { buildFleetInitialGrid, modelGeocentricToGpsLatitude, normalizeFleetNetworkOverrides, type FleetInitialOverrides, type FleetInitialPose, type FleetNetworkOverrides } from '../utils/fleetModelGroups';
import { readHilEndpoints, readHilEndpointsFromNodes, type HilEndpointKey, type HilEndpoints } from '../utils/hilEndpoints';
import { useFlowStore } from '../store/flowStore';
import type { Telemetry } from '../sim/useSimSocket';
import MultiSimMap from './MultiSimMap';
import './MultiSimPanel.css';

const IDS = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0'));
type Action = 'start' | 'stop' | 'pause' | 'resume';
const INITIAL_FIELDS = [
  ['latitudeDeg', '纬度', '°'], ['longitudeDeg', '经度', '°'], ['altitudeM', '海拔', 'm'],
  ['rollDeg', 'Roll', '°'], ['pitchDeg', 'Pitch', '°'], ['yawDeg', 'Yaw', '°'],
] as const;
type InitialKey = (typeof INITIAL_FIELDS)[number][0];
type InitialPose = FleetInitialPose;
type InitialDraft = Record<InitialKey, string>;
type GridDraft = Pick<InitialDraft, 'latitudeDeg' | 'longitudeDeg' | 'altitudeM'>;

function gridDraft(pose?: InitialPose): GridDraft {
  return { latitudeDeg: pose ? String(pose.latitudeDeg) : '',
    longitudeDeg: pose ? String(pose.longitudeDeg) : '',
    altitudeM: pose ? String(pose.altitudeM) : '' };
}

function readInitialPose(config: any): InitialPose {
  const pose = Object.fromEntries(INITIAL_FIELDS.map(([key]) => [key,
    typeof config?.initial?.[key] === 'number' ? config.initial[key] : 0])) as InitialPose;
  pose.latitudeDeg = modelGeocentricToGpsLatitude(pose.latitudeDeg, pose.altitudeM);
  return pose;
}

function initialDraft(pose: InitialPose): InitialDraft {
  return Object.fromEntries(INITIAL_FIELDS.map(([key]) => [key, String(pose[key])])) as InitialDraft;
}

function parseInitialDraft(draft: InitialDraft): InitialPose {
  const pose = {} as InitialPose;
  for (const [key, label] of INITIAL_FIELDS) {
    const value = draft[key].trim();
    if (!value || !Number.isFinite(Number(value))) throw new Error(`${label}必须是有限数值。`);
    pose[key] = Number(value);
  }
  if (Math.abs(pose.latitudeDeg) > 90) throw new Error('纬度必须在 -90～90° 之间。');
  if (Math.abs(pose.longitudeDeg) > 180) throw new Error('经度必须在 -180～180° 之间。');
  if (pose.altitudeM < -1000 || pose.altitudeM > 100000) throw new Error('海拔必须在 -1000～100000 m 之间。');
  if ([pose.rollDeg, pose.pitchDeg, pose.yawDeg].some(value => Math.abs(value) > 360))
    throw new Error('姿态角必须在 -360～360° 之间。');
  return pose;
}

function instanceModelEndpoints(endpoints: HilEndpoints, id: string): HilEndpoints {
  const offset = Number(id) - 1;
  return Object.fromEntries((['input', 'sensor', 'gps'] as const).map(key => {
    const endpoint = endpoints[key];
    return [key, endpoint ? { ...endpoint,
      port: /^\d+$/.test(endpoint.port) ? String(Number(endpoint.port) + offset) : endpoint.port,
    } : null];
  })) as HilEndpoints;
}

function normalizedPath(id: string, path: string): string {
  if (/^\/\d{2}\/jsbsim\//.test(path)) return path;
  if (/^\/jsbsim\[\d+\]\//.test(path)) return `/${id}/jsbsim/${path.replace(/^\/jsbsim\[\d+\]\//, '')}`;
  return `/${id}/jsbsim/${path.replace(/^\/+/, '')}`;
}

function number(value: unknown, digits = 1, unit = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
}

function stateLabel(state: string | undefined, fresh: boolean): string {
  if (!fresh) return '未连接';
  switch (state) {
    case 'running': return '运行中';
    case 'paused': return '已暂停';
    case 'stopped': return '已停止';
    case 'fault': return '故障';
    default: return state || '待更新';
  }
}

interface Props {
  connected: boolean;
  singleTelemetry: Telemetry | null;
  onFleetStateChange: (state: { running: number; paused: number }) => void;
  selected: string;
  onSelect: (id: string) => void;
  slots: Record<string, string>;
  onSlotsChange: (next: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
  initialOverrides: FleetInitialOverrides;
  onInitialOverridesChange: (next: FleetInitialOverrides | ((current: FleetInitialOverrides) => FleetInitialOverrides)) => void;
  networkOverrides: FleetNetworkOverrides;
  onNetworkOverridesChange: (next: FleetNetworkOverrides | ((current: FleetNetworkOverrides) => FleetNetworkOverrides)) => void;
  onOpenLogCenter: () => void;
  onOpenEditor: () => void;
  onPendingChange: (pending: boolean) => void;
}

export default function MultiSimPanel({ connected, singleTelemetry, onFleetStateChange, selected, onSelect, slots, onSlotsChange, initialOverrides, onInitialOverridesChange, networkOverrides, onNetworkOverridesChange, onOpenLogCenter, onOpenEditor, onPendingChange }: Props) {
  const [hilDraft, setHilDraft] = useState<HilEndpoints | null>(null);
  const [hilSource, setHilSource] = useState<{ model: string; display: HilEndpoints; editorDirty: boolean } | null>(null);
  const [hilEnabled, setHilEnabled] = useState(false);
  const [hilLoading, setHilLoading] = useState(false);
  const [hilError, setHilError] = useState('');
  const [hilMessage, setHilMessage] = useState('');
  const [hilRevision, setHilRevision] = useState(0);
  const [initialSource, setInitialSource] = useState<{ model: string; pose: InitialPose } | null>(null);
  const [initialValues, setInitialValues] = useState<InitialDraft | null>(null);
  const [initialEnabled, setInitialEnabled] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [initialMessage, setInitialMessage] = useState('');
  const [initialRevision, setInitialRevision] = useState(0);
  const [gridValues, setGridValues] = useState<GridDraft>(() => gridDraft(initialOverrides['01']));
  const [gridError, setGridError] = useState('');
  const [gridMessage, setGridMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<SimInstanceSummary[]>([]);
  const [snapshot, setSnapshot] = useState<SimInstanceSummary | null>(null);
  const [filter, setFilter] = useState('');
  const [modelsError, setModelsError] = useState('');
  const [view, setView] = useState<'map' | 'detail'>('map');

  const selectedModel = slots[selected] || '';
  useEffect(() => { setGridValues(gridDraft(initialOverrides['01'])); }, [initialOverrides['01']]);
  const selectedOverride = initialOverrides[selected];
  const selectedNetworkOverride = networkOverrides[selected];
  const initialPath = `config/models/${selectedModel.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
  useEffect(() => {
    let alive = true;
    setInitialSource(null);
    setInitialValues(null);
    setInitialError('');
    setInitialMessage('');
    setInitialEnabled(!!selectedOverride);
    if (!selectedModel) { setInitialLoading(false); return; }
    if (!isTauri) {
      setInitialLoading(false);
      setInitialError('当前无法读取模型基础值，仍可设置仿真组覆盖。');
      const pose = readInitialPose({});
      setInitialSource({ model: selectedModel, pose });
      setInitialValues(initialDraft(selectedOverride || pose));
      return;
    }
    setInitialLoading(true);
    void ftpDownloadSimConfig(initialPath).then(result => {
      if (!alive) return;
      const pose = readInitialPose(JSON.parse(result.content));
      setInitialSource({ model: selectedModel, pose });
      setInitialValues(initialDraft(selectedOverride || pose));
    }).catch(error => {
      if (!alive) return;
      const pose = readInitialPose({});
      setInitialSource({ model: selectedModel, pose });
      setInitialValues(initialDraft(selectedOverride || pose));
      setInitialError(`模型基础值读取失败，显示的 0 仅为占位；组覆盖仍可编辑：${String(error)}`);
    })
      .finally(() => { if (alive) setInitialLoading(false); });
    return () => { alive = false; };
  }, [selected, selectedModel, selectedOverride, initialPath, initialRevision]);
  useEffect(() => {
    let alive = true;
    setHilDraft(null);
    setHilSource(null);
    setHilError('');
    setHilMessage('');
    setHilEnabled(!!selectedNetworkOverride);
    if (!selectedModel) { setHilLoading(false); return; }
    if (!isTauri) {
      setHilLoading(false);
      setHilError('请在上位机桌面端连接仿真机后读取模型 XML。');
      return;
    }
    setHilLoading(true);
    void ftpDownloadModel(selectedModel).then(result => {
      if (!alive) return;
      const remote = readHilEndpoints(result.xml);
      let display = remote;
      const state = useFlowStore.getState();
      const mainPath = `aircraft/${selectedModel}/${selectedModel}.xml`;
      if (state.xmlFiles.some(file => file.category === 'main' && file.path === mainPath)) {
        const editor = readHilEndpointsFromNodes(state.nodes);
        display = {
          input: editor.input && remote.input ? editor.input : remote.input,
          sensor: editor.sensor && remote.sensor ? editor.sensor : remote.sensor,
          gps: editor.gps && remote.gps ? editor.gps : remote.gps,
        };
      }
      setHilSource({ model: selectedModel, display: instanceModelEndpoints(display, selected),
        editorDirty: JSON.stringify(display) !== JSON.stringify(remote) });
      setHilDraft(selectedNetworkOverride || instanceModelEndpoints(display, selected));
    }).catch(error => { if (alive) setHilError(`读取 ${selectedModel} 的模型 XML 失败：${String(error)}`); })
      .finally(() => { if (alive) setHilLoading(false); });
    return () => { alive = false; };
  }, [selected, selectedModel, selectedNetworkOverride, hilRevision]);

  const hilEdited = !!hilSource && !!hilDraft &&
    (hilEnabled !== !!selectedNetworkOverride || (hilEnabled &&
      JSON.stringify(hilDraft) !== JSON.stringify(selectedNetworkOverride || hilSource.display)));
  const initialEdited = !!initialSource && !!initialValues && initialSource.model === selectedModel &&
    (initialEnabled !== !!selectedOverride || (initialEnabled &&
      JSON.stringify(initialValues) !== JSON.stringify(initialDraft(selectedOverride || initialSource.pose))));
  useEffect(() => onPendingChange(hilEdited || initialEdited), [hilEdited, initialEdited, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const changeHil = (key: HilEndpointKey, field: 'ip' | 'port', value: string) => {
    setHilDraft(current => current && current[key] ? {
      ...current, [key]: { ...current[key], [field]: value },
    } : current);
    setHilMessage('');
    setHilError('');
  };
  const discardDraft = () => !(hilEdited || initialEdited) ||
    window.confirm('当前仿真组配置尚未保存，离开后会丢失本页修改。继续吗？');

  function saveInitial() {
    if (!initialValues || !initialSource || initialSource.model !== selectedModel) return;
    setInitialError('');
    setInitialMessage('');
    let pose: InitialPose | null = null;
    try { if (initialEnabled) pose = parseInitialDraft(initialValues); }
    catch (error) { setInitialError(String(error instanceof Error ? error.message : error)); return; }
    onInitialOverridesChange(current => {
      const next = { ...current };
      if (pose) next[selected] = pose;
      else delete next[selected];
      return next;
    });
    setInitialValues(initialDraft(pose || initialSource.pose));
    setInitialMessage(pose ? `实例 ${selected} 的覆盖已保存到当前编组，重新启动后生效；可在模型库保存或更新模型组。` : '已恢复使用模型初始状态。');
  }

  function applyInitialGrid() {
    if (!discardDraft()) return;
    setGridError('');
    setGridMessage('');
    try {
      const currentOrigin = initialOverrides['01'];
      const origin = parseInitialDraft({ ...gridValues,
        rollDeg: String(currentOrigin?.rollDeg ?? 0),
        pitchDeg: String(currentOrigin?.pitchDeg ?? 0),
        yawDeg: String(currentOrigin?.yawDeg ?? 0) });
      const grid = buildFleetInitialGrid(origin, 0.5, initialOverrides);
      onInitialOverridesChange(grid);
      setGridMessage('已将 01～08 的初始位置设为 2 行 × 4 列、相邻 0.5 m。重新启动后生效；如需保存在模型库，请更新当前模型组。');
    } catch (error) {
      setGridError(String(error instanceof Error ? error.message : error));
    }
  }

  function saveHil() {
    if (!hilDraft || !hilSource || hilSource.model !== selectedModel) return;
    setHilError('');
    setHilMessage('');
    try {
      const override = hilEnabled ? normalizeFleetNetworkOverrides({ [selected]: hilDraft })[selected] : undefined;
      if (hilEnabled && !override) throw new Error('请检查 IP 和端口；端口须为 1～65535。');
      onNetworkOverridesChange(current => {
        const next = { ...current };
        if (override) next[selected] = override;
        else delete next[selected];
        return next;
      });
      setHilMessage(override ? `实例 ${selected} 的网口覆盖已保存到当前编组，重新启动后生效；可在模型库保存或更新模型组。` : '已恢复使用模型网口配置。');
    } catch (error) {
      setHilError(String(error instanceof Error ? error.message : error));
    }
  }

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    void simListModels().then(items => {
      if (!alive) return;
      setModels([...new Set(items.map(item => String(item?.name || '')).filter(Boolean))].sort());
    }).catch(error => { if (alive) setModelsError(String(error)); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    let dispose: (() => void) | undefined;
    void listenSimInstances(items => { if (alive) setSummaries(items); }).then(unlisten => {
      if (alive) dispose = unlisten;
      else unlisten();
    }).catch(error => { if (alive) setModelsError(String(error)); });
    return () => { alive = false; dispose?.(); };
  }, []);
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const load = () => { void simInstanceSnapshot(selected).then(value => {
      if (alive) setSnapshot(value);
    }).catch(() => { if (alive) setSnapshot(null); }); };
    setSnapshot(null);
    load();
    const timer = window.setInterval(load, 750);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selected]);

  const byId = useMemo(() => new Map(summaries.map(item => [item.instance_id, item])), [summaries]);
  const fallback = connected && singleTelemetry && summaries.length === 0
    ? { ...singleTelemetry, instance_id: '01', age_ms: 0,
        properties: Object.fromEntries(Object.entries(singleTelemetry)
          .filter(([path, value]) => path.startsWith('/') && typeof value === 'number')),
      } as SimInstanceSummary : null;
  const selectedSummary = byId.get(selected) || (selected === '01' ? fallback : null);
  const selectedSnapshot = snapshot?.instance_id === selected ? snapshot :
    (selected === '01' ? fallback : null);
  const fresh = !!selectedSummary && connected && (selectedSummary.age_ms ?? 0) < 2000;
  const live = fresh ? selectedSummary : null;
  const propertyRows = useMemo(() => {
    const properties = fresh ? selectedSnapshot?.properties : null;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
    const query = filter.trim().toLowerCase();
    return Object.entries(properties)
      .filter(([path, value]) => typeof value === 'number' && Number.isFinite(value) &&
        (!query || normalizedPath(selected, path).toLowerCase().includes(query)))
      .map(([path, value]) => [normalizedPath(selected, path), value as number] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [selectedSnapshot, selected, filter, fresh]);
  const connectedCount = IDS.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? 0) < 2000;
  }).length;
  const activeCount = IDS.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? 0) < 2000 && item.state === 'running';
  }).length;
  const pausedCount = IDS.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? 0) < 2000 && item.state === 'paused';
  }).length;
  useEffect(() => { onFleetStateChange({ running: activeCount, paused: pausedCount }); },
    [activeCount, pausedCount, onFleetStateChange]);

  async function sendInstance(id: string, action: Action) {
    if (action === 'start' && !slots[id]) throw new Error(`${id} 未选择模型`);
    return simInstanceControl({ instanceId: id, action,
      ...(action === 'start' ? { model: slots[id], initial: initialOverrides[id], network: networkOverrides[id] } : {}) });
  }

  async function runCommands(ids: string[], action: Action) {
    if (busy) return;
    if (action === 'start' && (hilEdited || initialEdited) && ids.includes(selected)) {
      setCommandMessage('请先保存当前实例的网口与初始状态覆盖，再启动实例。');
      return;
    }
    setBusy(true);
    setCommandMessage('');
    try {
      const outcomes = await Promise.allSettled(ids.map(id => sendInstance(id, action)));
      const failures = outcomes.flatMap((result, index) => result.status === 'rejected'
        ? [`${ids[index]}: ${String(result.reason)}`] : []);
      const sent = outcomes.length - failures.length;
      setCommandMessage(failures.length ? `${sent} 架命令已发送；${failures.join('；')}` : '');
    } finally { setBusy(false); }
  }

  return <main className={`multi-sim-page${view === 'map' ? ' map-view' : ''}`} aria-label="多机仿真">
    <header className="multi-sim-header">
      <div><span className="multi-sim-eyebrow">SIMULATION FLEET</span><h1>多机仿真</h1><p>8 个实例槽位 · 当前已连接 {connectedCount} 架 · {connected ? '仿真机在线' : '等待仿真机连接'}</p></div>
      <div className="multi-sim-header-actions">
        <div className="multi-sim-view-tabs" role="group" aria-label="视图切换">
          <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>地图</button>
          <button type="button" aria-pressed={view === 'detail'} onClick={() => setView('detail')}>实例详情</button>
        </div>
        <button onClick={() => { setView('detail'); window.setTimeout(() => { const panel = document.querySelector<HTMLDetailsElement>('.multi-sim-hil'); if (panel) { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 0); }}>网口配置</button>
        <button onClick={onOpenLogCenter}>日志中心</button>
        <button onClick={() => { if (discardDraft()) onOpenEditor(); }}>模型编辑</button>
      </div>
    </header>
    <details className="multi-sim-grid" aria-label="仿真组初始位置编组">
      <summary>编组初始位置 <span>以实例 01 为起点 · 2 行 × 4 列 · 间距 0.5 m</span></summary>
      <div className="multi-sim-grid-body">
        <div className="multi-sim-grid-fields">
          {([['latitudeDeg', '起点纬度', '° N'], ['longitudeDeg', '起点经度', '° E'], ['altitudeM', '地面海拔', 'm']] as const).map(([key, label, unit]) =>
            <label key={key}>{label}<span><input type="number" step="any" value={gridValues[key]}
              onChange={event => { setGridValues(current => ({ ...current, [key]: event.target.value })); setGridError(''); setGridMessage(''); }} /><em>{unit}</em></span></label>)}
          <button type="button" onClick={applyInitialGrid}>应用到 01～08</button>
        </div>
        <small>01～04 向东排列，05～08 在其南侧一行；只设置仿真组实例初始位置，沿用各实例现有姿态。</small>
        {Object.keys(initialOverrides).length >= 8 && <div className="multi-sim-grid-positions" aria-label="当前编组初始坐标">
          {IDS.map(id => <span key={id}><b>{id}</b> {initialOverrides[id]?.latitudeDeg}°，{initialOverrides[id]?.longitudeDeg}° · {initialOverrides[id]?.altitudeM} m</span>)}
        </div>}
        {gridError && <p className="multi-sim-error" role="alert">{gridError}</p>}
        {gridMessage && <p className="multi-sim-hil-success" role="status">{gridMessage}</p>}
      </div>
    </details>
    <div className="multi-sim-layout">
      <section className="multi-sim-slots" aria-label="实例列表">
        <div className="multi-sim-section-title"><h2>实例</h2><span>{activeCount} / 8 运行中</span></div>
        {IDS.map(id => {
          const item = byId.get(id) || (id === '01' ? fallback : null);
          const online = !!item && connected && (item.age_ms ?? 0) < 2000;
          const state = item ? stateLabel(item.state, online) : '待接入';
          return <button key={id} type="button" className={`multi-sim-slot${selected === id ? ' selected' : ''}`} onClick={() => { if (discardDraft()) onSelect(id); }} aria-pressed={selected === id}>
            <strong>{id}</strong><span className="multi-sim-slot-main"><b>{online ? item?.model || slots[id] || '未命名模型' : slots[id] || '未配置模型'}</b><small>{state}{initialOverrides[id] ? ' · 初始状态覆盖' : ''}{networkOverrides[id] ? ' · 网口覆盖' : ''}{online && typeof item?.timestamp === 'number' ? ` · ${item.timestamp.toFixed(1)} s` : ''}</small></span><i className={online ? item?.state || 'online' : 'offline'} aria-hidden="true" />
          </button>;
        })}
      </section>
      <div className="multi-sim-view">
        {view === 'map' ? <MultiSimMap connected={connected} instances={IDS.map(id => byId.get(id) || (id === '01' ? fallback : null)).filter((item): item is SimInstanceSummary => !!item)} selected={selected} slots={slots} initialOverrides={initialOverrides} onSelect={id => { if (discardDraft()) onSelect(id); }} /> :
      <section className="multi-sim-detail" aria-label={`实例 ${selected} 详情`}>
        <div className="multi-sim-detail-head"><div><span className="multi-sim-eyebrow">INSTANCE {selected} / 08</span><h2>{selectedSummary?.model || slots[selected] || '未配置模型'}</h2></div><span className={`multi-sim-state ${fresh ? selectedSummary?.state || 'online' : 'offline'}`}>{selectedSummary ? stateLabel(selectedSummary.state, fresh) : '待接入'}</span></div>
        <div className="multi-sim-config"><label htmlFor="multi-sim-model">预设模型</label><select id="multi-sim-model" value={slots[selected]} onChange={event => { if (discardDraft()) onSlotsChange(current => ({ ...current, [selected]: event.target.value })); }}><option value="">未选择</option>{slots[selected] && !models.includes(slots[selected]) && <option value={slots[selected]}>{slots[selected]}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select><small>选择板端已安装的网口 HIL 模型。</small>{modelsError && <small className="multi-sim-error">模型列表：{modelsError}</small>}</div>
        <div className="multi-sim-instance-actions"><button disabled={!connected || busy || !slots[selected] || hilEdited || initialEdited} title={hilEdited || initialEdited ? '先保存配置再启动' : undefined} onClick={() => void runCommands([selected], 'start')}>启动实例</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'pause')}>暂停</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'resume')}>继续</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'stop')}>停止</button>{selectedSummary?.state === 'fault' && <span role="alert">{selectedSummary.error || '模型加载失败'}</span>}</div>
        {commandMessage && <p className="multi-sim-command-error" role="alert">{commandMessage}</p>}
        <div className="multi-sim-metrics"><div><span>仿真时间</span><strong>{number(live?.timestamp, 1, ' s')}</strong></div><div><span>高度</span><strong>{number(live?.altitude_m, 1, ' m')}</strong></div><div><span>空速</span><strong>{number(live?.airspeed_mps, 1, ' m/s')}</strong></div><div><span>地速</span><strong>{number(live?.groundspeed_mps, 1, ' m/s')}</strong></div><div><span>纬度</span><strong>{number(live?.latitude_deg, 6)}</strong></div><div><span>经度</span><strong>{number(live?.longitude_deg, 6)}</strong></div><div><span>Roll</span><strong>{number(live?.roll_deg, 1, '°')}</strong></div><div><span>Pitch</span><strong>{number(live?.pitch_deg, 1, '°')}</strong></div><div><span>Yaw</span><strong>{number(live?.yaw_deg, 1, '°')}</strong></div></div>
        <div className="multi-sim-setup-head"><h3>实例配置</h3><span>展开需要调整的项目</span></div>
        <details className="multi-sim-initial" aria-label="初始位置和初始姿态配置">
          <summary><span><strong>初始位置与姿态</strong><small>仿真组覆盖 · {initialEdited ? '有未保存修改' : initialError ? '读取失败' : initialOverrides[selected] ? '已启用' : '使用模型基础值'}</small></span><span className="multi-sim-expand-label" aria-hidden="true">配置</span></summary>
          <div className="multi-sim-expand-body">
            <div className="multi-sim-panel-tools"><small>{selectedModel ? `模型基础值：${initialPath}` : '请先选择模型'}</small><button type="button" disabled={!selectedModel || initialLoading} onClick={() => { if (discardDraft()) setInitialRevision(value => value + 1); }}>重新读取</button></div>
          {initialLoading && <p className="multi-sim-hil-note">正在读取仿真机初始状态…</p>}
          {!initialLoading && !initialValues && !initialError && <p className="multi-sim-hil-note">选择模型后显示初始位置和姿态。</p>}
          {initialValues && <div className="multi-sim-initial-groups">
            <label className="multi-sim-initial-toggle"><input type="checkbox" checked={initialEnabled} onChange={event => { setInitialEnabled(event.target.checked); if (!event.target.checked && initialSource) setInitialValues(initialDraft(initialSource.pose)); setInitialMessage(''); }} />覆盖实例 {selected} 的模型初始状态</label>
            <div><h4>初始位置</h4><div className="multi-sim-initial-fields">{INITIAL_FIELDS.slice(0, 3).map(([key, label, unit]) => <label key={key}>{key === 'altitudeM' && initialEnabled ? '地面海拔' : label}<span><input type="number" step="any" value={initialValues[key]} onChange={event => { setInitialEnabled(true); setInitialValues(current => current && ({ ...current, [key]: event.target.value })); setInitialError(''); setInitialMessage(''); }} aria-label={`实例 ${selected} 初始${key === 'altitudeM' && initialEnabled ? '地面海拔' : label}`} /><em>{unit}</em></span></label>)}</div></div>
            <div><h4>初始姿态</h4><div className="multi-sim-initial-fields">{INITIAL_FIELDS.slice(3).map(([key, label, unit]) => <label key={key}>{label}<span><input type="number" step="any" value={initialValues[key]} onChange={event => { setInitialEnabled(true); setInitialValues(current => current && ({ ...current, [key]: event.target.value })); setInitialError(''); setInitialMessage(''); }} aria-label={`实例 ${selected} 初始${label}`} /><em>{unit}</em></span></label>)}</div></div>
          </div>}
          <div className="multi-sim-hil-foot"><small>模型基础值来自“仿真配置 → 初始状态”。开启覆盖后，海拔表示当前位置的地面海拔，模型按起落架高度放在地面；经纬度按 GPS 坐标解释。组覆盖随启动命令发送，优先于模型配置，同模型实例可设置不同位置和姿态。覆盖中的 0 是实际数值。可在模型库保存当前编组为模型组。</small><button type="button" disabled={!initialEdited || initialLoading} onClick={saveInitial}>保存组覆盖</button></div>
          {initialError && <p className="multi-sim-error" role="alert">{initialError}</p>}
          {initialMessage && <p className="multi-sim-hil-success" role="status">{initialMessage}</p>}
          </div>
        </details>
        <details className="multi-sim-hil" aria-label="仿真组实例网口覆盖">
          <summary><span><strong>网络配置</strong><small>仿真组覆盖 · {hilEdited ? '有未保存修改' : hilError ? '读取失败' : networkOverrides[selected] ? '已启用' : '使用模型基础值'}</small></span><span className="multi-sim-expand-label" aria-hidden="true">配置</span></summary>
          <div className="multi-sim-expand-body">
            <div className="multi-sim-panel-tools"><small>{selectedModel ? `模型基础值：aircraft/${selectedModel}/${selectedModel}.xml` : '请先选择模型'}</small><button type="button" disabled={!selectedModel || hilLoading} onClick={() => { if (discardDraft()) setHilRevision(value => value + 1); }}>重新读取</button></div>
          {hilLoading && <p className="multi-sim-hil-note">正在读取仿真机模型 XML…</p>}
          {hilSource?.editorDirty &&
            <p className="multi-sim-hil-note">当前包含模型编辑页尚未写入仿真机的网口地址。</p>}
          {!hilLoading && !hilDraft && !hilError && <p className="multi-sim-hil-note">选择模型后显示 Input 监听地址以及 HIL_SENSOR、HIL_GPS 输出地址。</p>}
          {hilDraft && <label className="multi-sim-override-toggle"><input type="checkbox" checked={hilEnabled} onChange={event => { setHilEnabled(event.target.checked); setHilError(''); setHilMessage(''); if (!event.target.checked && hilSource) setHilDraft(hilSource.display); }} />覆盖实例 {selected} 的网络配置</label>}
          {hilDraft && <div className="multi-sim-hil-rows">{([
            ['input', 'Input · 执行器接收', '本机监听 IP', '监听端口'],
            ['sensor', 'Output · HIL_SENSOR', 'PX4 目标 IP', '目标端口'],
            ['gps', 'Output · HIL_GPS', 'PX4 目标 IP', '目标端口'],
          ] as const).map(([key, title, ipLabel, portLabel]) => <div className="multi-sim-hil-row" key={key}>
            <strong>{title}</strong>{hilDraft[key] ? <>
              <label>{ipLabel}<input aria-label={`实例 ${selected} ${title} ${ipLabel}`} value={hilDraft[key].ip} onChange={event => { setHilEnabled(true); changeHil(key, 'ip', event.target.value); }} placeholder={key === 'input' ? '0.0.0.0' : '留空沿用模型或板端 IP'} /></label>
              <label>{portLabel}<input aria-label={`实例 ${selected} ${title} ${portLabel}`} inputMode="numeric" value={hilDraft[key].port} onChange={event => { setHilEnabled(true); changeHil(key, 'port', event.target.value); }} placeholder="1～65535" /></label>
            </> : <span className="multi-sim-hil-missing">模型 XML 未配置此节点</span>}</div>)}</div>}
          <div className="multi-sim-hil-foot"><small>未覆盖时显示模型端口加实例编号偏移后的实际端口。Input 是仿真机本机监听地址和端口；两个 Output 可分别指向不同的 PX4 地址。保存的覆盖端口按实际值使用，不再加偏移。组覆盖随启动发送，不修改模型 XML；运行中的实例需重新启动。</small><button type="button" disabled={!hilEdited || hilLoading} onClick={saveHil}>保存组覆盖</button></div>
          {hilError && <p className="multi-sim-error" role="alert">{hilError}</p>}
          {hilMessage && <p className="multi-sim-hil-success" role="status">{hilMessage}</p>}
          </div>
        </details>
        <div className="multi-sim-property-head"><div><h3>属性变量</h3><small>实例编号位于路径最前面 · 最近刷新 {selectedSnapshot ? `${Math.round((selectedSummary?.age_ms ?? 0) / 1000)} s 前` : '待接入'}</small></div><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索属性路径" aria-label="搜索属性路径" /></div>
        <div className="multi-sim-properties">{propertyRows.length ? propertyRows.slice(0, 250).map(([path, value]) => <div key={path}><code>{path}</code><span>{number(value, 4)}</span></div>) : <p>{filter ? '没有匹配的属性' : '等待属性数据'}</p>}{propertyRows.length > 250 && <p>显示前 250 项；请搜索路径缩小范围。</p>}</div>
      </section>}
      </div>
    </div>
  </main>;
}
