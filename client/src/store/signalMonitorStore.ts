import { create } from 'zustand';
import { canonicalMonitorProperty, type SignalBinding } from '../sim/monitorIdentity';
import { SignalHistory } from '../sim/signalHistory';
export type { MonitorPoint } from '../sim/signalHistory';

export interface MonitorScope { id: string; graph: string; title: string; position: { x: number; y: number }; channels: SignalBinding[]; windowSeconds?: number }
export interface MonitorProject { version: 1; labels: Record<string, { bindings: SignalBinding[]; offset?: { x: number; y: number } }>; scopes: MonitorScope[] }
export interface MonitorSample { value: number | null; t: number; seen: number; constant: boolean; kind?: string; source?: 'monitor' | 'telemetry'; periodMs?: number; captureT?: number }
const empty = (): MonitorProject => ({ version: 1, labels: {}, scopes: [] });
const capacity = (project: MonitorProject) => new Set([...Object.values(project.labels).flatMap(label => label.bindings), ...project.scopes.flatMap(scope => scope.channels)].map(binding => binding.key)).size <= 32;
export const monitorEdgeId = (graph: string, edge: string) => `${graph}::${edge}`;
const history = new Map<string, SignalHistory>();
export const monitorRecord = (instance: string, key: string) => history.get(`${instance}:${key}`);
export const monitorHistory = (instance: string, key: string) => monitorRecord(instance, key)?.range() || [];

