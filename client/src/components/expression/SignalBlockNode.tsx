import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { functionTopSymbol, functionPreview } from '../../utils/signalGraph';

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

  // Function blocks surface their inner arithmetic as a "handwritten" formula
  // preview, computed live from the expression so edits refresh instantly.
  const exprIcon = isFunction && d.expression ? functionTopSymbol(d.expression) : undefined;
  const exprPreview = isFunction && d.expression ? functionPreview(d.expression) : undefined;

  // No module shows input signal names (per user request); ports remain so
  // wiring still works. Blocks with no inputs get no dummy port.
  const inputList = isFunction
    ? (d.inputs || [])
    : (d.inputs && d.inputs.length > 0 ? d.inputs : []);

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
        <div className="sig-block-expr" title={exprPreview || ''}>
          <span className="sig-expr-op" style={{ color }}>{exprIcon || 'ƒ'}</span>
          {exprPreview ? (
            <span className="sig-expr-preview">{exprPreview}</span>
          ) : (
            <span className="sig-expr-preview sig-expr-empty">（空函数）</span>
          )}
        </div>
      )}

      {!isFunction && (
        <div className="sig-block-name" title={d.name || d.outputSignal}>
          {shortName(d.name || d.outputSignal)}
          {d.name && d.name.includes('/') && (
            <span className="sig-block-full">{d.name}</span>
          )}
        </div>
      )}

      {!isFunction && (() => {
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
