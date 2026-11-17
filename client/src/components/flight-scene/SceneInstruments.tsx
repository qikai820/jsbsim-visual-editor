import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { canonicalMonitorProperty } from '../../sim/monitorIdentity';
import { propertyAgeMs, STALE_MS, type ScenePose } from '../../sim/flightSceneState';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';
import { compassAttitude, MAX_VALUE_COLUMNS, MAX_VALUE_ROWS, newSceneValue, resizeSceneValues, SCENE_VALUE_SOURCES,
  sceneCustomPath, sceneUnitOptions, sceneValueReading, type SceneDisplay, type SceneValue, type SceneValueLayout } from '../../sim/sceneInstruments';

export function SceneIcon({ name }: { name: 'plane' | 'layers' | 'gauge' | 'chart' | 'settings' | 'close' | 'pin' | 'focus' | 'map' | 'camera' | 'chevron' }) {
  const paths = {
    plane: <path d="m12 3 2 7 7 4v2l-7-2v5l2 2-4-1-4 1 2-2v-5l-7 2v-2l7-4z" />,
    layers: <><path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    gauge: <><path d="M4 18a9 9 0 1 1 16 0M12 12l5-5" /><circle cx="12" cy="12" r="2" /></>,
    chart: <><path d="M4 3v17h17M7 15l4-5 4 3 5-8" /></>,
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6M16 9v6M10 15v6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pin: <path d="m9 3 6 0-1 6 4 5H6l4-5zM12 14v7" />,
    focus: <path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" />,
    map: <path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16" />,
    camera: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function CircularSceneHud({ pose, noseUp, now, onConfigure }: { pose?: ScenePose; noseUp: boolean; now: number; onConfigure: () => void }) {
  const a = compassAttitude(pose?.yaw ?? 0, pose?.roll ?? 0, pose?.pitch ?? 0, noseUp);
  const stale = !pose || (propertyAgeMs(pose.receivedAt, now) ?? Infinity) >= STALE_MS;
  const cx = 85, cy = 99, radius = 68, radians = (angle: number) => angle * Math.PI / 180;
  const point = (r: number, angle: number) => [cx + r * Math.cos(radians(angle)), cy + r * Math.sin(radians(angle))];
  const arc = (start: number, end: number) => { const p = point(83, start), q = point(83, end); return `M${p[0]} ${p[1]} A83 83 0 0 1 ${q[0]} ${q[1]}`; };
  const age = pose ? ` · ${stale ? '位姿过期' : pose.state === 'paused' ? '已暂停' : '实时位姿'}` : ' · 等待位姿';
  return <button className={`scene-round-hud ${stale ? 'stale' : ''}`} onClick={onConfigure}
    data-heading={pose ? a.heading : ''} data-dial={a.dial} data-roll={a.rollArc} data-pitch={a.pitchArc}
    aria-label={`圆形 HUD 设置${age}`} title={`航向 ${pose ? a.heading.toFixed(1) + '°' : '—'} · 横滚 ${pose?.roll.toFixed(1) ?? '—'}° · 俯仰 ${pose?.pitch.toFixed(1) ?? '—'}°${age}`}>
    <svg viewBox="0 0 184 184" role="img" aria-label={`航向 ${pose ? Math.round(a.heading) + ' 度' : '未知'}，${noseUp ? '机头朝上' : '北向上'}；上弧横滚、右弧俯仰`}>
      <g className="scene-hud-arc" fill="none" strokeWidth="13">
        <path d={arc(-120, -60)} /><path d={arc(-30, 30)} />
        {pose && Math.abs(pose.roll) > 1 && <path className="value" d={arc(Math.min(-90, -90 + a.rollArc), Math.max(-90, -90 + a.rollArc))} />}
        {pose && Math.abs(pose.pitch) > 1 && <path className="value" d={arc(Math.min(0, a.pitchArc), Math.max(0, a.pitchArc))} />}
      </g>
      <path d={`M${cx} ${cy - 90}v14M${cx + 76} ${cy}h14`} stroke="#f5f8fb" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r={radius} fill="#202326" />
      {Array.from({ length: 16 }, (_, i) => i * 22.5).filter(angle => angle % 90 !== 0).map(angle => {
        const start = point(radius - (angle % 45 === 0 ? 11 : 8), angle + a.dial - 90), end = point(radius - 5, angle + a.dial - 90);
        return <line key={angle} x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} stroke="#ecf1f6" strokeWidth="1" />;
      })}
      {['N', 'E', 'S', 'W'].map((label, i) => { const p = point(radius - 15, i * 90 + a.dial - 90); return <text key={label} x={p[0]} y={p[1]} textAnchor="middle" dominantBaseline="central">{label}</text>; })}
      {pose && <g transform={`translate(${cx} ${cy}) rotate(${a.arrow})`} stroke="#fff" strokeWidth="1"><path d="M0-25 17 21 0 11Z" fill="#ee3424" /><path d="M0-25-17 21 0 11Z" fill="#c72b27" /></g>}
      <text className="scene-hud-heading" x={cx} y={cy + 32} textAnchor="middle">{pose ? `${Math.round(a.heading)}°` : '—'}</text>
    </svg>
  </button>;
}

export function SceneValueGrid({ layout, pose, ground, now, demo, editing, selected, onSelect, onMove, onConfigure }: {
  layout: SceneValueLayout; pose?: ScenePose; ground: number | null; now: number; demo: boolean;
  editing: boolean; selected: number; onSelect: (index: number) => void; onMove: (from: number, to: number) => void; onConfigure: () => void;
}) {
  const grid = useRef<HTMLDivElement>(null), pointer = useRef<{ id: number; from: number; x: number; y: number; moving: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [columns, setColumns] = useState(layout.columns);
  useEffect(() => {
    const element = grid.current; if (!element) return;
    const resize = () => setColumns(Math.max(1, Math.min(layout.columns, Math.floor(element.clientWidth / 78))));
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, [layout.columns]);
  const monitor = useSignalMonitorStore.getState(), run = pose ? monitor.running[pose.id] : undefined;
  const custom = new Map(Object.entries(monitor.samples).filter(([key]) => pose && key.startsWith(pose.id + ':'))
    .map(([key, sample]) => [canonicalMonitorProperty(key.slice(key.indexOf(':') + 1)), { ...sample, generation: run?.generation ?? '' }]));
  const clearDrag = () => grid.current?.querySelectorAll('[data-drop]').forEach(element => element.removeAttribute('data-drop'));
  return <div className={`scene-values ${editing ? 'editing' : ''}`} aria-label="飞行数值信息条">
    <div className="scene-values-grid" ref={grid} style={{ '--value-columns': columns } as CSSProperties} onPointerDown={event => {
      const cell = (event.target as Element).closest<HTMLElement>('[data-value-cell]');
      if (editing && cell && event.button === 0) pointer.current = { id: event.pointerId, from: Number(cell.dataset.valueCell), x: event.clientX, y: event.clientY, moving: false };
    }} onPointerMove={event => {
      const drag = pointer.current; if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moving && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) { drag.moving = true; event.currentTarget.setPointerCapture(event.pointerId); }
      if (drag.moving) { event.preventDefault(); clearDrag(); const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-value-cell]'); if (over && grid.current?.contains(over)) over.setAttribute('data-drop', 'true'); }
    }} onPointerUp={event => {
      const drag = pointer.current; pointer.current = null; if (!drag?.moving) return;
      suppressClick.current = true; const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-value-cell]');
      if (over && grid.current?.contains(over)) onMove(drag.from, Number(over.dataset.valueCell));
      clearDrag(); window.setTimeout(() => { suppressClick.current = false; }, 0);
    }} onPointerCancel={() => { pointer.current = null; clearDrag(); }}>
      {layout.cells.map((cell, index) => {
        const reading = cell ? sceneValueReading(cell, pose, ground, now, !demo ? custom.get(sceneCustomPath(cell.path)) : undefined) : null;
        return <button key={index} className={`scene-value-cell ${!cell ? 'empty' : ''} ${reading?.stale ? 'stale' : ''}`}
          data-value-cell={index} data-source={cell?.source} aria-pressed={editing && index === Math.max(0, Math.min(selected, layout.cells.length - 1))}
          aria-label={`${cell?.label ?? '添加指标'}，第 ${Math.floor(index / layout.columns) + 1} 行第 ${index % layout.columns + 1} 列`}
          title={cell ? `${cell.label} · ${reading?.text} ${cell.unit} · ${reading?.status}` : '添加数值指标'}
          onClick={() => { if (!suppressClick.current) onSelect(index); }} tabIndex={!cell && !editing ? -1 : undefined}>
          {cell ? <><span className="scene-value-label">{cell.source === 'time' && ['仿真时间', '航时'].includes(cell.label) ? '◴' : cell.label}</span><span className="scene-value-number">{reading?.text}</span><span className="scene-value-unit">{cell.unit}</span></> : '+'}
        </button>;
      })}
    </div>
    <button className="scene-values-config" onClick={onConfigure} aria-label={editing ? '完成数值配置' : '配置数值行列'}><SceneIcon name="settings" />{editing ? '完成' : '数值'}</button>
  </div>;
}

export function SceneInstrumentSettings({ display, selected, onSelected, onChange, onClose, unavailableKeys, initialHud = false }: {
  display: SceneDisplay; selected: number; onSelected: (index: number) => void; onChange: (display: SceneDisplay) => void;
  onClose: () => void; unavailableKeys: string[]; initialHud?: boolean;
}) {
  const layout = display.values, index = Math.max(0, Math.min(selected, layout.cells.length - 1)), cell = layout.cells[index];
  const updateLayout = (values: SceneValueLayout) => onChange({ ...display, values });
  const updateCell = (patch: Partial<SceneValue>) => { if (cell) updateLayout({ ...layout, cells: layout.cells.map((item, i) => i === index ? { ...cell, ...patch } : item) }); };
  const move = (target: number) => { const cells = [...layout.cells]; [cells[index], cells[target]] = [cells[target], cells[index]]; updateLayout({ ...layout, cells }); onSelected(target); };
  const findSlot = (value?: SceneValue, spare?: number) => {
    let next = layout, empty = next.cells.findIndex(item => !item);
    if (empty < 0 && next.rows < MAX_VALUE_ROWS) { next = resizeSceneValues(next, next.rows + 1, next.columns); empty = next.cells.findIndex(item => !item); }
    if (empty < 0) return;
    const cells = [...next.cells]; if (value) cells[empty] = value;
    updateLayout({ ...next, cells, overflow: spare === undefined ? next.overflow : next.overflow.filter((_, i) => i !== spare) }); onSelected(empty);
  };
  const full = layout.cells.every(Boolean) && layout.rows >= MAX_VALUE_ROWS;
  return <aside className="scene-inspector scene-instrument-settings" aria-label="数值与 HUD 设置">
    <header><strong>数值显示</strong><button className="scene-action" onClick={onClose}>完成</button></header>
    <section><div className="scene-value-dimensions">{(['rows', 'columns'] as const).map((key, i) => <label key={key}>{i ? '列数' : '行数'}
      <div><button aria-label={`减少一${i ? '列' : '行'}`} disabled={layout[key] <= 1} onClick={() => updateLayout(resizeSceneValues(layout, layout.rows - (i ? 0 : 1), layout.columns - (i ? 1 : 0)))}>−</button>
        <output aria-label={i ? '数值列数' : '数值行数'}>{layout[key]}</output>
        <button aria-label={`增加一${i ? '列' : '行'}`} disabled={layout[key] >= (i ? MAX_VALUE_COLUMNS : MAX_VALUE_ROWS)} onClick={() => updateLayout(resizeSceneValues(layout, layout.rows + (i ? 0 : 1), layout.columns + (i ? 1 : 0)))}>+</button></div></label>)}</div>
      <p className="scene-muted">点击单元格编辑，拖动交换位置。窄窗口自动换行。</p>
    </section>
    <section><h3>第 {Math.floor(index / layout.columns) + 1} 行 · 第 {index % layout.columns + 1} 列</h3>
      <label>数据项<select aria-label="数值数据项" value={cell?.source ?? ''} onChange={event => updateLayout({ ...layout, cells: layout.cells.map((item, i) => i === index ? event.target.value ? newSceneValue(event.target.value) : null : item) })}>
        <option value="">选择数据项…</option>{SCENE_VALUE_SOURCES.map(source => <option key={source.id} value={source.id}>{source.id === 'custom' ? '自定义 JSBSim 属性' : source.label}</option>)}
      </select></label>
      {cell && <>
        {cell.source === 'custom' && <label>JSBSim 属性路径<input key={`${index}:${cell.source}`} aria-label="JSBSim 属性路径" maxLength={200} placeholder="fcs/voliro_t/pitch-rad" defaultValue={cell.path} onBlur={event => updateCell({ path: event.target.value.trim() })} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
          {cell.path && !sceneCustomPath(cell.path) && <small className="scene-editor-error">请输入有效的属性路径</small>}</label>}
        <label>显示名称<input aria-label="数值显示名称" maxLength={24} value={cell.label} onChange={event => updateCell({ label: event.target.value })} /></label>
        <div className="scene-value-field-pair"><label>单位{cell.source === 'custom' ? <input aria-label="数值单位" maxLength={16} value={cell.unit} onChange={event => updateCell({ unit: event.target.value })} />
          : <select aria-label="数值单位" value={cell.unit} onChange={event => updateCell({ unit: event.target.value })}>{sceneUnitOptions(cell.source).map(unit => <option key={unit} value={unit}>{unit || '无'}</option>)}</select>}</label>
          <label>小数位<select aria-label="数值小数位" value={cell.precision} onChange={event => updateCell({ precision: Number(event.target.value) })}>{[0, 1, 2, 3, 4, 5, 6].map(value => <option key={value}>{value}</option>)}</select></label></div>
        {cell.source === 'custom' && <details><summary>原始值换算</summary><div className="scene-value-field-pair">{(['scale', 'offset'] as const).map((key, i) => <label key={key}>{i ? '偏移' : '倍率'}<input type="number" step="any" aria-label={i ? '自定义数值偏移' : '自定义数值倍率'} key={`${index}:${key}`} defaultValue={cell[key]} onBlur={event => { if (Number.isFinite(event.target.valueAsNumber)) updateCell({ [key]: event.target.valueAsNumber }); else event.target.value = String(cell[key]); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>)}</div><p className="scene-muted">显示值 = 原始值 × 倍率 + 偏移</p></details>}
      </>}
      <div className="scene-editor-actions"><button className="scene-action" disabled={index === 0} onClick={() => move(index - 1)}>← 前移</button><button className="scene-action" disabled={index === layout.cells.length - 1} onClick={() => move(index + 1)}>后移 →</button>
        <button className="scene-action" disabled={!cell} onClick={() => updateLayout({ ...layout, cells: layout.cells.map((value, i) => i === index ? null : value) })}>移除</button></div>
    </section>
    <section><button className="scene-action" disabled={full} onClick={() => findSlot()}>＋ 添加指标</button>
      {!!layout.overflow.length && <details><summary>未放置指标 · {layout.overflow.length}</summary><div className="scene-editor-actions">{layout.overflow.map((value, i) => <button className="scene-action" key={i} disabled={full} onClick={() => findSlot(value, i)}>＋ {value.label}</button>)}</div></details>}
      {unavailableKeys.length > 0 && <p className="scene-editor-error" role="status">监视通道已满，以下属性等待空闲通道：{unavailableKeys.join('、')}</p>}
    </section>
    <section><details open={initialHud || undefined}><summary>圆形 HUD</summary>
      <label className="scene-editor-check"><input type="checkbox" checked={display.hud} onChange={event => onChange({ ...display, hud: event.target.checked })} />显示圆形 HUD</label>
      <label>航向模式<select aria-label="航向显示模式" value={display.noseUp ? 'nose' : 'north'} onChange={event => onChange({ ...display, noseUp: event.target.value === 'nose' })}><option value="north">北向上</option><option value="nose">机头朝上</option></select></label>
      <p className="scene-muted">上弧：横滚；右弧：俯仰；箭头：机头方向。随所选飞机切换。</p>
    </details><label className="scene-editor-check"><input type="checkbox" checked={display.numbers} onChange={event => onChange({ ...display, numbers: event.target.checked })} />显示数值信息条</label><p className="scene-muted">布局保存在本机。灰色为过期采样，未收到的值显示为 —。</p></section>
  </aside>;
}
