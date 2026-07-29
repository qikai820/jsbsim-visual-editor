import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AircraftNodeData } from '../../types';
import { getComponentDef } from '../../utils/componentDefs';

// Extract display value from param (handles both plain number and {value, unit} format)
function displayVal(p: any): string {
  if (p === null || p === undefined) return '0';
  if (typeof p === 'number') return String(p);
  if (typeof p === 'object' && 'value' in p) return String(p.value);
  return String(p);
}

function displayUnit(p: any, fallback?: string): string | undefined {
  if (p && typeof p === 'object' && 'unit' in p && p.unit) return p.unit;
  return fallback;
}

function AircraftNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as AircraftNodeData;
  const def = getComponentDef(nodeData.componentType);
  if (!def) return null;

  const paramEntries = Object.entries(def.params).slice(0, 4);

  return (
    <div className={`aircraft-node ${selected ? 'selected' : ''}`} style={{ borderColor: def.color }}>
      {/* Input handles */}
      {def.inputs.map((input, i) => (
        <Handle
          key={`in-${input.id}`}
          type="target"
          position={Position.Left}
          id={input.id}
          style={{ top: `${30 + i * 25}px`, background: def.color }}
          title={input.label}
        />
      ))}

      {/* Header */}
      <div className="node-header" style={{ background: def.color }}>
        <span className="node-icon">{def.icon}</span>
        <span className="node-label">{nodeData.label}</span>
      </div>

      {/* Body - parameter summary */}
      <div className="node-body">
        {paramEntries.map(([key, paramDef]) => {
          const raw = nodeData.params[key];
          const val = displayVal(raw ?? paramDef.default);
          const unit = displayUnit(raw, paramDef.unit);
          // Skip non-displayable params (long strings, JSON arrays)
          if (val.length > 20 || val.startsWith('[')) return null;
          return (
            <div key={key} className="node-param">
              <span className="param-label">{paramDef.label}:</span>
              <span className="param-value">
                {val}{unit ? ` ${unit}` : ''}
              </span>
            </div>
          );
        })}
      </div>

      {/* Output handles */}
      {def.outputs.map((output, i) => (
        <Handle
          key={`out-${output.id}`}
          type="source"
          position={Position.Right}
          id={output.id}
          style={{ top: `${30 + i * 25}px`, background: def.color }}
          title={output.label}
        />
      ))}
    </div>
  );
}

export default memo(AircraftNode);
