import type { SignalBinding } from '../../sim/monitorIdentity';
import { sampleText, useSignalMonitorStore } from '../../store/signalMonitorStore';

interface Unit { id: string; label: string; scale: number; offset?: number }
interface UnitGroup { label: string; units: Unit[] }
// Each group converts through its own SI base. Mass and force are separate.
export const SCOPE_UNIT_GROUPS: UnitGroup[] = [
  { label: '长度', units: [
    { id: 'm', label: 'm', scale: 1 }, { id: 'ft', label: 'ft', scale: .3048 },
    { id: 'km', label: 'km', scale: 1000 }, { id: 'mi', label: 'mi', scale: 1609.344 },
    { id: 'nmi', label: 'nmi', scale: 1852 }, { id: 'in', label: 'in', scale: .0254 },
  ] },
  { label: '速度', units: [
    { id: 'm/s', label: 'm/s', scale: 1 }, { id: 'ft/s', label: 'ft/s', scale: .3048 },
    { id: 'km/h', label: 'km/h', scale: 1 / 3.6 }, { id: 'kn', label: 'kn', scale: 1852 / 3600 },
    { id: 'mph', label: 'mph', scale: 1609.344 / 3600 },
  ] },
  { label: '加速度', units: [
    { id: 'm/s²', label: 'm/s²', scale: 1 }, { id: 'ft/s²', label: 'ft/s²', scale: .3048 },
    { id: 'g', label: 'g', scale: 9.80665 },
  ] },
  { label: '角度', units: [
    { id: 'rad', label: 'rad', scale: 1 }, { id: 'deg', label: '°', scale: Math.PI / 180 },
  ] },
  { label: '角速度', units: [
    { id: 'rad/s', label: 'rad/s', scale: 1 }, { id: 'deg/s', label: '°/s', scale: Math.PI / 180 },
  ] },
  { label: '力', units: [
    { id: 'N', label: 'N', scale: 1 }, { id: 'lbf', label: 'lbf', scale: 4.4482216152605 },
    { id: 'kgf', label: 'kgf', scale: 9.80665 },
  ] },
  { label: '质量', units: [
    { id: 'kg', label: 'kg', scale: 1 }, { id: 'lb', label: 'lb', scale: .45359237 },
    { id: 'slug', label: 'slug', scale: 14.593902937206 },
  ] },
  { label: '压力', units: [
    { id: 'Pa', label: 'Pa', scale: 1 }, { id: 'kPa', label: 'kPa', scale: 1000 },
    { id: 'bar', label: 'bar', scale: 100000 }, { id: 'psi', label: 'psi', scale: 6894.757293168 },
    { id: 'psf', label: 'psf', scale: 47.8802589803 },
  ] },
  { label: '温度', units: [
    { id: 'K', label: 'K', scale: 1 }, { id: 'C', label: '°C', scale: 1, offset: 273.15 },
    { id: 'F', label: '°F', scale: 5 / 9, offset: 255.3722222222222 },
    { id: 'R', label: '°R', scale: 5 / 9 },
  ] },
];

const groupOf = (id: string | undefined) => SCOPE_UNIT_GROUPS.find(group => group.units.some(unit => unit.id === id));
const aliases: Record<string, string> = {
  ft: 'ft', m: 'm', km: 'km', mi: 'mi', in: 'in', nmi: 'nmi',
  fps: 'ft/s', 'ft/sec': 'ft/s', 'ft/s': 'ft/s', ft_sec: 'ft/s',
  mps: 'm/s', 'm/sec': 'm/s', 'm/s': 'm/s', m_sec: 'm/s',
  kts: 'kn', kt: 'kn', kn: 'kn', mph: 'mph', 'km/h': 'km/h',
  ft_sec2: 'ft/s²', 'ft/s²': 'ft/s²', m_sec2: 'm/s²', 'm/s²': 'm/s²',
  rad: 'rad', deg: 'deg', '°': 'deg', rad_sec: 'rad/s', 'rad/s': 'rad/s',
  deg_sec: 'deg/s', 'deg/s': 'deg/s', lbf: 'lbf', n: 'N', kgf: 'kgf',
  kg: 'kg', lb: 'lb', slug: 'slug', psf: 'psf', psi: 'psi', pa: 'Pa', kpa: 'kPa',
  bar: 'bar', k: 'K', c: 'C', f: 'F', r: 'R',
};

export function inferredScopeUnit(binding: SignalBinding): string | undefined {
  // A generic “lbs” path can mean weight or mass, so require explicit choice.
  const path = binding.key.replace(/\[\d+\]$/, '').toLowerCase();
  if (/(?:^|\/)(?:weight|thrust)(?:-[\w]+)*-lbs$/.test(path)) return 'lbf';
  if (/(?:^|\/)(?:t|temperature)(?:-[\w]+)*-r$/.test(path)) return 'R';
  const declared = aliases[(binding.unit || '').trim().toLowerCase()];
  if (declared) return declared;
  const suffix = /-(ft_sec2|m_sec2|rad_sec|deg_sec|ft_sec|m_sec|lbf|kts|fps|mps|psf|psi|kpa|rad|deg|ft|kgf|kg|kn|mph|nmi|km|pa|bar|in|m)$/.exec(path)?.[1];
  return suffix ? aliases[suffix] : undefined;
}

export function scopeUnits(binding: SignalBinding) {
  const inferred = inferredScopeUnit(binding);
  const source = binding.sourceUnit ? (groupOf(binding.sourceUnit) ? binding.sourceUnit : undefined) : inferred;
  const group = groupOf(source);
  const target = group?.units.some(unit => unit.id === binding.displayUnit) ? binding.displayUnit : source;
  return { inferred, source, target, group };
}

export function convertScopeValue(value: number, binding: SignalBinding): number {
  const { source, target, group } = scopeUnits(binding);
  const from = group?.units.find(unit => unit.id === source), to = group?.units.find(unit => unit.id === target);
  if (!from || !to || from.id === to.id) return value;
  return (value * from.scale + (from.offset || 0) - (to.offset || 0)) / to.scale;
}

export function scopeUnitLabel(binding: SignalBinding): string {
  const { target, group } = scopeUnits(binding);
  return group?.units.find(unit => unit.id === target)?.label || binding.unit || '';
}

export function formatScopeValue(value: number, binding: SignalBinding): string {
  const converted = convertScopeValue(value, binding), unit = scopeUnitLabel(binding);
  return `${Number(converted.toPrecision(7))}${unit ? ` ${unit}` : ''}`;
}

export function scopeSampleText(binding: SignalBinding, instance: string, state = useSignalMonitorStore.getState()) {
  const raw = sampleText(binding, instance, state);
  const sample = state.samples[`${instance}:${binding.key}`];
  if (raw.text === '—' || !sample || sample.value === null) return raw;
  return { ...raw, text: formatScopeValue(sample.value * (binding.sign ?? 1), binding) };
}
