import { canonicalMonitorProperty } from './monitorIdentity';

export interface SceneMonitorTarget { instance: string; model: string }
const sceneListeners = new Set<(frame: any) => void>();
export function listenSceneMonitor(listener: (frame: any) => void): () => void {
  sceneListeners.add(listener); return () => { sceneListeners.delete(listener); };
}
export function publishSceneMonitor(frame: any): void { for (const listener of sceneListeners) listener(frame); }
// JSBSim's measured geodetic position (metres) and body Euler attitude (radians).
export const SCENE_POSE_KEYS = ['position/lat-geod-deg', 'position/long-gc-deg', 'position/h-sl-meters',
  'attitude/phi-rad', 'attitude/theta-rad', 'attitude/psi-rad'] as const;
export function sceneSignalKeys(model: string): string[] {
  const ground = ['position/h-agl-ft', 'position/terrain-elevation-asl-ft'];
  return /voliro/i.test(model) ? ['fcs/voliro_t/pitch-rad',
    ...SCENE_POSE_KEYS,
    ...Array.from({ length: 5 }, (_, i) => `fcs/esc-out[${i}]`),
    ...Array.from({ length: 5 }, (_, i) => `fcs/voliro_t/thrust-lbf[${i}]`), ...ground] : [...SCENE_POSE_KEYS, ...ground];
}

// One VMON subscription per instance: preserve the user's signals and use free
// slots for the scene. Existing aliases keep their original subscription key.
export function mergeSceneMonitorKeys(userKeys: string[], sceneKeys: string[]): string[] {
  const keys = [...new Set(userKeys)].sort();
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
