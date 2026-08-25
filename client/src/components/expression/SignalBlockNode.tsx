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
  hasMultipleOutputs?: boolean;  // True when this block's output fans out to multiple targets
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
    // PID: only show non-zero parameters
    case 'pid': {
      const kp = get('kp');
      const ki = get('ki');
      const kd = get('kd');
      const parts: string[] = [];
      // Check for non-zero: compare as numbers to handle both string and numeric values
      if (kp && Number(kp) !== 0) parts.push(`P${kp}`);
      if (ki && Number(ki) !== 0) parts.push(`I${ki}`);
      if (kd && Number(kd) !== 0) parts.push(`D${kd}`);
      return parts.length > 0 ? parts.join(' ') : 'PID';
    }
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
  const isPID = d.itemType === 'pid';

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
        {inputList.map((s, i) => (
          <Handle key={i} type="target" position={Position.Left} id={`in-${i}`} className="sig-input-handle sig-gain-in" style={{ background: color }} />
        ))}
        <div style={{ position: 'absolute', right: -4, top: '50%', transform: 'translateY(-50%)' }}>
          <Handle type="source" position={Position.Right} id="out" className="sig-output-handle sig-gain-out" style={{ background: color }} />
          {d.hasMultipleOutputs && (
            <div style={{
              position: 'absolute',
              right: -3,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#000',
              border: '1.5px solid #fff',
              pointerEvents: 'none',
              zIndex: 10,
            }} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sig-block ${isFunction ? 'sig-block-fn' : ''} ${selected ? 'selected' : ''} sig-block-compact`}
      style={{ '--block-color': color } as React.CSSProperties}
    >
      {/* Compact formula display for functions */}
      {isFunction && (
        <div className="sig-compact-formula" title={d.name || d.outputSignal}>
          <span className="sig-block-fn-symbol">{exprIcon || 'ƒ'}</span>
        </div>
      )}

      {/* Math operators */}
      {!isFunction && (mathSym || isSummer) && (
        <div className="sig-compact-formula">
          <span className="sig-block-fn-symbol">{isSummer ? 'Σ' : mathSym}</span>
        </div>
      )}

      {/* PID block: show PID label with non-zero params */}
      {isPID && (
        <div className="sig-compact-formula" title="PID 控制器">
          <span className="sig-block-fn-symbol">{paramSummary('pid', d.compProps) || 'PID'}</span>
        </div>
      )}

      {/* Other blocks: show operator symbol only (no name, no params) */}
      {!isFunction && !mathSym && !isSummer && !isPID && (
        <div className="sig-compact-formula">
          <span className="sig-block-fn-symbol">•</span>
        </div>
      )}

      {/* Clip limits */}
      {isFunction && (d.cliptoMin !== undefined || d.cliptoMax !== undefined) && (
        <div className="sig-compact-clip" title={`输出限幅`}>
          [{d.cliptoMin ?? '-∞'}, {d.cliptoMax ?? '+∞'}]
        </div>
      )}

      {/* Input handles */}
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

      {/* Output handle with optional fan-out dot indicator */}
      <div style={{ position: 'absolute', right: -4, top: '50%', transform: 'translateY(-50%)' }}>
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className="sig-output-handle"
          style={{ background: color }}
        />
        {d.hasMultipleOutputs && (
          <div style={{
            position: 'absolute',
            right: -3,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#000',
            border: '1.5px solid #fff',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}
      </div>
    </div>
  );
}

export default memo(SignalBlockNode);
