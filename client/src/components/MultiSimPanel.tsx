import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ftpDownloadModel, ftpDownloadSimConfig, isTauri, listenSimInstances, simInstanceControl, simInstanceSnapshot, simListModels, type SimInstanceSummary } from '../utils/tauriApi';
import { buildFleetInitialGrid, fleetSlotIds, modelGeocentricToGpsLatitude, nextFleetSlotId, normalizeFleetNetworkOverrides, type FleetInitialOverrides, type FleetInitialPose, type FleetNetworkOverrides } from '../utils/fleetModelGroups';
import { readHilEndpoints, readHilEndpointsFromNodes, type HilEndpointKey, type HilEndpoints } from '../utils/hilEndpoints';
import { useFlowStore } from '../store/flowStore';
import type { Telemetry } from '../sim/useSimSocket';
import MultiSimMap from './MultiSimMap';
import FleetInstanceList from './FleetInstanceList';
import './MultiSimPanel.css';

const FLEET_SPLIT_RATIO_KEY = 'jsbsim-fleet-split-ratio-v1';
const MIN_LIST_WIDTH = 300;
const MIN_VIEW_WIDTH = 360;
const SPLIT_HANDLE_WIDTH = 12;
type Action = 'start' | 'stop' | 'pause' | 'resume';

function readFleetSplitRatio(): number | null {
  try {
    const saved = localStorage.getItem(FLEET_SPLIT_RATIO_KEY);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
  } catch { return null; }
}

function saveFleetSplitRatio(value: number | null) {
  try {
    if (value === null) localStorage.removeItem(FLEET_SPLIT_RATIO_KEY);
    else localStorage.setItem(FLEET_SPLIT_RATIO_KEY, value.toFixed(4));
  } catch { /* The divider remains adjustable for this session. */ }
}

function boundedFleetSplitRatio(totalWidth: number, listWidth: number): number {
  const maxListWidth = Math.max(MIN_LIST_WIDTH, totalWidth - MIN_VIEW_WIDTH - SPLIT_HANDLE_WIDTH);
  return Math.min(maxListWidth, Math.max(MIN_LIST_WIDTH, listWidth)) / totalWidth;
}
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

const INSTANCE_FRESH_MS = 2000;
const INSTANCE_DISCONNECTED_MS = 10000;

