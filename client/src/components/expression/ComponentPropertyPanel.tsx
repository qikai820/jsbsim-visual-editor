import { useState } from 'react';

interface ComponentPropertyPanelProps {
  data: any;
  onChange: (patch: any) => void;
  onDelete: () => void;
  onEditExpression?: () => void;
}

// Fields that are represented elsewhere (ports / name) and should not be shown
// as generic scalar params.
const EXCLUDED = new Set(['input', 'output', 'properties', 'clipto']);

// Friendly labels for common component params.
const PARAM_LABELS: Record<string, string> = {
  gain: '增益 gain',
  lag: '滞后 lag',
  bias: '偏置 bias',
  clipto_min: '限幅下限 clipto_min',
  clipto_max: '限幅上限 clipto_max',
  deadband: '死区 deadband',
  trigger: '触发 trigger',
  width: '宽度 width',
  center: '中心 center',
  c1: '系数 c1', c2: '系数 c2', c3: '系数 c3',
  c4: '系数 c4', c5: '系数 c5', c6: '系数 c6',
  kp: '比例 Kp', ki: '积分 Ki', kd: '微分 Kd',
  delay: '延迟 delay',
  noise: '噪声 noise',
  drift_rate: '漂移率 drift_rate',
  constant: '常数 constant',
};

function shortName(s: string): string {
  if (!s) return '—';
  return s.split('/').pop() || s;
}

export default function ComponentPropertyPanel({ data, onChange, onDelete, onEditExpression }: ComponentPropertyPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const meta = data.meta || { label: data.itemType, icon: '•', color: '#64748b' };

  const setParam = (field: string, value: string) => {
    const cur = data.compProps?.[field] || {};
    onChange({
      compProps: {
        ...(data.compProps || {}),
        [field]: { value, attrs: cur.attrs || {} },
      },
    });
  };

  const setInput = (idx: number, value: string) => {
    const inputs = [...(data.inputs || [])];
    inputs[idx] = value;
    onChange({ inputs });
  };

  const setOutput = (value: string) => {
    onChange({ name: value, outputSignal: value });
  };

  const setClip = (which: 'cliptoMin' | 'cliptoMax', value: string) => {
    onChange({ [which]: value === '' ? undefined : value });
  };

  const paramFields = Object.entries(data.compProps || {}).filter(
    ([k, v]) => !EXCLUDED.has(k) && v && typeof v === 'object' && 'value' in v
  );

  return (
    <div className="comp-prop-panel">
      <div className="comp-prop-header">
        <span className="comp-prop-badge" style={{ background: meta.color }}>
          {meta.icon} {meta.label}
        </span>
        {onDelete && (
          <button className="delete-btn" onClick={onDelete} title="删除组件">🗑️ 删除</button>
        )}
      </div>

      <div className="field-row">
        <label>输出信号 name</label>
        <input
          type="text"
          value={data.name || ''}
          onChange={e => setOutput(e.target.value)}
          placeholder="组件名 = 输出属性"
        />
      </div>

      <div className="prop-divider" />
      <div className="comp-prop-subtitle">
        输入信号（端口）
        <span className="expr-props-hint">改名即改变该端口接收的信号（重连）</span>
      </div>
      {(data.inputs && data.inputs.length > 0 ? data.inputs : ['']).map((s: string, i: number) => (
        <div className="field-row" key={i}>
          <label>输入 {i + 1}</label>
          <input
            type="text"
            value={s || ''}
            onChange={e => setInput(i, e.target.value)}
            placeholder="信号名，如 fcs/cmd"
          />
        </div>
      ))}

      {(data.itemType === 'function' || data.itemType === 'fcs_function') && (
        <>
          <div className="prop-divider" />
          <div className="comp-prop-subtitle">输出限幅 clipto</div>
          <div className="field-row">
            <label>下限 min</label>
            <input
              type="text"
              value={data.cliptoMin ?? ''}
              onChange={e => setClip('cliptoMin', e.target.value)}
              placeholder="如 0.0"
            />
          </div>
          <div className="field-row">
            <label>上限 max</label>
            <input
              type="text"
              value={data.cliptoMax ?? ''}
              onChange={e => setClip('cliptoMax', e.target.value)}
              placeholder="如 0.9999"
            />
          </div>
        </>
      )}

      {onEditExpression && (
        <>
          <div className="prop-divider" />
          <button className="ae-open-expr-btn" style={{ width: '100%' }} onClick={onEditExpression}>
            📐 编辑函数表达式
          </button>
        </>
      )}

      {paramFields.length > 0 && (
        <>
          <div className="prop-divider" />
          <div className="comp-prop-subtitle" style={{ cursor: 'pointer' }} onClick={() => setCollapsed(!collapsed)}>
            参数 {collapsed ? '▶' : '▼'}
          </div>
          {!collapsed && paramFields.map(([field, v]: [string, any]) => (
            <div className="field-row" key={field}>
              <label>{PARAM_LABELS[field] || field}</label>
              <input
                type="text"
                value={String(v.value ?? '')}
                onChange={e => setParam(field, e.target.value)}
              />
            </div>
          ))}
        </>
      )}

      <div className="expr-props-empty" style={{ marginTop: 12 }}>
        <p className="expr-props-hint">
          输出：<code>{shortName(data.name || data.outputSignal)}</code><br />
          类型：{data.itemType}
        </p>
      </div>
    </div>
  );
}
