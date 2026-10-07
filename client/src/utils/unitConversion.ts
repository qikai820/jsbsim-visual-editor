export type UnitSystem = 'imperial' | 'metric';

// Unit conversion utilities for JSBSim properties
// JSBSim typically uses imperial units (feet, degrees, fps, etc.)

export interface UnitConversion {
  factor: number;
  offset: number;
  fromUnit: string;
  toUnit: string;
}

// Conversion table based on property path suffix
const CONVERSIONS: Record<string, Record<UnitSystem, UnitConversion>> = {
  // Length: feet <-> meters
  'ft': {
    imperial: { factor: 1, offset: 0, fromUnit: 'ft', toUnit: 'ft' },
    metric: { factor: 0.3048, offset: 0, fromUnit: 'ft', toUnit: 'm' },
  },
  'fps': {
    imperial: { factor: 1, offset: 0, fromUnit: 'fps', toUnit: 'fps' },
    metric: { factor: 0.3048, offset: 0, fromUnit: 'fps', toUnit: 'm/s' },
  },
  'ft_sec2': {
    imperial: { factor: 1, offset: 0, fromUnit: 'ft/s²', toUnit: 'ft/s²' },
    metric: { factor: 0.3048, offset: 0, fromUnit: 'ft/s²', toUnit: 'm/s²' },
  },
  // Pressure: psf <-> Pa
  'psf': {
    imperial: { factor: 1, offset: 0, fromUnit: 'psf', toUnit: 'psf' },
    metric: { factor: 47.88, offset: 0, fromUnit: 'psf', toUnit: 'Pa' },
  },
  // Mass: lbs <-> kg
  'lbs': {
    imperial: { factor: 1, offset: 0, fromUnit: 'lbs', toUnit: 'lbs' },
    metric: { factor: 0.453592, offset: 0, fromUnit: 'lbs', toUnit: 'kg' },
  },
  // Temperature: Fahrenheit <-> Celsius (special case with offset)
  'degF': {
    imperial: { factor: 1, offset: 0, fromUnit: '°F', toUnit: '°F' },
    metric: { factor: 5/9, offset: -32 * 5/9, fromUnit: '°F', toUnit: '°C' },
  },
  // Angles: degrees <-> radians
  'deg': {
    imperial: { factor: 1, offset: 0, fromUnit: '°', toUnit: '°' },
    metric: { factor: Math.PI / 180, offset: 0, fromUnit: '°', toUnit: 'rad' },
  },
  'rad': {
    imperial: { factor: 180 / Math.PI, offset: 0, fromUnit: 'rad', toUnit: '°' },
    metric: { factor: 1, offset: 0, fromUnit: 'rad', toUnit: 'rad' },
  },
  // Angular velocity: deg/sec <-> rad/sec
  'deg_sec': {
    imperial: { factor: 1, offset: 0, fromUnit: '°/s', toUnit: '°/s' },
    metric: { factor: Math.PI / 180, offset: 0, fromUnit: '°/s', toUnit: 'rad/s' },
  },
  'rad_sec': {
    imperial: { factor: 180 / Math.PI, offset: 0, fromUnit: 'rad/s', toUnit: '°/s' },
    metric: { factor: 1, offset: 0, fromUnit: 'rad/s', toUnit: 'rad/s' },
  },
  // Normalized values (no unit)
  'norm': {
    imperial: { factor: 1, offset: 0, fromUnit: '', toUnit: '' },
    metric: { factor: 1, offset: 0, fromUnit: '', toUnit: '' },
  },
  // Time stays the same
  'sec': {
    imperial: { factor: 1, offset: 0, fromUnit: 's', toUnit: 's' },
    metric: { factor: 1, offset: 0, fromUnit: 's', toUnit: 's' },
  },
};

// Extract unit from property path
export function extractUnit(path: string): string {
  const last = path.split('/').pop() || '';
  const match = last.match(/-([a-z0-9_]+)$/);
  return match ? match[1] : '';
}

// Get conversion for a property
export function getConversion(path: string, unitSystem: UnitSystem): UnitConversion {
  const unit = extractUnit(path);
  return CONVERSIONS[unit]?.[unitSystem] || {
    factor: 1,
    offset: 0,
    fromUnit: unit,
    toUnit: unit,
  };
}

// Convert value based on unit system
export function convertValue(value: number, path: string, unitSystem: UnitSystem): number {
  const conv = getConversion(path, unitSystem);
  return value * conv.factor + conv.offset;
}

// Format value with unit
export function formatValueWithUnit(
  value: number | undefined,
  path: string,
  unitSystem: UnitSystem
): { value: string; unit: string } {
  if (value === undefined) return { value: '—', unit: '' };

  const conv = getConversion(path, unitSystem);
  const converted = value * conv.factor + conv.offset;

  let formatted: string;
  if (Math.abs(converted) >= 1000) {
    formatted = converted.toFixed(0);
  } else if (Math.abs(converted) < 0.0001 && converted !== 0) {
    formatted = converted.toExponential(2);
  } else {
    formatted = converted.toFixed(4);
  }

  return { value: formatted, unit: conv.toUnit };
}
