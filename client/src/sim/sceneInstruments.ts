import { canonicalMonitorProperty } from './monitorIdentity';
import { propertyAgeMs, STALE_MS, type ScenePose } from './flightSceneState';
import { rotorReading } from './sceneRotors';
import { windReading } from './sceneWind';

export type SceneValue = { source: string; label: string; unit: string; precision: number; path: string; scale: number; offset: number };
export type SceneValueLayout = { rows: number; columns: number; cells: (SceneValue | null)[]; overflow: SceneValue[] };
export type SceneDisplay = { version: 1; values: SceneValueLayout; numbers: boolean; hud: boolean; minimap: boolean; trend: boolean; pinned: boolean; noseUp: boolean };
export type ValueReading = { text: string; stale: boolean; status: string; sampleAt: number | null };
export const SCENE_DISPLAY_KEY = 'jsbsim-flight-scene-display-v1';
export const MAX_VALUE_ROWS = 6, MAX_VALUE_COLUMNS = 8;
export const SCENE_VALUE_SOURCES = [
  { id: 'agl', label: '离地高', unit: 'm' }, { id: 'speed', label: '地速', unit: 'm/s' },
  { id: 'time', label: '仿真时间', unit: '' }, { id: 'roll', label: '横滚', unit: '°' },
  { id: 'tilt', label: '倾转角', unit: '°' }, { id: 'altitude', label: '海拔', unit: 'm' },
  { id: 'verticalSpeed', label: '垂速', unit: 'm/s' }, { id: 'wind', label: '风速', unit: 'm/s' },
  { id: 'pitch', label: '俯仰', unit: '°' }, { id: 'thrust', label: '推力', unit: 'N' },
  { id: 'heading', label: '航向', unit: '°' }, { id: 'latitude', label: '纬度', unit: '°' },
  { id: 'longitude', label: '经度', unit: '°' }, { id: 'windFrom', label: '风向', unit: '°' },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `rpm${i}`, label: `M${i + 1} 转速`, unit: 'RPM' })),
  ...Array.from({ length: 8 }, (_, i) => ({ id: `motor${i}`, label: `M${i + 1} 输出`, unit: '%' })),
  { id: 'custom', label: '自定义属性', unit: '' },
];
export function newSceneValue(source: string): SceneValue {
  const definition = SCENE_VALUE_SOURCES.find(item => item.id === source) ?? SCENE_VALUE_SOURCES[0];
  return { source: definition.id, label: definition.label, unit: definition.unit, precision: source === 'time' || source.startsWith('rpm') ? 0 : 1, path: '', scale: 1, offset: 0 };
}
export function defaultSceneDisplay(): SceneDisplay {
  return { version: 1, values: { rows: 2, columns: 5, cells: SCENE_VALUE_SOURCES.slice(0, 10).map(item => newSceneValue(item.id)), overflow: [] },
    numbers: true, hud: true, minimap: false, trend: false, pinned: false, noseUp: false };
}
const bounded = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.trunc(v))) : fallback;
export function sceneCustomPath(path: string): string {
  // Property paths, never XML expressions or commands. Strip the tree's owner prefix.
  const value = canonicalMonitorProperty(path.trim());
  return value.length <= 200 && /^[a-zA-Z_][a-zA-Z0-9_./[\]-]*$/.test(value) && !value.split('/').includes('..') ? value : '';
}
export function decodeSceneDisplay(value: unknown): SceneDisplay {
  const defaults = defaultSceneDisplay();
  if (!value || typeof value !== 'object' || (value as any).version !== 1) return defaults;
  const raw = value as Partial<SceneDisplay>, input = raw.values;
  const rows = bounded(input?.rows, 2, 1, MAX_VALUE_ROWS), columns = bounded(input?.columns, 5, 1, MAX_VALUE_COLUMNS);
  const cell = (entry: unknown): SceneValue | null => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as SceneValue;
    if (!SCENE_VALUE_SOURCES.some(source => source.id === item.source)) return null;
    const base = newSceneValue(item.source);
    const unit = typeof item.unit === 'string' ? item.unit.slice(0, 16) : base.unit;
    return { ...base, label: typeof item.label === 'string' ? item.label.slice(0, 24) : base.label,
      unit: item.source === 'custom' || sceneUnitOptions(item.source).includes(unit) ? unit : base.unit, precision: bounded(item.precision, base.precision, 0, 6),
      path: typeof item.path === 'string' ? sceneCustomPath(item.path) : '',
      scale: typeof item.scale === 'number' && Number.isFinite(item.scale) ? item.scale : 1,
      offset: typeof item.offset === 'number' && Number.isFinite(item.offset) ? item.offset : 0 };
  };
  const cells = Array.isArray(input?.cells) ? input.cells.slice(0, 48).map(cell) : defaults.values.cells;
  const overflow = Array.isArray(input?.overflow) ? input.overflow.slice(0, 128).map(cell).filter((item): item is SceneValue => item !== null) : [];
  const result = { ...defaults, values: resizeSceneValues({ rows, columns, cells, overflow }, rows, columns) };
  for (const key of ['numbers', 'hud', 'minimap', 'trend', 'pinned', 'noseUp'] as const) if (typeof raw[key] === 'boolean') result[key] = raw[key];
  return result;
}
export function loadSceneDisplay(): SceneDisplay {
  try { return decodeSceneDisplay(JSON.parse(localStorage.getItem(SCENE_DISPLAY_KEY) || 'null')); } catch { return defaultSceneDisplay(); }
}
export function resizeSceneValues(layout: SceneValueLayout, rows: number, columns: number): SceneValueLayout {
  rows = bounded(rows, layout.rows, 1, MAX_VALUE_ROWS); columns = bounded(columns, layout.columns, 1, MAX_VALUE_COLUMNS);
  const capacity = rows * columns;
  const cells = Array.from({ length: capacity }, (_, i) => layout.cells[i] ?? null);
  return { rows, columns, cells, overflow: [...layout.overflow, ...layout.cells.slice(capacity).filter((cell): cell is SceneValue => cell !== null)] };
}
export const sceneValueKeys = (layout: SceneValueLayout): string[] => [...new Set(layout.cells.flatMap(cell => cell?.source === 'custom' && sceneCustomPath(cell.path) ? [sceneCustomPath(cell.path)] : []))];
export function sceneUnitOptions(source: string): string[] {
  const unit = SCENE_VALUE_SOURCES.find(item => item.id === source)?.unit ?? '';
  return ({ m: ['m', 'ft'], 'm/s': ['m/s', 'km/h', 'kts'], '°': ['°', 'rad'], N: ['N', 'lbf'], RPM: ['RPM', 'rad/s'], '%': ['%', 'norm'] } as Record<string, string[]>)[unit] ?? [unit];
}
function converted(value: number, base: string, unit: string): number {
  if (base === unit) return value;
  const factor: Record<string, number> = { 'm:ft': 1 / .3048, 'm/s:km/h': 3.6, 'm/s:kts': 1 / .5144444444,
    '°:rad': Math.PI / 180, 'N:lbf': 1 / 4.4482216153, 'RPM:rad/s': Math.PI / 30, '%:norm': .01 };
  return value * (factor[`${base}:${unit}`] ?? 1);
}
export type CustomValueSample = { value: number | null; seen: number; generation: string };
export function sceneValueReading(cell: SceneValue, pose: ScenePose | undefined, ground: number | null, now: number, custom?: CustomValueSample): ValueReading {
  let value: number | null | undefined = null, sampleAt: number | null = pose?.receivedAt ?? null, prefix = '', note = '';
  const source = cell.source;
  if (pose) {
    if (source === 'agl') { value = ground === null ? null : pose.altitude - ground; sampleAt = pose.groundSampleAt == null ? pose.receivedAt : Math.min(pose.receivedAt, pose.groundSampleAt); }
    else if (source === 'heading') value = ((pose.yaw % 360) + 360) % 360;
    else if (['speed', 'time', 'roll', 'altitude', 'verticalSpeed', 'pitch', 'latitude', 'longitude'].includes(source)) value = pose[source as 'speed'];
    else if (source === 'tilt') { value = pose.tilt == null ? null : pose.tilt * 180 / Math.PI; sampleAt = pose.tiltSampleAt; }
    else if (source === 'thrust') { value = pose.thrust; sampleAt = pose.thrustSampleAt; }
    else if (source === 'wind' || source === 'windFrom') { const wind = windReading(pose, now); value = source === 'wind' ? wind.horizontal : wind.fromDegrees; sampleAt = pose.windSampleAt; }
    else if (source.startsWith('motor')) { const i = Number(source.slice(5)); value = pose.motors[i] == null ? null : pose.motors[i]! * 100; sampleAt = pose.motorSampleAt[i] ?? null; }
    else if (source.startsWith('rpm')) { const reading = rotorReading(pose, Number(source.slice(3)), now); value = reading.rpm; sampleAt = reading.sampleAt;
      if (reading.source === 'bench') { prefix = '≈ '; note = '台架估算 · 非模型 RPM'; } }
    else if (source === 'custom' && custom?.generation === `${pose.model}:${pose.generation}`) { value = custom.value == null ? null : custom.value * cell.scale + cell.offset; sampleAt = custom.seen; }
  }
  const age = propertyAgeMs(sampleAt, now), stale = age !== null && age >= STALE_MS;
  let text = '—';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (source === 'time') { const t = Math.max(0, Math.floor(value)); text = `${Math.floor(t / 3600).toString().padStart(2, '0')}:${Math.floor(t / 60 % 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}`; }
    else { const base = SCENE_VALUE_SOURCES.find(item => item.id === source)?.unit ?? cell.unit; const v = source === 'custom' ? value : converted(value, base, cell.unit); text = prefix + (Math.abs(v) >= 1e9 ? v.toExponential(cell.precision) : v.toFixed(cell.precision)); }
  }
  const status = text === '—' ? '尚未收到有效采样' : stale ? `数据过期 · ${((age ?? 0) / 1000).toFixed(1)} s 前` : pose?.state === 'paused' ? '仿真已暂停' : pose?.state === 'stopped' ? '仿真已停止' : '实时采样';
  return { text, stale, status: [note, status].filter(Boolean).join(' · '), sampleAt };
}

export function compassAttitude(yaw: number, roll: number, pitch: number, noseUp: boolean) {
  const heading = ((yaw % 360) + 360) % 360;
  return { heading, dial: noseUp ? -heading : 0, arrow: noseUp ? 0 : heading,
    rollArc: Math.max(-30, Math.min(30, roll)), pitchArc: Math.max(-30, Math.min(30, -pitch)) };
}