interface MonitorState {
  project: MonitorProject; instance: string; openScope: string | null; armedScope: string | null;
  samples: Record<string, MonitorSample>; running: Record<string, { state: string; t: number; seen: number; generation: string; sequence?: number; revision?: number; dropped?: number; source?: 'monitor' | 'telemetry'; telemetryPacket?: string; telemetryCycleMs?: number }>;
  revisions: Record<string, number>; error: string; tick: number;
  toggleLabel: (graph: string, edge: string, bindings: SignalBinding[]) => void;
  moveLabel: (id: string, offset: { x: number; y: number }) => void;
  addScope: (graph: string, position?: { x: number; y: number }, bindings?: SignalBinding[]) => string;
  patchScope: (id: string, patch: Partial<MonitorScope>) => void;
  removeScope: (id: string) => void; bindScope: (id: string, bindings: SignalBinding[]) => void;
  load: (value?: MonitorProject) => void; ingest: (frame: any) => void; clearHistory: (instance: string, keys: string[]) => void;
}
export const useSignalMonitorStore = create<MonitorState>((set, get) => ({
  project: empty(), instance: '01', openScope: null, armedScope: null, samples: {}, running: {}, revisions: {}, error: '', tick: 0,
  toggleLabel: (graph, edge, bindings) => {
    const id = monitorEdgeId(graph, edge), labels = { ...get().project.labels };
    if (labels[id]) delete labels[id]; else labels[id] = { bindings };
    const project = { ...get().project, labels };
    if (!capacity(project)) { set({ error: '最多同时监视 32 个不同信号，请先关闭一些数值标签或通道。' }); return; }
    set({ project, error: '' });
  },
  moveLabel: (id, offset) => {
    const project = get().project, label = project.labels[id];
    if (label) set({ project: { ...project, labels: { ...project.labels, [id]: { ...label, offset } } } });
  },
  addScope: (graph, position = { x: 300, y: 280 }, bindings = []) => {
    const id = `scope-${crypto.randomUUID()}`;
    const scope = { id, graph, title: `示波器 ${get().project.scopes.length + 1}`, position, channels: bindings, windowSeconds: 30 };
    set({ project: { ...get().project, scopes: [...get().project.scopes, scope] }, armedScope: bindings.length ? null : id });
    return id;
  },
  patchScope: (id, patch) => set({ project: { ...get().project, scopes: get().project.scopes.map(scope => scope.id === id ? { ...scope, ...patch, id } : scope) } }),
  removeScope: id => set({ project: { ...get().project, scopes: get().project.scopes.filter(scope => scope.id !== id) },
    openScope: get().openScope === id ? null : get().openScope, armedScope: get().armedScope === id ? null : get().armedScope }),
  bindScope: (id, bindings) => {
    const scope = get().project.scopes.find(scope => scope.id === id);
    if (!scope) return;
    const channels = [...scope.channels];
    for (const binding of bindings) if (!channels.some(channel => channel.key === binding.key && channel.sign === binding.sign)) channels.push(binding);
    const project = { ...get().project, scopes: get().project.scopes.map(scope => scope.id === id ? { ...scope, channels } : scope) };
    if (!capacity(project)) { set({ error: '最多同时监视 32 个不同信号，请先关闭一些数值标签或通道。' }); return; }
    set({ project, armedScope: null, error: '' });
  },
  load: value => { history.clear(); set({ project: value?.version === 1 && Array.isArray(value.scopes) ? value : empty(), samples: {}, running: {}, openScope: null, armedScope: null }); },
  ingest: frame => {
    if (frame?.kind === 'monitor_status') {
      const instance = String(frame.instance_id || '01'), run = get().running[instance];
      if (run && ['paused', 'stopped'].includes(frame.state)) set({ running: { ...get().running, [instance]: { ...run, state: frame.state, seen: performance.now() } } });
      return;
    }
    if (!frame) return;
    const dedicated = frame.monitor?.version === 1;
    const properties = frame.properties;
    if (!dedicated && (!frame.model || !frame.state || !properties || typeof properties !== 'object' || Array.isArray(properties))) return;
    const number = Number(frame.instance_id ?? 1);
    if (!Number.isInteger(number) || number < 1 || number > 32) return;
    const instance = String(number).padStart(2, '0');
    if (dedicated && frame.monitor.revision !== get().revisions[instance]) return;
    const generation = `${frame.model || ''}:${frame.tree_generation ?? ''}`, previous = get().running[instance];
    const reset = previous && (previous.generation !== generation || dedicated
      && previous.revision !== frame.monitor.revision && Number(frame.timestamp) < previous.t);
    // Never overwrite dedicated samples with slower property-tree slices.
    if (!dedicated && !reset && previous?.source === 'monitor') return;
    const telemetryPacket = dedicated ? undefined : JSON.stringify([frame.timestamp, frame.tree_offset, frame.state, properties]);
    if (!dedicated && !reset && previous?.telemetryPacket === telemetryPacket) return;
    const sequence = dedicated && Number.isSafeInteger(frame.monitor.sequence) ? frame.monitor.sequence as number : undefined;
    if (!reset && sequence !== undefined && previous?.sequence !== undefined && sequence <= previous.sequence) return;
    const missing = !reset && sequence !== undefined && previous?.sequence !== undefined ? Math.max(0, sequence - previous.sequence - 1) : 0;
    if (previous && !reset && Number(frame.timestamp) < previous.t) return;
    const samples = { ...get().samples };
    if (reset) for (const key of Object.keys(samples)) if (key.startsWith(`${instance}:`)) { delete samples[key]; history.delete(key); }
    const now = performance.now() - Math.max(0, Number(frame.age_ms) || 0), t = Number(frame.timestamp ?? frame.t);
    if (!Number.isFinite(t)) return;
    const telemetryCycleMs = dedicated ? undefined : Number(frame.tree_total || 0) / Math.max(1, Object.keys(properties).length)
      * Math.max(50, Math.min(1000, previous && !reset ? now - previous.seen : 50));
    const displayRateHz = Number(frame.display_rate_hz);
    const watchCount = new Set([...Object.values(get().project.labels).flatMap(label => label.bindings), ...get().project.scopes.flatMap(scope => scope.channels)].map(binding => binding.key)).size;
    const monitorCycleMs = dedicated && displayRateHz >= 1 && displayRateHz <= 100
      ? 1000 / displayRateHz * Math.max(1, Math.ceil(watchCount / 4)) : 0;
    const observed: Record<string, unknown> = {};
    if (!dedicated) {
      const keys = new Map<string, string[]>();
      const project = get().project;
      for (const binding of [...Object.values(project.labels).flatMap(label => label.bindings), ...project.scopes.flatMap(scope => scope.channels)]) {
        if (binding.key.startsWith('_monitor/')) continue;
        const canonical = canonicalMonitorProperty(binding.key);
        keys.set(canonical, [...new Set([...(keys.get(canonical) || []), binding.key])]);
      }
      for (const [path, value] of Object.entries(properties)) {
        const owner = /^\/(\d{2})\/jsbsim(?:\[0\])?\//.exec(path)?.[1];
        if ((owner && owner !== instance) || typeof value !== 'number' || !Number.isFinite(value)) continue;
        for (const key of keys.get(canonicalMonitorProperty(path)) || []) observed[key] = [value, t, false];
      }
    }
    for (const [key, tuple] of Object.entries(dedicated ? frame.monitor.samples || {} : observed) as [string, any][]) {
      if (!Array.isArray(tuple) || tuple.length < 3) continue;
      const constant = tuple[2] === true, value = typeof tuple[0] === 'number' && Number.isFinite(tuple[0]) ? tuple[0] : null;
      const sampleTime = constant ? t : typeof tuple[1] === 'number' && Number.isFinite(tuple[1]) ? tuple[1] : t;
      const id = `${instance}:${key}`, old = samples[id];
      if (!dedicated && old?.t === sampleTime && old.value === value) continue;
      const source = dedicated ? 'monitor' : 'telemetry';
      const periodMs = Math.max(dedicated ? monitorCycleMs : telemetryCycleMs || 0,
        old?.source === source ? Math.max((old.periodMs || 0) * 0.9, now - old.seen) : 0);
      samples[id] = { value, t: sampleTime, captureT: t, seen: now, constant, source, periodMs, kind: typeof tuple[3] === 'string' ? ({ p: 'property', v: 'value', t: 'table' } as Record<string, string>)[tuple[3]] || tuple[3] : undefined };
      if (!old || old.t !== sampleTime || old.value !== value) {
        const points = history.get(id) || new SignalHistory();
        if (points.length && sampleTime > points.lastTime! && (missing > 0 || dedicated && sampleTime - points.lastTime! > Math.max(0.5, periodMs / 1000 * 2)))
          points.append((points.lastTime! + sampleTime) / 2, null);
        points.append(sampleTime, value);
        history.set(id, points);
      }
    }
    set({ samples, running: { ...get().running, [instance]: { state: frame.state || 'running', t, seen: now, generation, sequence, revision: dedicated ? frame.monitor.revision : undefined, dropped: (reset ? 0 : previous?.dropped || 0) + missing,
      source: dedicated ? 'monitor' : 'telemetry', telemetryPacket, telemetryCycleMs } }, tick: get().tick + 1 });
  },
  clearHistory: (instance, keys) => { for (const key of keys) history.delete(`${instance}:${key}`); set({ tick: get().tick + 1 }); },
}));

