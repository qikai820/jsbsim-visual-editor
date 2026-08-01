import { useState, useEffect, useRef } from 'react';
import type { Telemetry } from '../sim/useSimSocket';

interface LivePanelProps {
  telemetry: Telemetry | null;
  connected: boolean;
  onControl: (override: boolean, channels: number[]) => void;
}

const RAD2DEG = 180 / Math.PI;
const FPS2KMH = 1.09728; // 1 fps ≈ 1.097 km/h

function fmt(v: number | undefined, d = 2): string {
  if (v === undefined || !isFinite(v)) return '—';
  return v.toFixed(d);
}

export default function LivePanel({ telemetry, connected, onControl }: LivePanelProps) {
  const [override, setOverride] = useState(false);
  // 4 路手动通道: throttle / elevator / aileron / rudder
  const [ch, setCh] = useState<[number, number, number, number]>([0, 0, 0, 0]);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 接管期间周期性补发控制帧 (防止 0.5s 超时自动释放)
  useEffect(() => {
    if (override) {
      holdTimer.current = setInterval(() => {
        onControl(true, [...ch]);
      }, 200);
    } else {
      if (holdTimer.current) clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
    return () => { if (holdTimer.current) clearInterval(holdTimer.current); };
  }, [override, ch, onControl]);

  const toggleOverride = (next: boolean) => {
    setOverride(next);
    if (!next) onControl(false, []);
  };

  const updateCh = (i: number, v: number) => {
    const n = [...ch] as [number, number, number, number];
    n[i] = v;
    setCh(n);
    if (override) onControl(true, n);
  };

  const fcs = telemetry?.fcs || [0, 0, 0, 0];
  const att = telemetry?.att || [0, 0, 0];
  const aero = telemetry?.aero || [0, 0, 0];

  return (
    <div className="live-panel">
      <div className="live-status">
        <span className={connected ? 'dot dot-on' : 'dot dot-off'} />
        {connected ? `已连接 · ${(telemetry?.t ?? 0).toFixed(1)}s` : '未连接'}
      </div>

      {/* 人工地平仪 */}
      <div className="adi">
        <div
          className="adi-ball"
          style={{ transform: `rotate(${att[2] * RAD2DEG}deg) translateY(${Math.sin(-att[1]) * 60}px)` }}
        >
          <div className="adi-sky" />
          <div className="adi-ground" />
          <div className="adi-line" />
        </div>
        <div className="adi-roll">{fmt(att[0] * RAD2DEG, 1)}°</div>
      </div>

      {/* 数值 HUD */}
      <div className="live-grid">
        <Row label="空速" value={`${fmt(telemetry?.vc)} fps / ${fmt((telemetry?.vc || 0) * FPS2KMH, 0)} km/h`} />
        <Row label="马赫" value={fmt(telemetry?.mach, 3)} />
        <Row label="高度" value={`${fmt(telemetry?.pos?.[2], 1)} m`} />
        <Row label="AoA" value={`${fmt(aero[0] * RAD2DEG, 1)}°`} />
        <Row label="AoS" value={`${fmt(aero[1] * RAD2DEG, 1)}°`} />
        <Row label="推力" value={fmt(telemetry?.thrust, 0)} />
        <Row label="转速" value={fmt(telemetry?.rpm, 0)} />
        <Row label="油量" value={fmt(telemetry?.fuel, 1)} />
        <Row label="油门" value={fmt(fcs[0], 2)} />
        <Row label="升降" value={fmt(fcs[1], 2)} />
        <Row label="副翼" value={fmt(fcs[2], 2)} />
        <Row label="方向" value={fmt(fcs[3], 2)} />
      </div>

      {/* 手动接管 */}
      <div className="live-control">
        <label className="override-toggle">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => toggleOverride(e.target.checked)}
          />
          手动接管执行器 (Override)
        </label>
        <p className="live-hint">接管后 0.5s 无指令自动交还飞控</p>

        <Slider label="油门 (0-1)" min={0} max={1} step={0.01} value={ch[0]} disabled={!override}
          onChange={(v) => updateCh(0, v)} />
        <Slider label="升降舵 (-1..1)" min={-1} max={1} step={0.01} value={ch[1]} disabled={!override}
          onChange={(v) => updateCh(1, v)} />
        <Slider label="副翼 (-1..1)" min={-1} max={1} step={0.01} value={ch[2]} disabled={!override}
          onChange={(v) => updateCh(2, v)} />
        <Slider label="方向舵 (-1..1)" min={-1} max={1} step={0.01} value={ch[3]} disabled={!override}
          onChange={(v) => updateCh(3, v)} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="live-row">
      <span className="live-k">{label}</span>
      <span className="live-v">{value}</span>
    </div>
  );
}

function Slider({ label, min, max, step, value, disabled, onChange }: {
  label: string; min: number; max: number; step: number; value: number; disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="live-slider">
      <div className="live-slider-head">
        <span>{label}</span><span>{value.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}
