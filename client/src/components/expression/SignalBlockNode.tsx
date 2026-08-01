import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { functionTopSymbol } from '../../utils/signalGraph';

interface SignalBlockData {
  itemType: string;
  name: string;
  outputSignal: string;
  inputs: string[];
  expression?: any;
  meta: { label: string; icon: string; color: string };
  [key: string]: any;
}

function shortName(s: string): string {
  if (!s) return '—';
  return s.split('/').pop() || s;
}

// Compact one-line summary of a component's key scalar param(s), shown on the
// block so values like PID gains are visible without opening the property
// panel. Returns '' when there is nothing worth showing (keeps blocks small).
function paramSummary(itemType: string, compProps: any): string {
  if (!compProps || typeof compProps !== 'object') return '';
  // Read a gain value from any of the shapes it may take:
  //   { value, attrs }  |  { '#text' }  |  a plain string/number
  const get = (k: string): string | undefined => {
    const v = compProps[k];
    if (v == null) return undefined;
    let val: any;
    if (typeof v === 'object') {
      val = v.value !== undefined ? v.value : (v['#text'] !== undefined ? v['#text'] : undefined);
    } else {
      val = v;
    }
    if (val === undefined || val === '') return undefined;
    return String(val);
  };
  switch (itemType) {
    // JSBSim defaults: omitted Ki/Kd == 0. Missing Kp is invalid but we still
    // show a concrete default instead of a confusing "?" glyph.
    case 'pid':
      return `Kp ${get('kp') ?? '1'}  Ki ${get('ki') ?? '0'}  Kd ${get('kd') ?? '0'}`;
    case 'pure_gain':
    case 'scheduled_gain':
      return `G ${get('gain') ?? '1'}`;
    case 'bias':
      return `b ${get('bias') ?? '0'}`;
    case 'constant':
      return `c ${get('constant') ?? '0'}`;
    case 'lag_filter':
    case 'lead_lag_filter':
    case 'washout_filter':
      return `τ ${get('lag') ?? '0'}`;
    case 'deadband':
      return `±${get('deadband') ?? '0'}`;
    default:
      return '';
  }
}

function SignalBlockNode({ data, selected }: NodeProps) {
  const d = data as SignalBlockData;
  const meta = d.meta || { label: d.itemType, icon: '•', color: '#64748b' };
  const color = meta.color;
  const isFunction = d.itemType === 'function' || d.itemType === 'fcs_function';

  // Simulink-style: show only the top-level operator symbol (no formula string).
  const exprIcon = isFunction && d.expression ? functionTopSymbol(d.expression) : undefined;

  // No module shows input signal names (per user request); ports remain so
  // wiring still works. Blocks with no inputs get no dummy port.
  const inputList = isFunction
    ? (d.inputs || [])
    : (d.inputs && d.inputs.length > 0 ? d.inputs : []);

  // ── Simulink shapes ──
  const isGain = d.itemType === 'pure_gain' || d.itemType === 'scheduled_gain';
  const MATH_SYMBOL: Record<string, string> = {
    product: '×', difference: '−', quotient: '÷', pow: '^', atan2: 'atan2',
  };
  const mathSym = MATH_SYMBOL[d.itemType];
  const isSummer = d.itemType === 'summer';

  // Gain → Simulink triangle.
  if (isGain) {
    const gvRaw = d.compProps?.gain;
    let gv: any = gvRaw;
    if (gvRaw && typeof gvRaw === 'object') gv = gvRaw.value !== undefined ? gvRaw.value : gvRaw['#text'];
    const gainVal = gv !== undefined && gv !== '' ? String(gv) : '1';
    return (
      <div className={`sig-shape-gain ${selected ? 'selected' : ''}`} style={{ '--block-color': color } as React.CSSProperties}>
        <div className="sig-gain-tri" style={{ background: color }} title={d.name || d.outputSignal}>
          <span className="sig-gain-val">{gainVal}</span>
        </div>
        <div className="sig-shape-gain-name">{shortName(d.name || d.outputSignal)}</div>
        {inputList.map((s, i) => (
          <Handle key={i} type="target" position={Position.Left} id={`in-${i}`} className="sig-input-handle sig-gain-in" style={{ background: color }} />
        ))}
        <Handle type="source" position={Position.Right} id="out" className="sig-output-handle sig-gain-out" style={{ background: color }} />
      </div>
    );
  }

  return (
    <div
      className={`sig-block ${isFunction ? 'sig-block-fn' : ''} ${selected ? 'selected' : ''}`}
      style={{ '--block-color': color } as React.CSSProperties}
    >
      <div className="sig-block-header" style={{ background: color }}>
        <span className="sig-block-icon">{meta.icon}</span>
        <span className="sig-block-type">{meta.label}</span>
        {isFunction && <span className="sig-block-tag">f()</span>}
      </div>

      {isFunction && (
        <>
          <span className="sig-expand-btn" data-expand-toggle="1" title="展开为运算子图">⤢</span>
          <div className="sig-block-fn-body">
            <span className="sig-block-fn-symbol">{exprIcon || 'ƒ'}</span>
          </div>
          {(d.cliptoMin !== undefined || d.cliptoMax !== undefined) && (
            <div
              className="sig-block-clip"
              title={`输出限幅 clipto [${d.cliptoMin ?? '-∞'}, ${d.cliptoMax ?? '+∞'}]`}
            >
              ⌈{d.cliptoMin ?? '-∞'}, {d.cliptoMax ?? '+∞'}⌋
            </div>
          )}
          <div className="sig-block-name" title={d.name || d.outputSignal}>
            {shortName(d.name || d.outputSignal)}
          </div>
        </>
      )}

      {!isFunction && (mathSym || isSummer) && (
        <>
          <div className="sig-block-fn-body">
            <span className="sig-block-fn-symbol">{isSummer ? 'Σ' : mathSym}</span>
          </div>
          <div className="sig-block-name" title={d.name || d.outputSignal}>
            {shortName(d.name || d.outputSignal)}
          </div>
        </>
      )}

      {!isFunction && !mathSym && !isSummer && (
        <div className="sig-block-name" title={d.name || d.outputSignal}>
          {shortName(d.name || d.outputSignal)}
          {d.name && d.name.includes('/') && (
            <span className="sig-block-full">{d.name}</span>
          )}
        </div>
      )}

      {!isFunction && !mathSym && !isSummer && (() => {
        const ps = paramSummary(d.itemType, d.compProps);
        return ps ? <div className="sig-block-params" title={ps}>{ps}</div> : null;
      })()}

      <div className="sig-block-inputs sig-block-inputs-bare">
        {inputList.map((s: string, i: number) => (
          <div className="sig-input-row" key={i}>
            <Handle
              type="target"
              position={Position.Left}
              id={`in-${i}`}
              className="sig-input-handle"
              style={{ background: color }}
            />
            {isSummer && <span className="sig-sum-sign">+</span>}
          </div>
        ))}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="sig-output-handle"
        style={{ background: color }}
      />
    </div>
  );
}

export default memo(SignalBlockNode);
