import { useState } from 'react';
import { createPortal } from 'react-dom';

interface ScriptEvent {
  name: string;
  condition: string;
  sets: { name: string; value: string }[];
  notifies: string[];
}

export interface ScriptEditorValue {
  name: string;
  aircraft: string;
  initialize: string;
  start: string;
  end: string;
  dt: string;
  events: ScriptEvent[];
}

interface Props {
  value: ScriptEditorValue;
  variables: string[];
  onChange: (value: ScriptEditorValue) => void;
  onSave: (value: ScriptEditorValue) => Promise<void>;
  onClose: () => void;
}

function splitCondition(condition: string): [string, string, string] {
  const match = condition.match(/^\s*(.*?)\s*(<=|>=|!=|==|<|>|=|\ble\b|\bge\b|\blt\b|\bgt\b|\beq\b|\bnq\b)\s*(.*?)\s*$/i);
  return match ? [match[1], match[2], match[3]] : [condition, '==', ''];
}

export default function ScriptEditorDialog({ value, variables, onChange, onSave, onClose }: Props) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const updateEvent = (index: number, next: Partial<ScriptEvent>) => onChange({
    ...value,
    events: value.events.map((event, i) => i === index ? { ...event, ...next } : event),
  });
  const removeEvent = (index: number) => onChange({ ...value, events: value.events.filter((_, i) => i !== index) });
  const addEvent = () => onChange({ ...value, events: [...value.events, { name: `事件 ${value.events.length + 1}`, condition: '', sets: [], notifies: [] }] });

  return createPortal(<div className="script-editor-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="script-editor-modal script-editor-v2" onClick={event => event.stopPropagation()}>
      <header className="script-editor-head">
        <div><span className="script-editor-icon">📋</span><span>测试脚本逻辑</span><small>{value.name}</small></div>
        <div><button className="script-editor-save" disabled={saving} onClick={async () => {
          setSaving(true);
          setSaveError('');
          try {
            await onSave(value);
            onClose();
          } catch (error: any) {
            setSaveError(error?.message || String(error));
          } finally {
            setSaving(false);
          }
        }}>{saving ? '正在上传…' : '保存到仿真机'}</button><button onClick={onClose}>×</button></div>
      </header>
      {saveError && <div className="script-editor-save-error">保存失败：{saveError}</div>}
      <section className="script-editor-summary">
        <label>✈️ 模型：<input value={value.aircraft} onChange={event => onChange({ ...value, aircraft: event.target.value })} /></label>
        <label>⚙️ 初始化：<input value={value.initialize} placeholder="默认初始化" onChange={event => onChange({ ...value, initialize: event.target.value })} /></label>
        <label>⏱️ 起止：<input value={value.start} onChange={event => onChange({ ...value, start: event.target.value })} /> → <input value={value.end} placeholder="未设置" onChange={event => onChange({ ...value, end: event.target.value })} /> s</label>
        <label>Δt：<input value={value.dt} placeholder="未设置" onChange={event => onChange({ ...value, dt: event.target.value })} /> s</label>
      </section>
      <main className="script-flow-board">
        <div className="script-flow-start">▶ 开始仿真 <small>t = {value.start}s</small></div>
        {value.events.map((scriptEvent, eventIndex) => {
          const [left, operator, right] = splitCondition(scriptEvent.condition);
          const updateCondition = (a: string, op: string, b: string) => updateEvent(eventIndex, { condition: `${a} ${op} ${b}`.trim() });
          return <article className="script-flow-event script-flow-event-v2" key={`${eventIndex}-${scriptEvent.name}`}>
            <header className="script-flow-node-title"><span>{eventIndex + 1}</span><input value={scriptEvent.name} onChange={event => updateEvent(eventIndex, { name: event.target.value })} /><button className="script-event-delete" onClick={() => removeEvent(eventIndex)} title="删除这个事件">×</button></header>
            <div className="script-flow-condition">◇ 条件：<select aria-label="条件变量" title={left} value={left} onChange={event => updateCondition(event.target.value, operator, right)}><option value="">选择变量</option>{Array.from(new Set([left, ...variables].filter(Boolean))).map(variable => <option key={variable}>{variable}</option>)}</select><select aria-label="条件运算符" value={operator} onChange={event => updateCondition(left, event.target.value, right)}><option value="==">=</option><option value="!=">≠</option><option value=">">&gt;</option><option value="<">&lt;</option><option value=">=">≥</option><option value="<=">≤</option></select><input aria-label="条件比较值" title={right} value={right} onChange={event => updateCondition(left, operator, event.target.value)} /></div>
            <section className="script-action-group">
              {scriptEvent.sets.map((set, setIndex) => <div className="script-flow-detail" key={`set-${setIndex}`}>⚙ <select aria-label="设置变量" title={set.name} value={set.name} onChange={event => updateEvent(eventIndex, { sets: scriptEvent.sets.map((item, i) => i === setIndex ? { ...item, name: event.target.value } : item) })}><option value="">选择变量</option>{Array.from(new Set([set.name, ...variables].filter(Boolean))).map(variable => <option key={variable}>{variable}</option>)}</select><span>=</span><input title={set.value} value={set.value} onChange={event => updateEvent(eventIndex, { sets: scriptEvent.sets.map((item, i) => i === setIndex ? { ...item, value: event.target.value } : item) })}/><button className="script-row-delete" onClick={() => updateEvent(eventIndex, { sets: scriptEvent.sets.filter((_, i) => i !== setIndex) })}>−</button></div>)}
              <button className="script-row-insert" onClick={() => updateEvent(eventIndex, { sets: [...scriptEvent.sets, { name: '', value: '' }] })}><span>＋</span> 添加下一行变量</button>
            </section>
            {scriptEvent.notifies.map((notify, notifyIndex) => <div className="script-flow-detail" key={`notify-${notifyIndex}`}>📣 <input className="script-notify-input" title={notify} value={notify} onChange={event => updateEvent(eventIndex, { notifies: scriptEvent.notifies.map((item, i) => i === notifyIndex ? event.target.value : item) })}/><button className="script-row-delete" onClick={() => updateEvent(eventIndex, { notifies: scriptEvent.notifies.filter((_, i) => i !== notifyIndex) })}>−</button></div>)}
            <button className="script-row-insert notify" onClick={() => updateEvent(eventIndex, { notifies: [...scriptEvent.notifies, ''] })}><span>＋</span> 添加下一行通知</button>
          </article>;
        })}
        <button className="script-event-insert" onClick={addEvent}><span>＋</span><strong>添加事件</strong><small>插入到结束仿真之前</small></button>
        <div className="script-flow-end">■ 结束仿真 <small>t = {value.end}s</small></div>
      </main>
    </div>
  </div>, document.body);
}
