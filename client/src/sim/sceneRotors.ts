import type { ScenePose } from './flightSceneState';
import { isMorphQuad, MORPHQUAD_ARMS } from './sceneMorphQuad';

export const isVoliro = (model: string) => /voliro/i.test(model);
export const isQuadrotor = (model: string) => /f450|quad|multi|h7|morph/i.test(model);
export const rotorCount = (model: string) => isVoliro(model) ? 5 : isMorphQuad(model) ? 8 : isQuadrotor(model) ? 4 : 1;
export const rotorRpmKey = (model: string, index: number) => isVoliro(model)
  ? `fcs/voliro_t/rpm[${index}]` : `propulsion/engine[${index}]/propeller-rpm`;
export const rotorLabel = (model: string, index: number) => isVoliro(model)
  ? [`M1 · 右上`, `M2 · 右下`, `M3 · 左上`, `M4 · 左下`, `M5 · 尾桨`][index]
  : isMorphQuad(model) ? `M${index + 1} · ${MORPHQUAD_ARMS[Math.floor(index / 2)].label}${index % 2 ? '下' : '上'}` : `M${index + 1}`;

// Existing model's 23 V single-prop bench CSV: M6208 KV310 / 22 x 7.8.
// jsbsim_realtime/data/aviation/aircraft/voliro_t/data/m6208_310kv_6s_22x7.8_bench.csv
// This estimates isolated RPM from actual ESC output; it is not RPM feedback
// and does not include installed coaxial loading or battery-voltage variation.
const frontBench: readonly (readonly [number, number])[] = [
  [0, 0], [33, 2465], [35, 2572], [37, 2682], [39, 2793], [42, 2957], [45, 3116],
  [48, 3268], [51, 3411], [54, 3546], [57, 3674], [60, 3795], [63, 3912], [66, 4026],
  [69, 4139], [72, 4252], [75, 4366], [78, 4484], [81, 4605], [84, 4732], [87, 4863],
  [90, 4997], [100, 5399],
];
export function estimatedFrontRpm(esc: number): number {
  const percent = Math.max(0, Math.min(1, esc)) * 100;
  for (let i = 1; i < frontBench.length; i++) {
    const [a, low] = frontBench[i - 1], [b, high] = frontBench[i];
    if (percent <= b) return low + (high - low) * (percent - a) / (b - a);
  }
  return frontBench[frontBench.length - 1][1];
}
export type RotorReading = { rpm: number | null; sampleAt: number | null;
  source: 'model' | 'bench' | 'visual' | 'none'; angularVelocity: number; visualAngularVelocity: number; blur: number };
/** Keep high-RPM blades visible rather than aliasing to a stationary rotor.
 * RPM and physical angular velocity remain unchanged; only display phase is compressed. */
export function visibleRotorVelocity(omega: number): number {
  const speed = Math.abs(omega);
  return Math.sign(omega) * (speed <= 10 ? speed : 10 + 8 * (1 - Math.exp(-(speed - 10) / 80)));
}
export function rotorReading(pose: ScenePose, index: number, now = performance.now()): RotorReading {
  const rpm = pose.rpm?.[index], motor = pose.motors[index];
  const voliro = isVoliro(pose.model);
  let value: number | null = null, source: RotorReading['source'] = 'none', sampleAt: number | null = null;
  if (rpm != null) { value = rpm; source = 'model'; sampleAt = pose.rpmSampleAt?.[index] ?? null; }
  else if (voliro && motor != null) {
    sampleAt = pose.motorSampleAt[index];
    if (index < 4) { value = estimatedFrontRpm(motor); source = 'bench'; }
    else source = 'visual'; // No measured tail RPM curve: animate without inventing an RPM.
  }
  // Front motor order and reaction-torque signs match voliro_t.xml.
  const sense = voliro ? [1, -1, -1, 1, 1][index] : pose.rpmSense?.[index]
    ?? (isMorphQuad(pose.model) ? MORPHQUAD_ARMS[Math.floor(index / 2)].senses[index % 2] : 1);
  const active = pose.state === 'running' && sampleAt != null && now - sampleAt < 2000;
  const omega = value == null ? source === 'visual' ? (motor ?? 0) * 50 : 0 : value * (Math.PI / 30);
  return { rpm: value, sampleAt, source, angularVelocity: active ? omega * sense : 0,
    visualAngularVelocity: active ? visibleRotorVelocity(omega * sense) : 0,
    blur: active ? Math.min(.28, Math.abs(omega) / 800) : 0 };
}