export function sampleText(binding: SignalBinding, instance: string, state = useSignalMonitorStore.getState()): { text: string; status: string } {
  const sample = state.samples[`${instance}:${binding.key}`], run = state.running[instance];
  if (!sample || sample.value === null) return { text: '—', status: sample ? '尚未采到该信号' : run?.source === 'telemetry' ? binding.key.startsWith('_monitor/') ? '内部信号需更新运行端' : '等待属性遥测' : '等待采样' };
  if (binding.expectedKind && sample.kind && binding.expectedKind !== sample.kind) return { text: '—', status: '运行模型结构不匹配' };
  const value = sample.value * (binding.sign ?? 1);
  const text = `${Number(value.toPrecision(7))}${binding.unit ? ` ${binding.unit}` : ''}`;
  const status = !run || performance.now() - run.seen > 2000 ? '断线' : run.state === 'paused' ? '暂停'
    : run.state === 'stopped' ? '停止' : performance.now() - sample.seen > Math.max(2000, (sample.periodMs || (sample.source === 'telemetry' ? run.telemetryCycleMs : 0) || 0) * 2) ? '数据过期'
    : !sample.constant && binding.key.startsWith('_monitor/') && (sample.captureT ?? run.t) - sample.t > 0.1 ? '本步未执行' : sample.source === 'telemetry' ? '低速遥测' : '实时';
  return { text, status };
}