function stateLabel(state: string | undefined, ageMs: number | undefined, connected: boolean): string {
  if (!connected || ageMs === undefined || ageMs >= INSTANCE_DISCONNECTED_MS) return '未连接';
  if (ageMs >= INSTANCE_FRESH_MS) return '遥测延迟';
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
  const ids = fleetSlotIds(slots);
  const firstId = ids[0] || '01';
  const [copiedSlot, setCopiedSlot] = useState<{ sourceId: string; model: string;
    initial?: FleetInitialPose; network?: FleetNetworkOverrides[string] } | null>(null);
  const [slotActionMessage, setSlotActionMessage] = useState('');
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
  const [gridValues, setGridValues] = useState<GridDraft>(() => gridDraft(initialOverrides[firstId]));
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
  const [listRatio, setListRatio] = useState(readFleetSplitRatio);
  const gridDialogRef = useRef<HTMLDialogElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLElement>(null);
  const splitHandleRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ pointerId: number; left: number; width: number; value: number } | null>(null);

  useEffect(() => {
    const layout = layoutRef.current;
    const slots = slotsRef.current;
    const handle = splitHandleRef.current;
    if (!layout || !slots || !handle) return;
    const syncValue = () => {
      if (getComputedStyle(handle).display === 'none') return;
      const width = layout.getBoundingClientRect().width;
      if (!width) return;
      const listWidth = slots.getBoundingClientRect().width;
      handle.setAttribute('aria-valuemin', String(Math.ceil(MIN_LIST_WIDTH / width * 100)));
      handle.setAttribute('aria-valuemax', String(Math.floor((width - MIN_VIEW_WIDTH - SPLIT_HANDLE_WIDTH) / width * 100)));
      handle.setAttribute('aria-valuenow', String(Math.round(listWidth / width * 100)));
      handle.setAttribute('aria-valuetext', `实例列表宽 ${Math.round(listWidth)} 像素`);
    };
    const observer = new ResizeObserver(syncValue);
    observer.observe(layout);
    observer.observe(slots);
    syncValue();
    return () => observer.disconnect();
  }, []);

  function beginSplitDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !layoutRef.current || !slotsRef.current) return;
    const rect = layoutRef.current.getBoundingClientRect();
    splitDragRef.current = { pointerId: event.pointerId, left: rect.left, width: rect.width,
      value: slotsRef.current.getBoundingClientRect().width / rect.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function updateSplitDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.value = boundedFleetSplitRatio(drag.width, event.clientX - drag.left);
    layoutRef.current?.style.setProperty('--fleet-list-width', `${drag.value * 100}%`);
  }

  function endSplitDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setListRatio(drag.value);
    saveFleetSplitRatio(drag.value);
  }

  function cancelSplitDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (listRatio === null) layoutRef.current?.style.removeProperty('--fleet-list-width');
    else layoutRef.current?.style.setProperty('--fleet-list-width', `${listRatio * 100}%`);
  }

  function adjustSplitByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!layoutRef.current || !slotsRef.current) return;
    const width = layoutRef.current.getBoundingClientRect().width;
    const current = slotsRef.current.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    const target = event.key === 'ArrowLeft' ? current - step
      : event.key === 'ArrowRight' ? current + step
      : event.key === 'Home' ? MIN_LIST_WIDTH
      : event.key === 'End' ? width - MIN_VIEW_WIDTH - SPLIT_HANDLE_WIDTH : null;
    if (target === null) return;
    event.preventDefault();
    const ratio = boundedFleetSplitRatio(width, target);
    setListRatio(ratio);
    saveFleetSplitRatio(ratio);
  }

  function resetSplit() {
    splitDragRef.current = null;
    layoutRef.current?.style.removeProperty('--fleet-list-width');
    setListRatio(null);
    saveFleetSplitRatio(null);
  }

  const selectedModel = slots[selected] || '';
  useEffect(() => { setGridValues(gridDraft(initialOverrides[firstId])); }, [firstId, initialOverrides[firstId]]);
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
      const currentOrigin = initialOverrides[firstId];
      const origin = parseInitialDraft({ ...gridValues,
        rollDeg: String(currentOrigin?.rollDeg ?? 0),
        pitchDeg: String(currentOrigin?.pitchDeg ?? 0),
        yawDeg: String(currentOrigin?.yawDeg ?? 0) });
      const grid = buildFleetInitialGrid(origin, 0.5, initialOverrides, ids);
      onInitialOverridesChange(grid);
      setGridMessage(`已将 ${ids.length} 个槽位的初始位置按每行 4 列、相邻 0.5 m 排列。重新启动后生效；如需保存在模型库，请更新当前模型组。`);
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
  const selectedRuntime = byId.get(selected);
  const selectedRunning = connected && !!selectedRuntime &&
    (selectedRuntime.age_ms ?? Infinity) < INSTANCE_DISCONNECTED_MS &&
    (selectedRuntime.state === 'running' || selectedRuntime.state === 'paused');
  const canRemoveSlot = ids.length > 1 && !selectedRunning;
  const canPasteSlot = !!copiedSlot && copiedSlot.sourceId !== selected && !selectedRunning;

  function addSlot() {
    const id = nextFleetSlotId(slots);
    if (!id || !discardDraft()) return;
    onSlotsChange(current => ({ ...current, [id]: '' }));
    onSelect(id);
    setSlotActionMessage(`已添加槽位 ${id}。`);
  }

  function removeSlot() {
    if (!canRemoveSlot || !discardDraft() ||
        !window.confirm(`删除槽位 ${selected}？该槽位的模型绑定、初始状态和网络配置将被移除；其他槽位编号不变。`)) return;
    const remaining = ids.filter(id => id !== selected);
    const nextSelected = remaining[Math.min(ids.indexOf(selected), remaining.length - 1)];
    onSlotsChange(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected)));
    onSelect(nextSelected);
    setSlotActionMessage(`已删除槽位 ${selected}。`);
  }

  function copySlot() {
    if (hilEdited || initialEdited) {
      setSlotActionMessage('请先保存当前槽位的初始状态和网口配置，再复制。');
      return;
    }
    const network = networkOverrides[selected];
    setCopiedSlot({ sourceId: selected, model: slots[selected] || '',
      initial: initialOverrides[selected] ? { ...initialOverrides[selected] } : undefined,
      network: network ? {
        input: network.input ? { ...network.input } : null,
        sensor: network.sensor ? { ...network.sensor } : null,
        gps: network.gps ? { ...network.gps } : null,
      } : undefined });
    setSlotActionMessage(`已复制槽位 ${selected} 的配置；选择目标槽位后可粘贴。`);
  }

  function pasteSlot() {
    if (!copiedSlot || !canPasteSlot || !discardDraft()) return;
    if ((slots[selected] || initialOverrides[selected] || networkOverrides[selected]) &&
        !window.confirm(`将槽位 ${copiedSlot.sourceId} 的配置粘贴到 ${selected}？目标槽位现有配置会被覆盖。`)) return;
    onSlotsChange(current => ({ ...current, [selected]: copiedSlot.model }));
    onInitialOverridesChange(current => {
      const next = { ...current };
      if (copiedSlot.initial) next[selected] = { ...copiedSlot.initial };
      else delete next[selected];
      return next;
    });
    onNetworkOverridesChange(current => {
      const next = { ...current };
      if (copiedSlot.network) next[selected] = {
        input: copiedSlot.network.input ? { ...copiedSlot.network.input } : null,
        sensor: copiedSlot.network.sensor ? { ...copiedSlot.network.sensor } : null,
        gps: copiedSlot.network.gps ? { ...copiedSlot.network.gps } : null,
      };
      else delete next[selected];
      return next;
    });
    setSlotActionMessage(`已将槽位 ${copiedSlot.sourceId} 的配置粘贴到 ${selected}；重新启动实例后生效。${copiedSlot.initial || copiedSlot.network ? '初始位置和网口参数按原值复制，请在同时运行前检查。' : ''}`);
  }

  const fallback = connected && singleTelemetry && summaries.length === 0
    ? { ...singleTelemetry, instance_id: '01', age_ms: 0,
        properties: Object.fromEntries(Object.entries(singleTelemetry)
          .filter(([path, value]) => path.startsWith('/') && typeof value === 'number')),
      } as SimInstanceSummary : null;
  const selectedSummary = byId.get(selected) || (selected === '01' ? fallback : null);
  const selectedSnapshot = snapshot?.instance_id === selected ? snapshot :
    (selected === '01' ? fallback : null);
  const fresh = !!selectedSummary && connected && (selectedSummary.age_ms ?? Infinity) < INSTANCE_FRESH_MS;
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
  const connectedCount = ids.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? Infinity) < INSTANCE_FRESH_MS;
  }).length;
  const activeCount = ids.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? Infinity) < INSTANCE_FRESH_MS && item.state === 'running';
  }).length;
  const pausedCount = ids.filter(id => {
    const item = byId.get(id) || (id === '01' ? fallback : null);
    return !!item && connected && (item.age_ms ?? Infinity) < INSTANCE_FRESH_MS && item.state === 'paused';
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
      <div><span className="multi-sim-eyebrow">SIMULATION FLEET</span><h1>多机仿真</h1><p>{ids.length} 个实例槽位 · 当前已连接 {connectedCount} 架 · {connected ? '仿真机在线' : '等待仿真机连接'}</p></div>
      <div className="multi-sim-header-actions">
        <button type="button" aria-haspopup="dialog" onClick={() => gridDialogRef.current?.showModal()}>编组初始位置</button>
        <div className="multi-sim-view-tabs" role="group" aria-label="视图切换">
          <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>地图</button>
          <button type="button" aria-pressed={view === 'detail'} onClick={() => setView('detail')}>实例详情</button>
        </div>
        <button onClick={() => { setView('detail'); window.setTimeout(() => { const panel = document.querySelector<HTMLDetailsElement>('.multi-sim-hil'); if (panel) { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 0); }}>网口配置</button>
        <button onClick={onOpenLogCenter}>日志中心</button>
        <button onClick={() => { if (discardDraft()) onOpenEditor(); }}>模型编辑</button>
      </div>
    </header>
    <dialog ref={gridDialogRef} className="multi-sim-grid" aria-labelledby="multi-sim-grid-title">
      <div className="multi-sim-grid-head">
        <div><h2 id="multi-sim-grid-title">编组初始位置</h2><p>以实例 {firstId} 为起点 · 每行 4 列 · 间距 0.5 m</p></div>
        <button type="button" onClick={() => gridDialogRef.current?.close()} aria-label="关闭编组初始位置弹窗">关闭</button>
      </div>
      <div className="multi-sim-grid-body">
        <div className="multi-sim-grid-fields">
          {([['latitudeDeg', '起点纬度', '° N'], ['longitudeDeg', '起点经度', '° E'], ['altitudeM', '地面海拔', 'm']] as const).map(([key, label, unit]) =>
            <label key={key}>{label}<span><input type="number" step="any" value={gridValues[key]}
              onChange={event => { setGridValues(current => ({ ...current, [key]: event.target.value })); setGridError(''); setGridMessage(''); }} /><em>{unit}</em></span></label>)}
          <button type="button" onClick={applyInitialGrid}>应用到当前 {ids.length} 个槽位</button>
        </div>
        <small>从槽位 {firstId} 开始，每行 4 列向东、逐行向南排列；只设置仿真组实例初始位置，沿用各实例现有姿态。</small>
        {ids.every(id => !!initialOverrides[id]) && <div className="multi-sim-grid-positions" aria-label="当前编组初始坐标">
          {ids.map(id => <span key={id}><b>{id}</b> {initialOverrides[id]?.latitudeDeg}°，{initialOverrides[id]?.longitudeDeg}° · {initialOverrides[id]?.altitudeM} m</span>)}
        </div>}
        {gridError && <p className="multi-sim-error" role="alert">{gridError}</p>}
        {gridMessage && <p className="multi-sim-hil-success" role="status">{gridMessage}</p>}
      </div>
    </dialog>
    <div ref={layoutRef} className="multi-sim-layout"
      style={{ '--fleet-list-width': listRatio === null ? undefined : `${listRatio * 100}%` } as CSSProperties}>
      <section ref={slotsRef} className="multi-sim-slots" aria-label="实例列表">
        <FleetInstanceList slots={slots} summaries={summaries} fallback={fallback} connected={connected}
          selected={selected} onSelect={id => { if (discardDraft()) onSelect(id); }}
          onAddSlot={addSlot} onRemoveSlot={removeSlot} onCopySlot={copySlot} onPasteSlot={pasteSlot}
          copiedFrom={copiedSlot?.sourceId || null} canRemove={canRemoveSlot} canPaste={canPasteSlot}
          actionMessage={slotActionMessage} />
      </section>
      <div ref={splitHandleRef} className="multi-sim-resize-handle" role="separator"
        tabIndex={0} aria-orientation="vertical" aria-label="调整实例列表和右侧区域宽度"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={34}
        title="拖动调整宽度；方向键微调；双击恢复自适应"
        onPointerDown={beginSplitDrag} onPointerMove={updateSplitDrag}
        onPointerUp={endSplitDrag} onPointerCancel={cancelSplitDrag}
        onLostPointerCapture={cancelSplitDrag} onKeyDown={adjustSplitByKeyboard}
        onDoubleClick={resetSplit} />
      <div className="multi-sim-view">
        {view === 'map' ? <MultiSimMap connected={connected} instances={ids.map(id => byId.get(id) || (id === '01' ? fallback : null)).filter((item): item is SimInstanceSummary => !!item)} selected={selected} slots={slots} initialOverrides={initialOverrides} onSelect={id => { if (discardDraft()) onSelect(id); }} /> :
      <section className="multi-sim-detail" aria-label={`实例 ${selected} 详情`}>
        <div className="multi-sim-detail-head"><div><span className="multi-sim-eyebrow">INSTANCE {selected} / {String(ids.length).padStart(2, '0')}</span><h2>{selectedSummary?.model || slots[selected] || '未配置模型'}</h2></div><span className={`multi-sim-state ${fresh ? selectedSummary?.state || 'online' : connected && (selectedSummary?.age_ms ?? Infinity) < INSTANCE_DISCONNECTED_MS ? 'delayed' : 'offline'}`}>{selectedSummary ? stateLabel(selectedSummary.state, selectedSummary.age_ms, connected) : '待接入'}</span></div>
        <div className="multi-sim-config"><label htmlFor="multi-sim-model">预设模型</label><select id="multi-sim-model" value={slots[selected]} onChange={event => { if (discardDraft()) onSlotsChange(current => ({ ...current, [selected]: event.target.value })); }}><option value="">未选择</option>{slots[selected] && !models.includes(slots[selected]) && <option value={slots[selected]}>{slots[selected]}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select><small>选择板端已安装的网口 HIL 模型。</small>{modelsError && <small className="multi-sim-error">模型列表：{modelsError}</small>}</div>
        <div className="multi-sim-instance-actions"><button disabled={!connected || busy || !slots[selected] || hilEdited || initialEdited} title={hilEdited || initialEdited ? '先保存配置再启动' : undefined} onClick={() => void runCommands([selected], 'start')}>启动实例</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'pause')}>暂停</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'resume')}>继续</button><button disabled={!connected || busy} onClick={() => void runCommands([selected], 'stop')}>停止</button>{selectedSummary?.state === 'fault' && <span role="alert">{selectedSummary.error || '模型加载失败'}</span>}</div>
        {commandMessage && <p className="multi-sim-command-error" role="alert">{commandMessage}</p>}
        <div className="multi-sim-metrics"><div><span>仿真时间</span><strong>{number(live?.timestamp, 1, ' s')}</strong></div><div><span>实时倍率</span><strong>{number(live?.realtime_factor, 2, '×')}</strong></div><div><span>高度</span><strong>{number(live?.altitude_m, 1, ' m')}</strong></div><div><span>空速</span><strong>{number(live?.airspeed_mps, 1, ' m/s')}</strong></div><div><span>地速</span><strong>{number(live?.groundspeed_mps, 1, ' m/s')}</strong></div><div><span>纬度</span><strong>{number(live?.latitude_deg, 6)}</strong></div><div><span>经度</span><strong>{number(live?.longitude_deg, 6)}</strong></div><div><span>Roll</span><strong>{number(live?.roll_deg, 1, '°')}</strong></div><div><span>Pitch</span><strong>{number(live?.pitch_deg, 1, '°')}</strong></div><div><span>Yaw</span><strong>{number(live?.yaw_deg, 1, '°')}</strong></div></div>
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
