import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SimInstanceSummary } from '../utils/tauriApi';
import { isTauri, simInstanceFields } from '../utils/tauriApi';
import {
  BUILTIN_FLEET_FIELDS, DEFAULT_FLEET_LIST_FIELDS, FLEET_LIST_DISPLAY_KEY,
  MAX_FLEET_LIST_FIELDS, canonicalFleetPropertyPath, fleetFieldIcon, fleetFieldLabel,
  fleetFieldValue, normalizeFleetListFields, readFleetListFields, type FleetListField,
} from '../utils/fleetListDisplay';
import './FleetInstanceList.css';

const IDS = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0'));
const FRESH_MS = 2000;
const DISCONNECTED_MS = 10000;

type IconName = 'up' | 'right' | 'time' | 'unlock';

// The simple paths match QGroundControl's InstrumentValueIcons used by its telemetry bar.
const ICON_PATHS: Record<IconName, string> = {
  up: 'M9 3.828 2.929 9.899 1.515 8.485 10 0l.707.707 7.778 7.778-1.414 1.414L11 3.828V20H9z',
  right: 'm16.172 9-6.071-6.071 1.414-1.414L20 10l-.707.707-7.778 7.778-1.414-1.414L16.172 11H0V9z',
  time: 'M10 20a10 10 0 1 1 0-20 10 10 0 0 1 0 20m0-2a8 8 0 1 0 0-16 8 8 0 0 0 0 16m-1-7.59V4h2v5.59l3.95 3.95-1.41 1.41z',
  unlock: 'M4 8V6a6 6 0 1 1 12 0h-3v2h4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-8c0-1.1.9-2 2-2zm5 6.73V17h2v-2.27a2 2 0 1 0-2 0M7 6v2h6V6a3 3 0 0 0-6 0',
};

function FleetIcon({ name }: { name: IconName }) {
  return <svg className="fleet-icon" viewBox="0 0 20 20" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}

function MiniHud({ id, item, fresh }: { id: string; item: SimInstanceSummary | null; fresh: boolean }) {
  const clipId = useId().replace(/:/g, '');
  const roll = item?.roll_deg;
  const pitch = item?.pitch_deg;
  const yaw = item?.yaw_deg;
  const attitudeValid = fresh && typeof roll === 'number' && Number.isFinite(roll)
    && typeof pitch === 'number' && Number.isFinite(pitch);
  const bank = attitudeValid ? Math.max(-80, Math.min(80, roll)) : 0;
  const pitchShift = attitudeValid ? Math.max(-15, Math.min(15, pitch * 0.7)) : 0;
  const heading = attitudeValid && typeof yaw === 'number' && Number.isFinite(yaw)
    ? `${String(Math.round(((yaw % 360) + 360) % 360)).padStart(3, '0')}°` : '---';
  const label = attitudeValid
    ? `实例 ${id} 姿态：Roll ${roll!.toFixed(1)}°，Pitch ${pitch!.toFixed(1)}°，航向 ${heading}`
    : `实例 ${id} 暂无新鲜姿态数据`;
  return <svg className={`fleet-mini-hud${attitudeValid ? '' : ' offline'}`} viewBox="0 0 56 56"
      role="img" aria-label={label}>
    <defs><clipPath id={clipId}><rect x="1" y="1" width="54" height="54" rx="7" /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}>
      <g transform={`translate(0 ${pitchShift}) rotate(${-bank} 28 28)`}>
        <rect x="-30" y="-30" width="116" height="58" fill="#6ea8cc" />
        <rect x="-30" y="28" width="116" height="58" fill="#b68f70" />
        <line x1="-30" y1="28" x2="86" y2="28" stroke="#f8f2e9" strokeWidth="2" />
      </g>
      <path d="M8 31h12l8 4 8-4h12" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="28" cy="31" r="2" fill="#fff" />
      <text x="28" y="10" textAnchor="middle" fill="#fff" fontSize="8" fontWeight="700">{heading}</text>
      <rect x="2" y="41" width="21" height="13" rx="3" fill="rgba(20,41,54,.75)" />
      <text x="12.5" y="51" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700">{id}</text>
    </g>
    <rect x="1" y="1" width="54" height="54" rx="7" fill="none" stroke="#8ab9d4" strokeWidth="1.5" />
  </svg>;
}

