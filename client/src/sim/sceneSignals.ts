import { canonicalMonitorProperty } from './monitorIdentity';
import { rotorCount, rotorRpmKey } from './sceneRotors';
import { gimbalKey, isMorphQuad, MORPHQUAD_ARMS } from './sceneMorphQuad';
import { SCENE_WIND_KEYS } from './sceneWind';
import { isXcd20 } from './sceneXcd20';
import { PLATFORM_SIGNAL_KEYS } from './sceneMovingPlatform';

const COLLISION_KEYS = ['scene/loaded', 'scene/revision', 'scene/contact-count'];
const GROUND_HEIGHT_KEYS = ['position/h-agl-ft', 'position/terrain-elevation-asl-ft'];

export interface SceneMonitorTarget { instance: string; model: string; extraKeys?: string[]; platformEnabled?: boolean }
const sceneListeners = new Set<(frame: any) => void>();
export function listenSceneMonitor(listener: (frame: any) => void): () => void {
  sceneListeners.add(listener); return () => { sceneListeners.delete(listener); };
}
export function publishSceneMonitor(frame: any): void { for (const listener of sceneListeners) listener(frame); }
// JSBSim's measured geodetic position (metres) and body Euler attitude (radians).
export const SCENE_POSE_KEYS = ['position/lat-geod-deg', 'position/long-gc-deg', 'position/h-sl-meters',
  'attitude/phi-rad', 'attitude/theta-rad', 'attitude/psi-rad'] as const;
export function sceneSignalKeys(model: string): string[] {
  const ground = [...COLLISION_KEYS, ...GROUND_HEIGHT_KEYS];
  const rpm = Array.from({ length: rotorCount(model) }, (_, i) => rotorRpmKey(model, i));
  if (isMorphQuad(model)) return [...SCENE_POSE_KEYS, ...SCENE_WIND_KEYS, ...ground,
    ...MORPHQUAD_ARMS.flatMap((_, i) => [gimbalKey(i, 'outer'), gimbalKey(i, 'inner')]), ...rpm,
    ...Array.from({ length: 8 }, (_, i) => `propulsion/engine[${i}]/propeller-sense`)];
  return /voliro/i.test(model) ? ['fcs/voliro_t/pitch-rad',
    ...SCENE_POSE_KEYS, ...SCENE_WIND_KEYS, ...ground, ...rpm, 'fcs/voliro_t/rpm-model/version', 'fcs/voliro_t/rpm-model/tail-calibrated',
    ...Array.from({ length: 5 }, (_, i) => `fcs/esc-out[${i}]`),
    ...Array.from({ length: 5 }, (_, i) => `fcs/voliro_t/thrust-lbf[${i}]`)] : [...SCENE_POSE_KEYS, ...SCENE_WIND_KEYS, ...ground, ...rpm,
      ...Array.from({ length: rotorCount(model) }, (_, i) => `propulsion/engine[${i}]/propeller-sense`)];
}

/** Keep pose/ground intact, then reserve room for explicitly configured values. */
export function sceneMonitorKeys(model: string, extraKeys: string[] = []): string[] {
  if (!extraKeys.length) return sceneSignalKeys(model);
  const keys = [...SCENE_POSE_KEYS, ...GROUND_HEIGHT_KEYS, ...extraKeys, ...sceneSignalKeys(model)];
  const seen = new Set<string>();
  return keys.filter(key => { const canonical = canonicalMonitorProperty(key); if (seen.has(canonical)) return false; seen.add(canonical); return true; });
}

export function sceneMonitorPlan(target: SceneMonitorTarget | null, testKeys: string[] = []) {
  if (!target) return { keys: testKeys, reserved: [] };
  const { model, extraKeys = [], platformEnabled } = target;
  if (!isXcd20(model) || !platformEnabled) {
    return { keys: [...testKeys, ...sceneMonitorKeys(model, extraKeys)], reserved: [] };
  }

  const rpm = Array.from({ length: rotorCount(model) }, (_, i) => rotorRpmKey(model, i));
  const reserved = [...PLATFORM_SIGNAL_KEYS, ...rpm, ...testKeys];
  // Core telemetry already carries the aircraft pose. With the platform active,
  // spend the remaining fast slots on properties absent from that core frame.
  return { keys: [...reserved, ...GROUND_HEIGHT_KEYS, ...extraKeys, ...SCENE_WIND_KEYS, ...COLLISION_KEYS], reserved };
}

// One VMON subscription per instance. User signals fill the slots after any
// reserved keys, retaining their original spelling for aliases.
export function mergeSceneMonitorKeys(userKeys: string[], sceneKeys: string[], reserved: string[] = []): string[] {
  const users = [...new Set(userKeys)].sort();
  const userAliases = new Map(users.map(key => [canonicalMonitorProperty(key), key]));
  const required = new Set(reserved.map(key => userAliases.get(canonicalMonitorProperty(key)) ?? key));
  const available = reserved.length ? users.filter(key => !required.has(key)).slice(0, Math.max(0, 32 - required.size)) : users;
  const keys = [...required, ...available];
  const canonical = new Map(keys.map(key => [canonicalMonitorProperty(key), key]));
  const priority: string[] = [];
  for (const key of sceneKeys) {
    const normalized = canonicalMonitorProperty(key);
    let actual = canonical.get(normalized);
    if (!actual && keys.length < 32) { actual = key; keys.push(key); canonical.set(normalized, key); }
    if (actual && !priority.includes(actual)) priority.push(actual);
  }
  return [...priority, ...keys.filter(key => !priority.includes(key))];
}
