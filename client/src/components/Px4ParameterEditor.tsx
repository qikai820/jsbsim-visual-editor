import { useEffect, useState } from 'react';
import type { ParameterMeta } from '../px4/metadata';
import type { Parameter } from '../px4/services';
import { normalizeParameterValue } from '../px4/protocol';

function draftText(parameter: Parameter) {
  if (parameter.type === 9) for (let digits = 1; digits <= 9; digits++) {
    const text = String(Number(parameter.value.toPrecision(digits)));
    if (Math.fround(Number(text)) === parameter.value) return text;
  }
  return String(parameter.value);
}

export default function Px4ParameterEditor({ parameter, meta, matched, connected, bidirectional, busy, bytewise, onWrite }: {
  parameter: Parameter; meta?: ParameterMeta; matched: boolean; connected: boolean;
  bidirectional: boolean; busy: boolean; bytewise: boolean; onWrite: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => draftText(parameter));
  useEffect(() => setDraft(draftText(parameter)), [parameter.name, parameter.value, parameter.type]);
  const readOnly = matched && meta?.readOnly;
  let value = NaN, error = '';
  try {
    if (!draft.trim()) throw Error('请输入新值');
    value = normalizeParameterValue(Number(draft), parameter.type, bytewise);
    const comparable = (number: number) => parameter.type === 9 ? Math.fround(number) : number;
    const definedValue = (meta?.default !== undefined && comparable(meta.default) === value) || meta?.values.some(option => comparable(option.value) === value);
    if (matched && !definedValue && ((meta?.min !== undefined && value < comparable(meta.min)) || (meta?.max !== undefined && value > comparable(meta.max)))) {
      throw Error(`超出固件允许范围 ${meta?.min ?? '未指定'} ～ ${meta?.max ?? '未指定'}`);
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const changed = value !== parameter.value, disabled = !connected || !bidirectional || busy || !!readOnly;
  return <form className="px4-parameter-editor" onSubmit={event => { event.preventDefault(); if (!disabled && changed && !error) onWrite(value); }}>
    <label>新值<input aria-label="参数新值" inputMode={parameter.type === 9 ? 'decimal' : 'numeric'} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} aria-invalid={!!error}/></label>
    {!!meta?.values.length && <select aria-label="参数枚举值" value={meta.values.some(option => String(option.value) === draft) ? draft : ''} disabled={disabled} onChange={event => { if (event.target.value) setDraft(event.target.value); }}>
      <option value="">按数值输入</option>{meta.values.map(option => <option key={option.value} value={option.value}>{option.value} · {option.description}</option>)}
    </select>}
    {error && <small className="px4-error-text" role="alert">{error}</small>}
    <div className="px4-parameter-edit-actions"><button type="button" disabled={disabled || meta?.default === undefined} onClick={() => setDraft(String(meta?.default))}>使用默认值</button><button className="px4-primary" type="submit" disabled={disabled || !changed || !!error}>{busy ? '等待飞控确认…' : '写入飞控'}</button></div>
    <small className="px4-muted">{readOnly ? '固件标记为只读' : !connected ? '等待飞控连接' : !bidirectional ? '当前通道不支持写入' : meta?.rebootRequired ? '此参数写入后需重启飞控才生效' : '写入后自动回读，确认飞控实际值'}</small>
  </form>;
}