function instanceState(item: SimInstanceSummary | null, connected: boolean) {
  const age = item?.age_ms ?? Infinity;
  if (!item) return { name: '待接入', dot: 'offline', fresh: false };
  if (!connected || age >= DISCONNECTED_MS) return { name: '未连接', dot: 'offline', fresh: false };
  if (age >= FRESH_MS) return { name: '遥测延迟', dot: 'delayed', fresh: false };
  if (item.state === 'fault') return { name: '故障', dot: 'fault', fresh: true };
  if (item.state === 'paused') return { name: '已暂停', dot: 'paused', fresh: true };
  if (item.state === 'stopped') return { name: '已停止', dot: 'offline', fresh: true };
  if (item.state === 'running') return { name: '运行中', dot: 'running', fresh: true };
  return { name: item.state || '待更新', dot: 'offline', fresh: true };
}

function Metric({ field, item, values, fresh }: {
  field: FleetListField; item: SimInstanceSummary | null;
  values?: Record<string, number>; fresh: boolean;
}) {
  const icon = fleetFieldIcon(field);
  const label = fleetFieldLabel(field);
  const value = fleetFieldValue(field, fresh ? item : null, values);
  const title = field.kind === 'property' ? field.path : field.key === 'realtime_factor'
    ? `实时倍率（板端仿真时间 ÷ 单调时间，近 1–3 秒）：${value}` : `${label} ${value}`;
  return <span className="fleet-list-metric" title={title}>
    {icon && <FleetIcon name={icon as IconName} />}
    <small>{label}</small><b>{value}</b>
  </span>;
}

interface Props {
  summaries: SimInstanceSummary[];
  fallback: SimInstanceSummary | null;
  connected: boolean;
  selected: string;
  onSelect: (id: string) => void;
}

