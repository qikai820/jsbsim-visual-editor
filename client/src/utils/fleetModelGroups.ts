import type { HilEndpoints } from './hilEndpoints';

export const FLEET_INSTANCE_IDS = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0'));

const STORAGE_KEY = 'jsbsim-fleet-model-groups-v1';

export interface FleetModelGroup {
  id: string;
  name: string;
  slots: Record<string, string>;
  initialOverrides: FleetInitialOverrides;
  networkOverrides: FleetNetworkOverrides;
}

export type FleetNetworkOverrides = Record<string, HilEndpoints>;

export function normalizeFleetNetworkOverrides(value: unknown): FleetNetworkOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(FLEET_INSTANCE_IDS.flatMap(id => {
    const endpoints = source[id] as Record<string, unknown> | undefined;
    if (!endpoints || typeof endpoints !== 'object') return [];
    const result = {} as HilEndpoints;
    for (const key of ['input', 'sensor', 'gps'] as const) {
      const endpoint = endpoints[key] as { ip?: unknown; port?: unknown } | null | undefined;
      if (endpoint == null) { result[key] = null; continue; }
      const ip = typeof endpoint.ip === 'string' ? endpoint.ip.trim() : '';
      const port = typeof endpoint.port === 'string' ? endpoint.port.trim() : '';
      const validIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
        ip.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part);
      if ((ip || key === 'input') && !validIp || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
        return [];
      result[key] = { ip, port };
    }
    return Object.values(result).some(Boolean) ? [[id, result]] : [];
  })) as FleetNetworkOverrides;
}

export type FleetInitialPose = {
  latitudeDeg: number; longitudeDeg: number; altitudeM: number;
  rollDeg: number; pitchDeg: number; yawDeg: number;
};
export type FleetInitialOverrides = Record<string, FleetInitialPose>;

/** Legacy model JSON latitude is loaded into JSBSim ic/lat-gc-deg. Convert it
 * to the GPS/geodetic latitude expected by fleet overrides and the map. */
export function modelGeocentricToGpsLatitude(latitudeDeg: number, altitudeM: number): number {
  if (!Number.isFinite(latitudeDeg) || !Number.isFinite(altitudeM) || Math.abs(latitudeDeg) > 90)
    return latitudeDeg;
  const equatorialRadiusM = 6_378_137;
  const flattening = 1 / 298.257223563;
  const eccentricitySquared = flattening * (2 - flattening);
  const geocentricTangent = Math.tan(latitudeDeg * Math.PI / 180);
  let latitude = Math.atan(geocentricTangent / (1 - eccentricitySquared));
  for (let i = 0; i < 6; i++) {
    const normalRadius = equatorialRadiusM /
      Math.sqrt(1 - eccentricitySquared * Math.sin(latitude) ** 2);
    latitude = Math.atan(geocentricTangent * (normalRadius + altitudeM) /
      (normalRadius * (1 - eccentricitySquared) + altitudeM));
  }
  return latitude * 180 / Math.PI;
}

/** Place 01 at the northwest corner, 02–04 eastward and 05–08 one row south. */
export function buildFleetInitialGrid(origin: FleetInitialPose, spacingM = 0.5,
                                      previous: FleetInitialOverrides = {}): FleetInitialOverrides {
  if (!Number.isFinite(spacingM) || spacingM <= 0 ||
      !normalizeFleetInitialOverrides({ '01': origin })['01'] ||
      Math.abs(origin.latitudeDeg) >= 89.999) {
    throw new Error('编组起点或间距无效。');
  }
  const latitudeRad = origin.latitudeDeg * Math.PI / 180;
  const sinLatitude = Math.sin(latitudeRad);
  const a = 6_378_137;
  const eccentricitySquared = 0.0066943799901413165;
  const factor = 1 - eccentricitySquared * sinLatitude * sinLatitude;
  const meridianRadius = a * (1 - eccentricitySquared) / factor ** 1.5;
  const primeVerticalRadius = a / Math.sqrt(factor);
  return Object.fromEntries(FLEET_INSTANCE_IDS.map((id, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    const previousPose = previous[id] || origin;
    return [id, {
      latitudeDeg: origin.latitudeDeg - row * spacingM / meridianRadius * 180 / Math.PI,
      longitudeDeg: origin.longitudeDeg + column * spacingM /
        (primeVerticalRadius * Math.cos(latitudeRad)) * 180 / Math.PI,
      altitudeM: origin.altitudeM,
      rollDeg: previousPose.rollDeg,
      pitchDeg: previousPose.pitchDeg,
      yawDeg: previousPose.yawDeg,
    }];
  })) as FleetInitialOverrides;
}

export function normalizeFleetInitialOverrides(value: unknown): FleetInitialOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const fields: (keyof FleetInitialPose)[] = ['latitudeDeg', 'longitudeDeg', 'altitudeM', 'rollDeg', 'pitchDeg', 'yawDeg'];
  return Object.fromEntries(FLEET_INSTANCE_IDS.flatMap(id => {
    const pose = source[id] as Record<string, unknown> | undefined;
    if (!pose || !fields.every(key => typeof pose[key] === 'number' && Number.isFinite(pose[key]))) return [];
    if (Math.abs(pose.latitudeDeg as number) > 90 || Math.abs(pose.longitudeDeg as number) > 180) return [];
    if ((pose.altitudeM as number) < -1000 || (pose.altitudeM as number) > 100000 ||
        fields.slice(3).some(key => Math.abs(pose[key] as number) > 360)) return [];
    return [[id, Object.fromEntries(fields.map(key => [key, pose[key]]))]];
  })) as FleetInitialOverrides;
}

export function normalizeFleetSlots(value: unknown): Record<string, string> {
  const slots = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(FLEET_INSTANCE_IDS.map(id => [id,
    typeof slots[id] === 'string' ? (slots[id] as string).trim() : '',
  ]));
}

export function readFleetModelGroups(): FleetModelGroup[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter(group => group && typeof group.id === 'string' &&
      typeof group.name === 'string' && group.name.trim() && group.slots && typeof group.slots === 'object')
      .map(group => ({ id: group.id, name: group.name.trim(), slots: normalizeFleetSlots(group.slots),
        initialOverrides: normalizeFleetInitialOverrides(group.initialOverrides),
        networkOverrides: normalizeFleetNetworkOverrides(group.networkOverrides) }));
  } catch {
    return [];
  }
}

export function saveFleetModelGroups(groups: FleetModelGroup[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}
