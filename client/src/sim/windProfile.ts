import type { RuntimeEdit } from './runtimeTuningApi';
export type Wave = 0 | 1 | 2 | 3;
export interface WindProfile {
  version: 1; active: 0 | 1;
  speedWave: Wave; speedMeanMps: number; speedAmplitudeMps: number; speedPeriodSec: number; speedPhaseDeg: number; speedDutyPct: number;
  directionWave: Wave; directionMeanDeg: number; directionAmplitudeDeg: number; directionPeriodSec: number; directionPhaseDeg: number; directionDutyPct: number;
  downMps: number;
}
export const windProfileFields = [
  ['active', 'active'], ['speedWave', 'speed-wave'], ['speedMeanMps', 'speed-mean-mps'],
  ['speedAmplitudeMps', 'speed-amplitude-mps'], ['speedPeriodSec', 'speed-period-sec'],
  ['speedPhaseDeg', 'speed-phase-deg'], ['speedDutyPct', 'speed-duty-pct'],
  ['directionWave', 'direction-wave'], ['directionMeanDeg', 'direction-mean-deg'],
  ['directionAmplitudeDeg', 'direction-amplitude-deg'], ['directionPeriodSec', 'direction-period-sec'],
  ['directionPhaseDeg', 'direction-phase-deg'], ['directionDutyPct', 'direction-duty-pct'], ['downMps', 'down-mps'],
] as const;
export const wrapWindDirection = (value: number) => ((value % 360) + 360) % 360;
export function profileFromEnvironment(environment: Record<string, any>): WindProfile {
  if (environment.windProfile?.version === 1) return { ...environment.windProfile };
  const north = Number(environment.windNorthFps || 0) * .3048, east = Number(environment.windEastFps || 0) * .3048;
  return { version: 1, active: 0, speedWave: 0, speedMeanMps: Math.hypot(north, east), speedAmplitudeMps: 0,
    speedPeriodSec: 10, speedPhaseDeg: 0, speedDutyPct: 50, directionWave: 0,
    directionMeanDeg: north || east ? wrapWindDirection(Math.atan2(-east, -north)*180/Math.PI) : 0,
    directionAmplitudeDeg: 0, directionPeriodSec: 20, directionPhaseDeg: 0, directionDutyPct: 50,
    downMps: Number(environment.windDownFps || 0)*.3048 };
}
export function windProfileError(p: WindProfile, isZh = true): string {
  const error = (zh: string, en: string) => isZh ? zh : en;
  if (p?.version !== 1 || windProfileFields.some(([key]) => !Number.isFinite(p[key]))) return error('风场参数须为有效数值。', 'Wind parameters must be finite numbers.');
  if (![0, 1].includes(p.active)) return error('风场模式无效。', 'Invalid wind mode.');
  for (const prefix of ['speed', 'direction'] as const) {
    const wave = p[`${prefix}Wave`], period = p[`${prefix}PeriodSec`], phase = p[`${prefix}PhaseDeg`], duty = p[`${prefix}DutyPct`];
    if (![0, 1, 2, 3].includes(wave) || period < .1 || period > 3600 || phase < 0 || phase > 360 || duty < 1 || duty > 99)
      return error('周期须为 0.1～3600 s，初相位为 0～360°，占空比为 1～99%。', 'Period: 0.1–3600 s; phase: 0–360°; duty: 1–99%.');
  }
  if (p.speedMeanMps < 0 || p.speedMeanMps > 100 || p.speedAmplitudeMps < 0 || p.speedAmplitudeMps > 100 || p.speedWave !== 0 && p.speedAmplitudeMps > p.speedMeanMps)
    return error('风速须为 0～100 m/s，振幅不能大于基准风速。', 'Wind speed: 0–100 m/s; amplitude cannot exceed mean speed.');
  if (p.directionMeanDeg < 0 || p.directionMeanDeg >= 360 || p.directionAmplitudeDeg < 0 || p.directionAmplitudeDeg > 180 || Math.abs(p.downMps) > 100)
    return error('风向须为 0～360°（不含 360°），摆动振幅为 0～180°，垂直风为 ±100 m/s。', 'Direction: [0, 360)°; amplitude: 0–180°; vertical wind: ±100 m/s.');
  return '';
}
export function waveSample(wave: Wave, mean: number, amplitude: number, period: number, phase: number, duty: number, time: number): number {
  if (!wave) return mean;
  const u = ((time/period + phase/360)%1 + 1)%1;
  const f = wave === 1 ? Math.sin(2*Math.PI*u) : wave === 2 ? 2/Math.PI*Math.asin(Math.sin(2*Math.PI*u)) : u < duty/100 ? 1 : -1;
  return mean + amplitude*f;
}
export function windSample(p: WindProfile, time: number) {
  const speed = waveSample(p.speedWave, p.speedMeanMps, p.speedAmplitudeMps, p.speedPeriodSec, p.speedPhaseDeg, p.speedDutyPct, time);
  const continuousDirection = waveSample(p.directionWave, p.directionMeanDeg, p.directionAmplitudeDeg, p.directionPeriodSec, p.directionPhaseDeg, p.directionDutyPct, time);
  const radians = continuousDirection*Math.PI/180;
  return { speed, direction: wrapWindDirection(continuousDirection), continuousDirection, north: -speed*Math.cos(radians), east: -speed*Math.sin(radians), down: p.downMps };
}
export function windProfileEdits(profile: WindProfile): RuntimeEdit[] {
  if (windProfileError(profile)) return [];
  return windProfileFields.map(([field, key]) => ({ key: `_tuning/wind/${key}`, value: profile[field] }));
}
