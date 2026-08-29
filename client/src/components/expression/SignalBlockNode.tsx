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
  const isTable = d.itemType === 'aero_table';
  const isFunction = d.itemType === 'function' || d.itemType === 'fcs_function' || isTable;

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
  const SIMULINK_SYMBOL: Record<string, string> = {
    integrator: '1/s',
    lag_filter: '1/(τs+1)',
    lead_lag_filter: '(a₁s+a₀)/(b₁s+b₀)',
    second_order_filter: 'H(s)',
    washout_filter: 's/(s+ω)',
    switch: '≷',
    actuator: 'A(s)',
    aerosurface_scale: 'Scale',
    angle: '∠',
    kinematic: 'K',
    deadband: 'Dead zone',
    sensor: 'Sensor',
    gyro: 'ω',
    accelerometer: 'a',
    magnetometer: 'B',
    bias: '+ b',
    constant: 'C',
  };
  const simulinkSymbol = SIMULINK_SYMBOL[d.itemType] || meta.icon || d.itemType;

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
          <Handle key={i} type="target" position={Position.Left} id={`in-${i}`}
            className="sig-input-handle sig-port-arrow sig-port-input sig-gain-in"
            style={{ top: `${((i + 1) / (inputList.length + 1)) * 100}%` }} />
        ))}
        <Handle type="source" position={Position.Right} id="out"
          className="sig-output-handle sig-port-arrow sig-port-output sig-gain-out" />
      </div>
    );
  }

  return (
    <div
      className={`sig-block ${isFunction ? 'sig-block-fn' : ''} ${isTable ? 'sig-block-table' : ''} ${selected ? 'selected' : ''} sig-block-compact`}
      style={{ '--block-color': color } as React.CSSProperties}
    >
      {/* Compact formula display for functions */}
      {isFunction && (
        <div className="sig-compact-formula" title={d.name || d.outputSignal}>
          <span className="sig-block-fn-symbol">{isTable ? 'LUT' : (exprIcon || 'ƒ')}</span>
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
        <div className="sig-compact-formula" title={paramSummary('pid', d.compProps) || 'PID 控制器'}>
          <span className="sig-block-fn-symbol">PID(s)</span>
        </div>
      )}

      {/* Other blocks: show operator symbol only (no name, no params) */}
      {!isFunction && !mathSym && !isSummer && !isPID && (
        <div className="sig-compact-formula" title={meta.label || d.itemType}>
          <span className="sig-block-fn-symbol">{simulinkSymbol}</span>
        </div>
      )}

      {/* Clip limits */}
      {isFunction && (d.cliptoMin !== undefined || d.cliptoMax !== undefined) && (
        <div className="sig-compact-clip" title={`输出限幅`}>
          [{d.cliptoMin ?? '-∞'}, {d.cliptoMax ?? '+∞'}]
        </div>
      )}

      {/* Ports sit directly on the block boundary. Inputs are distributed
          symmetrically around the vertical centre, independent of body text. */}
      {inputList.map((_s: string, i: number) => (
        <Handle key={`port-${i}`} type="target" position={Position.Left} id={`in-${i}`}
          className="sig-input-handle sig-port-arrow sig-port-input"
          style={{ top: `${((i + 1) / (inputList.length + 1)) * 100}%` }} />
      ))}

      <div className="sig-block-inputs sig-block-inputs-bare">
        {inputList.map((s: string, i: number) => (
          <div className="sig-input-row" key={i}>
            {isSummer && <span className="sig-sum-sign">+</span>}
          </div>
        ))}
      </div>

      <Handle type="source" position={Position.Right} id="out"
        className="sig-output-handle sig-port-arrow sig-port-output" />
    </div>
  );
}

export default memo(SignalBlockNode);