export default function FleetInstanceList({ summaries, fallback, connected, selected, onSelect }: Props) {
  const [savedFields, setSavedFields] = useState(readFleetListFields);
  const [draftFields, setDraftFields] = useState<FleetListField[]>(savedFields);
  const [editing, setEditing] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [customDigits, setCustomDigits] = useState(1);
  const [error, setError] = useState('');
  const [customValues, setCustomValues] = useState<Record<string, Record<string, number>>>({});
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const draggedFieldRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const visibleFields = editing ? draftFields : savedFields;
  const byId = useMemo(() => new Map(summaries.map(item => [item.instance_id, item])), [summaries]);
  const propertyPaths = useMemo(() => [...new Set(visibleFields.flatMap(field =>
    field.kind === 'property' ? [field.path] : []))].sort(), [visibleFields]);
  const propertyKey = propertyPaths.join('\u0000');

  useEffect(() => {
    if (!isTauri || !propertyKey) { setCustomValues({}); return; }
    let alive = true;
    let busy = false;
    const paths = propertyKey.split('\u0000');
    const load = () => {
      if (busy) return;
      busy = true;
      void simInstanceFields(paths).then(items => {
        if (alive) setCustomValues(Object.fromEntries(items.map(item => [item.instance_id, item.values])));
      }).catch(() => { if (alive) setCustomValues({}); })
        .finally(() => { busy = false; });
    };
    load();
    const timer = window.setInterval(load, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [propertyKey]);

  const itemFor = (id: string) => byId.get(id) || (id === '01' ? fallback : null);
  const valuesFor = (id: string, item: SimInstanceSummary | null) => {
    const values = { ...(customValues[id] || {}) };
    if (item?.properties) for (const path of propertyPaths) {
      const value = item.properties[`/${id}${path}`] ?? item.properties[path];
      if (typeof value === 'number') values[path] = value;
    }
    return values;
  };
  const openEditor = () => {
    setDraftFields(savedFields.map(field => ({ ...field })));
    setCustomPath(''); setCustomLabel(''); setCustomUnit(''); setCustomDigits(1); setError('');
    draggedFieldRef.current = null; setDraggingIndex(null); setDropIndex(null);
    setEditing(true);
    dialogRef.current?.showModal();
  };
  const closeEditor = () => { dialogRef.current?.close(); };
  const addBuiltin = (key: (typeof BUILTIN_FLEET_FIELDS)[number]['key']) => {
    setError('');
    setDraftFields(current => current.length >= MAX_FLEET_LIST_FIELDS ||
      current.some(field => field.kind === 'builtin' && field.key === key)
      ? current : [...current, { kind: 'builtin', key }]);
  };
  const addRow = () => {
    const slots = Math.min(3 - draftFields.length % 3, MAX_FLEET_LIST_FIELDS - draftFields.length);
    const available = BUILTIN_FLEET_FIELDS.filter(option => !draftFields.some(field =>
      field.kind === 'builtin' && field.key === option.key)).slice(0, slots);
    if (!available.length) { setError('可添加自定义数值属性。'); return; }
    setDraftFields(current => [...current, ...available.slice(0, MAX_FLEET_LIST_FIELDS - current.length)
      .map(option => ({ kind: 'builtin' as const, key: option.key }))]);
    setError('');
  };
  const addCustom = () => {
    const path = canonicalFleetPropertyPath(customPath);
    if (!path) { setError('请输入 /jsbsim/ 开头的数值属性路径。'); return; }
    if (draftFields.some(field => field.kind === 'property' && field.path === path)) {
      setError('这个属性已在列表中。'); return;
    }
    if (draftFields.length >= MAX_FLEET_LIST_FIELDS) { setError(`最多显示 ${MAX_FLEET_LIST_FIELDS} 项。`); return; }
    const label = customLabel.trim() || path.split('/').pop() || '属性';
    setDraftFields(current => [...current, { kind: 'property', path,
      label: label.slice(0, 24), unit: customUnit.trim().slice(0, 12), digits: customDigits }]);
    setCustomPath(''); setCustomLabel(''); setCustomUnit(''); setError('');
  };
  const swapFields = (index: number, target: number) => {
    if (target < 0 || target >= draftFields.length || target === index) return;
    const next = [...draftFields];
    [next[index], next[target]] = [next[target], next[index]];
    setDraftFields(next);
  };
  const endFieldDrag = () => {
    draggedFieldRef.current = null;
    setDraggingIndex(null);
    setDropIndex(null);
  };
  const handleFieldKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.target !== event.currentTarget) return;
    let target = index;
    if (event.key === 'ArrowLeft' && index % 3 > 0) target--;
    else if (event.key === 'ArrowRight' && index % 3 < 2) target++;
    else if (event.key === 'ArrowUp') target -= 3;
    else if (event.key === 'ArrowDown') target += 3;
    if (target === index || target < 0 || target >= draftFields.length) return;
    event.preventDefault();
    swapFields(index, target);
  };
  const saveEditor = () => {
    const next = normalizeFleetListFields(draftFields);
    try { localStorage.setItem(FLEET_LIST_DISPLAY_KEY, JSON.stringify(next)); }
    catch { setError('本机无法保存显示设置，请检查本地存储权限。'); return; }
    setSavedFields(next);
    closeEditor();
  };
  const renderCardContents = (id: string, item: SimInstanceSummary | null) => {
    const state = instanceState(item, connected);
    const values = valuesFor(id, item);
    return <>
      <MiniHud id={id} item={item} fresh={state.fresh} />
      <span className="fleet-list-metrics">{visibleFields.map(field =>
        <Metric key={field.kind === 'builtin' ? field.key : field.path} field={field}
          item={item} values={values} fresh={state.fresh} />)}</span>
      <i className={`fleet-list-dot ${state.dot}`} aria-hidden="true" />
    </>;
  };
  const selectedItem = itemFor(selected);

  return <>
    <div className="multi-sim-section-title fleet-list-title">
      <div><h2>实例</h2><small>8 个槽位</small></div>
      <button type="button" className="fleet-list-edit-trigger" onClick={openEditor}
        aria-haspopup="dialog" title="自定义列表显示项"><FleetIcon name="unlock" />编辑显示项</button>
    </div>
    <div className="fleet-list-cards">{IDS.map(id => {
      const item = itemFor(id);
      const state = instanceState(item, connected);
      return <button key={id} type="button"
        className={`fleet-list-card${selected === id ? ' selected' : ''}`}
        onClick={() => onSelect(id)} aria-pressed={selected === id}
        aria-label={`实例 ${id}，${state.name}`} title={`实例 ${id} · ${state.name}`}>
        {renderCardContents(id, item)}
      </button>;
    })}</div>
    <dialog ref={dialogRef} className="fleet-list-dialog" aria-labelledby="fleet-list-dialog-title"
      onClose={() => { setEditing(false); setDraftFields(savedFields); setError(''); }}>
      <div className="fleet-list-dialog-head">
        <div><h2 id="fleet-list-dialog-title">自定义实例信息带</h2>
          <p>拖动字段交换位置；左、中、右三列与实例卡片一致，也可用方向键调整。</p></div>
        <button type="button" onClick={closeEditor} aria-label="关闭显示设置">×</button>
      </div>
      <div className="fleet-list-dialog-body">
        <h3>实例 {selected} 预览</h3>
        <div className="fleet-list-card fleet-list-preview">{renderCardContents(selected, selectedItem)}</div>
        <div className="fleet-list-edit-head"><h3>当前显示</h3><small>{draftFields.length} / {MAX_FLEET_LIST_FIELDS} 项</small></div>
        <div className="fleet-list-edit-fields" role="list" aria-label="实例卡片字段位置">{draftFields.map((field, index) =>
          <div className={`fleet-list-edit-field${draggingIndex === index ? ' dragging' : ''}${dropIndex === index && draggingIndex !== index ? ' drop-target' : ''}`}
            key={field.kind === 'builtin' ? field.key : field.path} role="listitem" tabIndex={0} draggable
            aria-label={`${fleetFieldLabel(field)}，第 ${Math.floor(index / 3) + 1} 行${['左', '中', '右'][index % 3]}列；拖动或用方向键交换位置`}
            onKeyDown={event => handleFieldKey(event, index)}
            onDragStart={event => { if ((event.target as HTMLElement).closest('button')) { event.preventDefault(); return; }
              draggedFieldRef.current = index; setDraggingIndex(index);
              event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
            onDragOver={event => { if (draggedFieldRef.current === null) return;
              event.preventDefault(); event.dataTransfer.dropEffect = 'move';
              if (dropIndex !== index) setDropIndex(index); }}
            onDrop={event => { event.preventDefault();
              if (draggedFieldRef.current !== null) swapFields(draggedFieldRef.current, index);
              endFieldDrag(); }}
            onDragEnd={endFieldDrag}>
            <span className="fleet-list-drag-handle" aria-hidden="true">⠿</span>
            <span>{fleetFieldLabel(field)}{field.kind === 'property' && <small>{field.path}</small>}</span>
            <button type="button" onClick={() => setDraftFields(current => current.filter((_, position) => position !== index))}
              disabled={draftFields.length === 1} aria-label={`移除${fleetFieldLabel(field)}`}>−</button>
          </div>)}</div>
        <div className="fleet-list-row-actions">
          <button type="button" onClick={addRow} disabled={draftFields.length >= MAX_FLEET_LIST_FIELDS}>＋ 添加一行</button>
          <button type="button" onClick={() => setDraftFields(current =>
            current.slice(0, Math.max(1, Math.floor((current.length - 1) / 3) * 3)))}
            disabled={draftFields.length <= 1}>− 移除末行</button>
        </div>
        <h3>添加现有字段</h3>
        <div className="fleet-list-options">{BUILTIN_FLEET_FIELDS.map(option => {
          const added = draftFields.some(field => field.kind === 'builtin' && field.key === option.key);
          return <button type="button" key={option.key} onClick={() => addBuiltin(option.key)}
            disabled={added || draftFields.length >= MAX_FLEET_LIST_FIELDS}>{added ? '✓' : '＋'} {option.label}</button>;
        })}</div>
        <h3>添加自定义数值属性</h3>
        <div className="fleet-list-custom-fields">
          <label>属性路径<input value={customPath} onChange={event => setCustomPath(event.target.value)}
            placeholder="/jsbsim/velocities/vc-kts" /></label>
          <label>显示名称<input value={customLabel} onChange={event => setCustomLabel(event.target.value)} placeholder="表显速度" /></label>
          <label>单位<input value={customUnit} onChange={event => setCustomUnit(event.target.value)} placeholder="kt" /></label>
          <label>小数位<select value={customDigits} onChange={event => setCustomDigits(Number(event.target.value))}>
            {[0, 1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <button type="button" onClick={addCustom}>添加</button>
        </div>
        <p className="fleet-list-hint">可从实例详情的“属性变量”复制路径。设置用于全部 8 个实例；无新鲜数据时显示 —。</p>
        {error && <p className="fleet-list-error" role="alert">{error}</p>}
      </div>
      <div className="fleet-list-dialog-foot">
        <button type="button" onClick={() => { setDraftFields([...DEFAULT_FLEET_LIST_FIELDS]); setError(''); }}>恢复默认</button>
        <div><button type="button" onClick={closeEditor}>取消</button><button type="button" className="primary" onClick={saveEditor}>保存设置</button></div>
      </div>
    </dialog>
  </>;
}
