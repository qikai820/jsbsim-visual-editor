import type { SimInstanceSummary } from './tauriApi';

export const FLEET_LIST_DISPLAY_KEY = 'jsbsim-fleet-list-display-v2';
const LEGACY_FLEET_LIST_DISPLAY_KEY = 'jsbsim-fleet-list-display-v1';
export const MAX_FLEET_LIST_FIELDS = 12;
export const DEFAULT_FLEET_COLUMN_GAP = 2;
export const MAX_FLEET_COLUMN_GAP = 20;

export const BUILTIN_FLEET_FIELDS = [
  { key: 'altitude_m', label: '高度', unit: 'm', digits: 1, icon: 'up' },
  { key: 'groundspeed_mps', label: '地速', unit: 'm/s', digits: 1, icon: 'right' },
  { key: 'timestamp', label: '时间', unit: 's', digits: 1, icon: 'time' },
  { key: 'airspeed_mps', label: '空速', unit: 'm/s', digits: 1, icon: 'up' },
  { key: 'realtime_factor', label: '实时倍率', unit: '×', digits: 2, icon: null },
  { key: 'latitude_deg', label: '纬度', unit: '°', digits: 6, icon: null },
  { key: 'longitude_deg', label: '经度', unit: '°', digits: 6, icon: null },
  { key: 'roll_deg', label: 'Roll', unit: '°', digits: 1, icon: null },
  { key: 'pitch_deg', label: 'Pitch', unit: '°', digits: 1, icon: null },
  { key: 'yaw_deg', label: 'Yaw', unit: '°', digits: 1, icon: null },
] as const;

export type FleetBuiltinKey = (typeof BUILTIN_FLEET_FIELDS)[number]['key'];
export type FleetListField =
  | { kind: 'builtin'; key: FleetBuiltinKey }
  | { kind: 'property'; path: string; label: string; unit: string; digits: number };
export type FleetListDisplay = { fields: FleetListField[]; columnGap: number };

export const DEFAULT_FLEET_LIST_FIELDS: FleetListField[] = [
  { kind: 'builtin', key: 'altitude_m' },
  { kind: 'builtin', key: 'groundspeed_mps' },
  { kind: 'builtin', key: 'timestamp' },
  { kind: 'builtin', key: 'airspeed_mps' },
  { kind: 'builtin', key: 'realtime_factor' },
];

const builtinMap = new Map<string, (typeof BUILTIN_FLEET_FIELDS)[number]>(
  BUILTIN_FLEET_FIELDS.map(field => [field.key, field]),
);

export function canonicalFleetPropertyPath(input: string): string | null {
  const path = input.trim()
    .replace(/^\/\d{2}(?=\/jsbsim\/)/, '')
    .replace(/^\/jsbsim\[\d+\]\//, '/jsbsim/');
  return path.startsWith('/jsbsim/') && path.length <= 256 && !/[\s\u0000-\u001f]/.test(path)
    ? path : null;
}

export function normalizeFleetListFields(value: unknown): FleetListField[] {
  if (!Array.isArray(value)) return [...DEFAULT_FLEET_LIST_FIELDS];
  const result: FleetListField[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    let field: FleetListField | null = null;
    if (candidate.kind === 'builtin' && typeof candidate.key === 'string'
        && builtinMap.has(candidate.key)) {
      field = { kind: 'builtin', key: candidate.key as FleetBuiltinKey };
    } else if (candidate.kind === 'property' && typeof candidate.path === 'string') {
      const path = canonicalFleetPropertyPath(candidate.path);
      if (path) field = {
        kind: 'property', path,
        label: String(candidate.label || path.split('/').pop() || '属性').trim().slice(0, 24),
        unit: String(candidate.unit || '').trim().slice(0, 12),
        digits: Math.min(6, Math.max(0, Math.trunc(Number(candidate.digits) || 0))),
      };
    }
    if (!field) continue;
    const identity = field.kind === 'builtin' ? field.key : field.path;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(field);
    if (result.length === MAX_FLEET_LIST_FIELDS) break;
  }
  return result.length ? result : [...DEFAULT_FLEET_LIST_FIELDS];
}

export function normalizeFleetColumnGap(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_FLEET_COLUMN_GAP, Math.max(0, Math.round(value)))
    : DEFAULT_FLEET_COLUMN_GAP;
}

export function readFleetListDisplay(): FleetListDisplay {
  try {
    const stored = localStorage.getItem(FLEET_LIST_DISPLAY_KEY);
    if (stored) {
      const value: unknown = JSON.parse(stored);
      if (Array.isArray(value)) return {
        fields: normalizeFleetListFields(value), columnGap: DEFAULT_FLEET_COLUMN_GAP,
      };
      if (value && typeof value === 'object' && 'fields' in value) return {
        fields: normalizeFleetListFields(value.fields),
        columnGap: normalizeFleetColumnGap('columnGap' in value ? value.columnGap : undefined),
      };
    }
    const legacy = localStorage.getItem(LEGACY_FLEET_LIST_DISPLAY_KEY);
    if (legacy) {
      const fields = normalizeFleetListFields(JSON.parse(legacy));
      return { fields: fields.length < MAX_FLEET_LIST_FIELDS
        && !fields.some(field => field.kind === 'builtin' && field.key === 'realtime_factor')
        ? [...fields, { kind: 'builtin', key: 'realtime_factor' }] : fields,
        columnGap: DEFAULT_FLEET_COLUMN_GAP };
    }
  } catch { /* Use defaults when local storage is unavailable or malformed. */ }
  return { fields: [...DEFAULT_FLEET_LIST_FIELDS], columnGap: DEFAULT_FLEET_COLUMN_GAP };
}

export function fleetFieldLabel(field: FleetListField): string {
  return field.kind === 'builtin' ? builtinMap.get(field.key)!.label : field.label;
}

export function fleetFieldIcon(field: FleetListField): string | null {
  return field.kind === 'builtin' ? builtinMap.get(field.key)!.icon : null;
}

export function fleetFieldValue(field: FleetListField, item: SimInstanceSummary | null,
                                properties?: Record<string, number>): string {
  if (!item) return '—';
  const definition = field.kind === 'builtin' ? builtinMap.get(field.key)! : field;
  const value = field.kind === 'builtin' ? item[field.key] : properties?.[field.path];
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const text = value.toFixed(definition.digits);
  return definition.unit === '°' || definition.unit === '×' ? `${text}${definition.unit}`
    : definition.unit ? `${text} ${definition.unit}` : text;
}
