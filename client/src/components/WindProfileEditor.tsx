import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from '../i18n';
import FloatInput from './FloatInput';
import { waveSample, windProfileError, windSample, profileFromEnvironment, type WindProfile, type Wave } from '../sim/windProfile';
import './WindProfileEditor.css';

type Props = { value: WindProfile; onChange: (value: WindProfile) => void; onApply: (value: WindProfile) => void; busy?: boolean; message?: string; error?: boolean; legacyFields?: ReactNode };
const format = (n: number, digits = 1) => Math.abs(n) < 1e-8 ? (0).toFixed(digits) : n.toFixed(digits);

function WaveChart({ profile, channel, time, end, label }: { profile: WindProfile; channel: 'speed' | 'direction'; time: number; end: number; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(280);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(150, entries[0].contentRect.width)));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const wave = profile[`${channel}Wave`], mean = profile[channel === 'speed' ? 'speedMeanMps' : 'directionMeanDeg'];
  const amplitude = wave ? profile[channel === 'speed' ? 'speedAmplitudeMps' : 'directionAmplitudeDeg'] : 0;
  const period = profile[`${channel}PeriodSec`], phase = profile[`${channel}PhaseDeg`], duty = profile[`${channel}DutyPct`];
  const sample = (t: number) => waveSample(wave, mean, amplitude, period, phase, duty, t);
  const pad = amplitude ? amplitude*.18 : Math.max(1, mean*.1);
  const low = channel === 'speed' ? Math.max(0, mean-amplitude-pad) : mean-amplitude-pad, high = mean+amplitude+pad;
  const x = (t: number) => 36+t/end*(width-44), y = (v: number) => 12+(high-v)/(high-low)*88;
  const path = useMemo(() => {
    const count = Math.min(6000, Math.max(320, Math.ceil(end/period*100)));
    const times = Array.from({ length: count+1 }, (_, i) => i/count*end);
    if (wave === 3) for (let k = -2; k <= Math.ceil(end/period)+2; k++) for (const p of [0, duty/100]) {
      const t = (k+p-phase/360)*period;
      if (t > 0 && t < end) times.push(t-1e-7, t, t+1e-7);
    }
    times.sort((a, b) => a-b);
    return times.map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(2)} ${y(sample(t)).toFixed(2)}`).join(' ');
  }, [wave, mean, amplitude, period, phase, duty, end, width]);
  const ticks = [...new Set([mean-amplitude, mean, mean+amplitude])];
  return <svg ref={ref} className={`wind-profile-chart ${channel}`} viewBox={`0 0 ${width} 125`} role="img" aria-label={label}>
    {ticks.map(v => <g key={v}><line className="grid" x1="36" x2={width-8} y1={y(v)} y2={y(v)} /><text x="29" y={y(v)+4} textAnchor="end">{format(v, Number.isInteger(v) ? 0 : 1)}</text></g>)}
    {[0, .5, 1].map(f => <text key={f} x={x(end*f)} y="120" textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{format(end*f, end < 10 ? 1 : 0)}{f === 1 ? ' s' : ''}</text>)}
    <path className="trace" d={path} /><line className="cursor" x1={x(time)} x2={x(time)} y1="9" y2="103" /><circle className="point" cx={x(time)} cy={y(sample(time))} r="4" />
  </svg>;
}

export default function WindProfileEditor({ value, onChange, onApply, busy, message, error: applicationError, legacyFields }: Props) {
  const { isZh } = useLanguage(), tr = (zh: string, en: string) => isZh ? zh : en;
  const validation = windProfileError(value, isZh);
  const lastValid = useRef(validation ? profileFromEnvironment({}) : value);
  if (!validation) lastValid.current = value;
  const preview = lastValid.current;
  const end = Math.max(10, preview.speedWave ? preview.speedPeriodSec*2 : 0, preview.directionWave ? preview.directionPeriodSec*2 : 0);
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const marker = useId().replace(/:/g, '')+'-wind-arrow';
  const revision = JSON.stringify(value);
  useEffect(() => { setTime(0); setPlaying(false); }, [revision]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(.1, (now-previous)/1000); previous = now;
      setTime(current => Math.min(end, current+delta));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, end]);
  useEffect(() => { if (time >= end) setPlaying(false); }, [time, end]);
  const current = windSample(preview, time), radians = current.direction*Math.PI/180;
  const dx = Math.sin(radians), dy = -Math.cos(radians);
  const change = (key: keyof WindProfile, next: number) => onChange({ ...value, active: 1, [key]: next });
  const modes = [tr('固定', 'Fixed'), tr('正弦波', 'Sine'), tr('三角波', 'Triangle'), tr('方波', 'Square')];
  const field = (key: keyof WindProfile, label: string, unit: string, disabled = false) => <label key={key} className="wind-profile-field"><span>{label}</span><div><FloatInput value={value[key]} disabled={disabled} aria-label={`${label} (${unit})`} onValueChange={v => change(key, v)} /><em>{unit}</em></div></label>;
  return <div className="wind-profile-editor" data-testid="wind-profile-editor">
    <div className="wind-profile-heading"><strong>{tr('环境风', 'Environment wind')}</strong><span>{tr('水平风 · 来风方向', 'Horizontal wind · from direction')}</span></div>
    <div className="wind-profile-columns">
      {(['speed', 'direction'] as const).map(channel => {
        const speed = channel === 'speed', wave = value[`${channel}Wave`];
        const mean = preview[speed ? 'speedMeanMps' : 'directionMeanDeg'], amp = preview[`${channel}Wave`] ? preview[speed ? 'speedAmplitudeMps' : 'directionAmplitudeDeg'] : 0;
        const title = speed ? tr('风速', 'Wind speed') : tr('风向', 'Wind direction');
        return <div className={`wind-profile-channel ${channel}`} key={channel}>
          <div className="wind-profile-channel-title"><strong>{title}</strong><span>{format(mean-amp, speed ? 1 : 0)}{amp ? `–${format(mean+amp, speed ? 1 : 0)}` : ''} {speed ? 'm/s' : '°'}</span></div>
          <div className="wind-profile-wave-buttons" role="group" aria-label={title}>{modes.map((name, i) => <button type="button" key={i} aria-pressed={wave === i} onClick={() => change(`${channel}Wave`, i as Wave)}>{name}</button>)}</div>
          <div className="wind-profile-fields">
            {field(speed ? 'speedMeanMps' : 'directionMeanDeg', speed ? tr('基准风速', 'Mean speed') : tr('基准风向', 'Mean direction'), speed ? 'm/s' : '°')}
            {field(speed ? 'speedAmplitudeMps' : 'directionAmplitudeDeg', speed ? tr('振幅', 'Amplitude') : tr('摆动振幅', 'Amplitude'), speed ? 'm/s' : '°', wave === 0)}
            {field(`${channel}PeriodSec`, tr('周期', 'Period'), 's', wave === 0)}
            {field(`${channel}PhaseDeg`, tr('初相位', 'Phase'), '°', wave === 0)}
            {wave === 3 && field(`${channel}DutyPct`, tr('高值占空比', 'High duty cycle'), '%')}
          </div>
          <div className="wind-profile-chart-label"><span>{speed ? tr('风速 m/s', 'Speed m/s') : tr('连续风向 °', 'Unwrapped direction °')}</span><span className="wind-profile-legend">{modes[preview[`${channel}Wave`]]}</span></div>
          <WaveChart profile={preview} channel={channel} time={Math.min(time, end)} end={end} label={speed ? tr('风速波形预览', 'Wind speed preview') : tr('风向波形预览', 'Wind direction preview')} />
        </div>;
      })}
    </div>
    {validation && <div className="wind-profile-error" role="alert">{validation}</div>}
    <div className="wind-profile-preview">
      <div className="wind-profile-time"><div className="wind-profile-preview-label"><span>{tr('配置预览', 'Configuration preview')}</span><output>t = {format(time)} s</output></div><div className="wind-profile-values"><span><b>{format(current.speed)}</b> m/s</span><span><b>{current.speed > 1e-6 ? format(current.direction) : '—'}</b> ° {tr('来风', 'from')}</span></div>
        <div className="wind-profile-scrubber"><button type="button" disabled={!!validation} aria-label={playing ? tr('暂停预览', 'Pause preview') : tr('播放预览', 'Play preview')} onClick={() => { if (time >= end) setTime(0); setPlaying(p => !p); }}>{playing ? 'Ⅱ' : '▷'}</button><input type="range" aria-label={tr('预览仿真时间', 'Preview simulation time')} min="0" max={end} step="0.01" value={Math.min(time, end)} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} /><span>{format(end, end < 10 ? 1 : 0)} s</span></div>
        <div className="wind-profile-preview-note">{tr('0° 北风 · 90° 东风 · 时间轴仅控制预览', '0° north · 90° east · timeline controls preview only')}</div>
      </div>
      <svg className="wind-profile-compass" viewBox="0 0 132 132" role="img" aria-label={tr('来风方向示意，箭头吹向中心', 'Wind from direction; arrow blows toward center')}>
        <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" /></marker></defs>
        <circle cx="66" cy="66" r="40" className="ring" /><line x1="66" y1="26" x2="66" y2="106" className="axis" /><line x1="26" y1="66" x2="106" y2="66" className="axis" />
        <text x="66" y="16" textAnchor="middle">{tr('北', 'N')}</text><text x="119" y="70" textAnchor="middle">{tr('东', 'E')}</text><text x="66" y="127" textAnchor="middle">{tr('南', 'S')}</text><text x="13" y="70" textAnchor="middle">{tr('西', 'W')}</text>
        {current.speed > 1e-6 && <g className="wind-vector"><circle cx={66+36*dx} cy={66+36*dy} r="3" /><line x1={66+32*dx} y1={66+32*dy} x2={66-11*dx} y2={66-11*dy} markerEnd={`url(#${marker})`} /></g>}
      </svg>
    </div>
    <details className="wind-profile-advanced"><summary>{tr('垂直风与分量', 'Vertical wind and components')}</summary><div className="wind-profile-advanced-content">{field('downMps', tr('垂直风（向下为正）', 'Vertical wind (down positive)'), 'm/s')}<span>{tr('北向', 'North')} {format(current.north, 2)} · {tr('东向', 'East')} {format(current.east, 2)} · {tr('地向', 'Down')} {format(current.down, 2)} m/s</span></div><label className="wind-profile-legacy"><input type="checkbox" checked={!value.active} onChange={e => onChange({ ...value, active: e.target.checked ? 0 : 1 })} />{tr('使用原有固定三轴风', 'Use legacy fixed NED wind')}</label>{!value.active && legacyFields}</details>
    <div className="wind-profile-actions"><span role="status" className={applicationError ? 'wind-profile-error' : ''}>{message || (!value.active ? tr('当前使用固定三轴风', 'Using fixed NED wind') : tr('修改后点击应用；保存后下次启动保留', 'Apply changes; save to retain for next start'))}</span><button type="button" disabled={busy || !!validation} onClick={() => { setTime(0); setPlaying(false); onApply(value); }}>{busy ? tr('正在应用…', 'Applying…') : tr('应用风场', 'Apply wind')}</button></div>
  </div>;
}
