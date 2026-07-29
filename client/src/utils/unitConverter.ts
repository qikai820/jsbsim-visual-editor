// Unit conversion system for JSBSim parameters
// Each unit belongs to a "dimension" — only units in the same dimension can convert.

interface UnitInfo {
  label: string;       // display name
  toBase: (v: number) => number;   // convert to base unit
  fromBase: (v: number) => number; // convert from base unit
}

// Base units: FT (length), FT2 (area), FT3 (volume), LBS (weight), DEG (angle),
//             SLUG*FT2 (inertia), LBS/FT (spring), LBS/FT/SEC (damping)
const UNIT_GROUPS: Record<string, Record<string, UnitInfo>> = {
  length: {
    'IN':  { label: '英寸 (in)',    toBase: v => v / 12,          fromBase: v => v * 12 },
    'FT':  { label: '英尺 (ft)',    toBase: v => v,               fromBase: v => v },
    'M':   { label: '米 (m)',       toBase: v => v * 3.28084,     fromBase: v => v / 3.28084 },
    'CM':  { label: '厘米 (cm)',    toBase: v => v / 30.48,       fromBase: v => v * 30.48 },
    'MM':  { label: '毫米 (mm)',    toBase: v => v / 304.8,       fromBase: v => v * 304.8 },
  },
  area: {
    'FT2': { label: '平方英尺 (ft²)', toBase: v => v,             fromBase: v => v },
    'M2':  { label: '平方米 (m²)',   toBase: v => v * 10.7639,   fromBase: v => v / 10.7639 },
    'CM2': { label: '平方厘米 (cm²)', toBase: v => v / 929.03,    fromBase: v => v * 929.03 },
    'IN2': { label: '平方英寸 (in²)', toBase: v => v / 144,       fromBase: v => v * 144 },
  },
  volume: {
    'FT3': { label: '立方英尺 (ft³)', toBase: v => v,             fromBase: v => v },
    'M3':  { label: '立方米 (m³)',   toBase: v => v * 35.3147,   fromBase: v => v / 35.3147 },
    'L':   { label: '升 (L)',        toBase: v => v * 0.035315,  fromBase: v => v / 0.035315 },
    'GAL': { label: '加仑 (gal)',    toBase: v => v * 0.133681,  fromBase: v => v / 0.133681 },
  },
  weight: {
    'LBS': { label: '磅 (lbs)',      toBase: v => v,             fromBase: v => v },
    'KG':  { label: '千克 (kg)',     toBase: v => v * 2.20462,   fromBase: v => v / 2.20462 },
    'N':   { label: '牛顿 (N)',      toBase: v => v * 0.224809,  fromBase: v => v / 0.224809 },
    'SLUG':{ label: '斯勒格 (slug)', toBase: v => v * 32.174,    fromBase: v => v / 32.174 },
  },
  angle: {
    'DEG': { label: '度 (°)',        toBase: v => v,             fromBase: v => v },
    'RAD': { label: '弧度 (rad)',    toBase: v => v * 57.2958,   fromBase: v => v / 57.2958 },
  },
  inertia: {
    'SLUG*FT2': { label: 'slug·ft²', toBase: v => v,            fromBase: v => v },
    'KG*M2':    { label: 'kg·m²',    toBase: v => v * 0.73756,  fromBase: v => v / 0.73756 },
  },
  spring: {
    'LBS/FT':      { label: 'lbs/ft',       toBase: v => v,     fromBase: v => v },
    'N/M':         { label: 'N/m',          toBase: v => v * 0.068522, fromBase: v => v / 0.068522 },
    'LBS/IN':      { label: 'lbs/in',       toBase: v => v * 12, fromBase: v => v / 12 },
  },
  damping: {
    'LBS/FT/SEC':  { label: 'lbs/(ft·s)',   toBase: v => v,     fromBase: v => v },
    'N/M/SEC':     { label: 'N/(m·s)',      toBase: v => v * 0.068522, fromBase: v => v / 0.068522 },
  },
  velocity: {
    'FT/SEC': { label: 'ft/s',     toBase: v => v,               fromBase: v => v },
    'M/SEC':  { label: 'm/s',      toBase: v => v * 3.28084,     fromBase: v => v / 3.28084 },
    'KTS':    { label: '节 (kts)',  toBase: v => v * 1.68781,     fromBase: v => v / 1.68781 },
    'KM/H':   { label: 'km/h',     toBase: v => v * 0.911344,    fromBase: v => v / 0.911344 },
  },
  pressure: {
    'PSF': { label: 'lb/ft² (psf)', toBase: v => v,              fromBase: v => v },
    'PA':  { label: 'Pa',          toBase: v => v * 0.020885,    fromBase: v => v / 0.020885 },
    'PSI': { label: 'psi',         toBase: v => v * 144,          fromBase: v => v / 144 },
    'ATM': { label: 'atm',         toBase: v => v * 2116.22,      fromBase: v => v / 2116.22 },
  },
  temperature: {
    'R': { label: '兰氏度 (°R)',   toBase: v => v,               fromBase: v => v },
    'K': { label: '开尔文 (K)',    toBase: v => v * 1.8,         fromBase: v => v / 1.8 },
  },
};

// Map from JSBSim unit string to the group it belongs to
function findUnitGroup(unit: string): string | null {
  for (const [group, units] of Object.entries(UNIT_GROUPS)) {
    if (units[unit]) return group;
  }
  return null;
}

export function getUnitOptions(currentUnit: string): { value: string; label: string }[] {
  const group = findUnitGroup(currentUnit);
  if (!group) return [{ value: currentUnit, label: currentUnit }];
  return Object.entries(UNIT_GROUPS[group]).map(([value, info]) => ({
    value,
    label: info.label,
  }));
}

export function convertUnit(value: number, fromUnit: string, toUnit: string): number {
  if (fromUnit === toUnit) return value;
  const group = findUnitGroup(fromUnit);
  if (!group) return value;
  const targetGroup = findUnitGroup(toUnit);
  if (targetGroup !== group) return value; // incompatible units
  const units = UNIT_GROUPS[group];
  const baseValue = units[fromUnit].toBase(value);
  return units[toUnit].fromBase(baseValue);
}

export function formatValue(value: number): string {
  if (Number.isNaN(value)) return '0';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 10000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}
