import type { ScenePose } from './flightSceneState';

// FGWinds total NED wind = steady wind + gusts + cosine gust + turbulence.
// These are air-mass velocities, not the aircraft's wind-relative airspeed.
export const SCENE_WIND_KEYS = ['atmosphere/total-wind-north-fps',
  'atmosphere/total-wind-east-fps', 'atmosphere/total-wind-down-fps'] as const;
export type SceneWind = { north: number; east: number; down: number }; // m/s

export function windReading(pose?: ScenePose, now = performance.now()) {
  const wind = pose?.wind ?? null;
  const age = pose?.windSampleAt == null ? null : Math.max(0, now - pose.windSampleAt);
  const horizontal = wind ? Math.hypot(wind.north, wind.east) : null;
  const speed = wind ? Math.hypot(wind.north, wind.east, wind.down) : null;
  // Three.js +X east, +Y up, +Z south; cloth extends along its local +X.
  const yaw = wind && horizontal! > .05 ? Math.atan2(wind.north, wind.east) : null;
  const fromDegrees = wind && horizontal! > .05
    ? (Math.atan2(-wind.east, -wind.north) * 180 / Math.PI + 360) % 360 : null;
  const fresh = wind !== null && age !== null && age < 2000;
  const moving = fresh && pose?.state === 'running';
  return { wind, age, horizontal, speed, yaw, fromDegrees, fresh, moving,
    // Visual response only; this is not a calibrated wind-speed instrument.
    inflation: Math.min(1, (speed ?? 0) / 7),
    elevation: wind ? Math.atan2(-wind.down, horizontal!) : 0 };
}

/** Integrate a sagging centreline. The mouth stays open on its bearing hoop. */
export function windsockCenter(t: number, inflation: number, elevation = 0): [number, number] {
  let x = 0, y = 0;
  const steps = 16, ds = 1.8 * t / steps;
  for (let i = 0; i < steps; i++) {
    const u = t * (i + .5) / steps;
    const angle = elevation * inflation - (1 - inflation) * Math.PI / 2 * (.4 + .6 * u);
    x += ds * Math.cos(angle); y += ds * Math.sin(angle);
  }
  return [x, y];
}
