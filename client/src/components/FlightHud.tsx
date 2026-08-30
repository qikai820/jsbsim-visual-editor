import type { Telemetry } from '../sim/useSimSocket';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import ParametricAircraft from './ParametricAircraft';

interface FlightHudProps { telemetry: Telemetry | null; connected: boolean; }

function InteractiveAircraft({ roll, pitch, yaw }: { roll: number; pitch: number; yaw: number }) {
  return <Canvas camera={{ position: [2, 1.45, 2.8], fov: 42 }}>
    <ambientLight intensity={0.65} /><directionalLight position={[3, 5, 3]} intensity={1.2} />
    <OrbitControls enableDamping dampingFactor={0.12} minDistance={0.7} maxDistance={8} />
    <group scale={1.6} rotation={[(pitch * Math.PI) / 180, (yaw * Math.PI) / 180, -(roll * Math.PI) / 180]}>
      <ParametricAircraft />
    </group>
    <gridHelper args={[5, 12, '#cbd5e1', '#e2e8f0']} rotation={[0, 0, 0]} />
  </Canvas>;
}

const read = (telemetry: Telemetry | null, paths: string[]) => {
  for (const path of paths) {
    const value = telemetry?.[path];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // NuttX exposes the same JSBSim properties below a model root such as
    // `/jsbsim[0]`; match the canonical property suffix as well.
    if (telemetry) {
      const match = Object.entries(telemetry).find(([key, candidate]) =>
        key.endsWith(path) && typeof candidate === 'number' && Number.isFinite(candidate));
      if (match) return match[1] as number;
    }
  }
  return null;
};
const readField = (telemetry: Telemetry | null, names: string[]) => {
  for (const name of names) {
    const value = telemetry?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};
const readAttitude = (telemetry: Telemetry | null, index: number) => {
  const direct = readField(telemetry, index === 0 ? ['roll_deg', 'roll'] : index === 1 ? ['pitch_deg', 'pitch'] : ['yaw_deg', 'heading_deg', 'yaw']);
  if (direct != null) return direct;
  const property = read(telemetry, index === 0 ? ['/attitude/phi-deg'] : index === 1 ? ['/attitude/theta-deg'] : ['/attitude/psi-deg']);
  if (property != null) return property;
  const compact = (telemetry as any)?.att;
  return Array.isArray(compact) && typeof compact[index] === 'number' ? compact[index] * 180 / Math.PI : null;
};
const readCompact = (telemetry: Telemetry | null, key: string, index: number) => {
  const values = (telemetry as any)?.[key];
  return Array.isArray(values) && typeof values[index] === 'number' ? values[index] : null;
};

function Metric({ label, value, unit, digits = 0 }: { label: string; value: number | null; unit: string; digits?: number }) {
  return <div className="flight-hud-metric"><span>{label}</span><strong>{value == null ? '--' : value.toFixed(digits)}</strong><em>{unit}</em></div>;
}

export default function FlightHud({ telemetry, connected }: FlightHudProps) {
  const altitude = read(telemetry, ['/position/h-sl-ft']) ?? (readField(telemetry, ['altitude_m']) != null ? readField(telemetry, ['altitude_m'])! * 3.28084 : null) ?? (readCompact(telemetry, 'pos', 2) != null ? readCompact(telemetry, 'pos', 2)! * 3.28084 : null);
  const speed = read(telemetry, ['/velocities/vtrue-kts', '/velocities/vc-kts']) ?? (readField(telemetry, ['airspeed_mps']) != null ? readField(telemetry, ['airspeed_mps'])! * 1.94384 : null) ?? (typeof (telemetry as any)?.vc === 'number' ? (telemetry as any).vc * 1.94384 : null);
  const groundSpeed = read(telemetry, ['/velocities/vg-kts', '/velocities/groundspeed-kts']) ?? (readField(telemetry, ['groundspeed_mps']) != null ? readField(telemetry, ['groundspeed_mps'])! * 1.94384 : null) ?? speed;
  const heading = readAttitude(telemetry, 2) ?? read(telemetry, ['/attitude/heading-deg']);
  const pitch = readAttitude(telemetry, 1);
  const roll = readAttitude(telemetry, 0);
  const verticalSpeed = readField(telemetry, ['vertical_speed_fpm']) ?? (readField(telemetry, ['vertical_speed_mps']) != null ? readField(telemetry, ['vertical_speed_mps'])! * 196.85 : null) ?? read(telemetry, ['/velocities/v-down-fps']) ?? (read(telemetry, ['/velocities/v-down-mps']) != null ? -read(telemetry, ['/velocities/v-down-mps'])! * 196.85 : null) ?? (readCompact(telemetry, 'vel', 2) != null ? -readCompact(telemetry, 'vel', 2)! * 196.85 : null);

  return <div className="flight-hud" aria-label="飞行状态 HUD">
    <div className="hud-new-status"><span>3D ATTITUDE</span><span className={connected ? 'hud-online' : 'hud-offline'}>{connected ? '● LINKED' : '○ NO LINK'}</span></div>
    <div className="flight-hud-main">
      <div className="hud-attitude hud-attitude-3d"><InteractiveAircraft roll={roll || 0} pitch={pitch || 0} yaw={heading || 0} /><div className="hud-3d-attitude-label"><span>ROLL <b>{roll == null ? '--' : `${roll.toFixed(1)}°`}</b></span><span>PITCH <b>{pitch == null ? '--' : `${pitch.toFixed(1)}°`}</b></span><span>YAW <b>{heading == null ? '--' : `${heading.toFixed(1)}°`}</b></span><span>SIM TIME <b>{telemetry?.t == null ? '--' : `${telemetry.t.toFixed(1)}s`}</b></span></div></div>
      <div className="hud-metrics left"><Metric label="ALT" value={altitude} unit="FT" /><Metric label="IAS" value={speed} unit="KTS" /></div>
      <div className="hud-metrics right"><Metric label="GS" value={groundSpeed} unit="KTS" /><Metric label="V/S" value={verticalSpeed} unit="FPM" /></div>
    </div>
    <div className="flight-hud-attitude-cards" aria-hidden="true" />
    <div className="hud-new-footer"><span>HDG {heading == null ? '--' : heading.toFixed(1)}°</span></div>
  </div>;
}
