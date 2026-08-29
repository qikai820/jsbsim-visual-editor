import type { Telemetry } from '../sim/useSimSocket';

interface FlightHudProps { telemetry: Telemetry | null; connected: boolean; }

const read = (telemetry: Telemetry | null, paths: string[]) => {
  for (const path of paths) {
    const value = telemetry?.[path];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};
const readAttitude = (telemetry: Telemetry | null, index: number) => {
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
  const altitude = read(telemetry, ['/position/h-sl-ft', '/position/h-sl-m']) ?? (readCompact(telemetry, 'pos', 2) != null ? readCompact(telemetry, 'pos', 2)! * 3.28084 : null);
  const speed = read(telemetry, ['/velocities/vtrue-kts', '/velocities/vtrue-mps', '/velocities/vc-kts']) ?? (typeof (telemetry as any)?.vc === 'number' ? (telemetry as any).vc * 1.94384 : null);
  const heading = readAttitude(telemetry, 2) ?? read(telemetry, ['/attitude/heading-deg']);
  const pitch = readAttitude(telemetry, 1);
  const roll = readAttitude(telemetry, 0);
  const verticalSpeed = read(telemetry, ['/velocities/v-down-fps', '/velocities/v-down-mps']) ?? (readCompact(telemetry, 'vel', 2) != null ? -readCompact(telemetry, 'vel', 2)! * 196.85 : null);

  return <div className="flight-hud" aria-label="飞行状态 HUD">
    <div className="flight-hud-grid" />
    <div className="flight-hud-topline"><span>F-35 // FLIGHT DISPLAY</span><span className={connected ? 'hud-online' : 'hud-offline'}>{connected ? '● LINKED' : '○ NO LINK'}</span></div>
    <div className="flight-hud-main">
      <div className="hud-attitude"><div className="hud-crosshair">＋</div><div className="hud-ladder">−20°　　−10°　　 0°　　 +10°　　+20°</div><span className="hud-bank">ROLL {roll == null ? '--' : roll.toFixed(1)}°</span></div>
      <div className="hud-metrics left"><Metric label="ALT" value={altitude} unit="FT" /><Metric label="V/S" value={verticalSpeed} unit="FPM" /></div>
      <div className="hud-metrics right"><Metric label="IAS" value={speed} unit="KTS" /><Metric label="HDG" value={heading} unit="°" digits={0} /></div>
    </div>
    <div className="flight-hud-footer"><span>PITCH {pitch == null ? '--' : pitch.toFixed(1)}°</span><span>SIM T+ {telemetry?.t == null ? '--' : telemetry.t.toFixed(1)}s</span><span>A/A　NAV</span></div>
  </div>;
}
