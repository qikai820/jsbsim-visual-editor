import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AircraftNodeData } from '../../types';
import { getComponentDef } from '../../utils/componentDefs';
import AviationIcon from '../AviationIcon';
import { getPwmCaptureChannels } from '../../utils/pwmCaptureConfig';

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

  const isModule = nodeData.componentType === 'system' || nodeData.componentType === 'flight_control';
  const hasContent = isModule && nodeData.params?.channels && nodeData.params.channels !== '[]';
  const nodeInputs = nodeData.componentType === 'uavcan' ? def.inputs : nodeData.componentType === 'output'
    ? (nodeData.params?.type === 'HIL_GPS'
      ? [{ id: 'gps', label: 'GPS' }]
      : nodeData.params?.type === 'HIL_SENSOR'
        ? [{ id: 'imu', label: 'IMU' }, { id: 'mag', label: '磁罗盘' }, { id: 'barometer', label: '气压传感器' }]
        : (nodeData.params?.type === 'VIZTRA_UDP_JSON' || nodeData.params?.type === 'VIZTRA_UDP_QGC')
          ? [{ id: 'viztra', label: 'Viztra 系统' }]
        : [])
    : def.inputs;

  const hilInput = nodeData.componentType === 'input' && nodeData.params?.type === 'HIL_ACTUATOR_CONTROLS';
  const hilOutput = nodeData.componentType === 'output' && ['HIL_SENSOR', 'HIL_GPS'].includes(String(nodeData.params?.type));
  const paramEntries = hilInput || hilOutput
    ? ['name', 'type', 'transport',
        ...(hilOutput && nodeData.params?.transport !== 'SERIAL' ? ['host'] : []),
        nodeData.params?.transport === 'SERIAL' ? 'device' : 'port']
        .map(key => [key, def.params[key]] as const)
    : Object.entries(def.params).slice(0, 4);
  let pwmChannels = [] as ReturnType<typeof getPwmCaptureChannels>;
  if (nodeData.componentType === 'pwm_capture') {
    try { pwmChannels = getPwmCaptureChannels(nodeData.params); } catch { /* invalid data is shown in the editor */ }
  }

  return (
    <div
      className={`aircraft-node ${selected ? 'selected' : ''} ${isModule ? 'aircraft-node-module' : ''}`}
      style={{ borderColor: def.color }}
      title={isModule ? '双击进入模块信号流画布' : undefined}
    >
      {/* Input handles */}
      {nodeInputs.map((input, i) => (
        <Handle
          key={`in-${input.id}`}
          type="target"
          position={Position.Left}
          id={input.id}
          style={{ top: `${((i + 1) / (nodeInputs.length + 1)) * 100}%`, background: def.color }}
          title={input.label}
        />
      ))}

      {/* Header */}
      <div className="node-header" style={{ background: def.color }}>
        <span className="node-icon"><AviationIcon type={nodeData.componentType} size={14} /></span>
        <span className="node-label">{nodeData.componentType === 'input' || nodeData.componentType === 'output'
          ? `${nodeData.componentType === 'input' ? 'Input' : 'Output'}: ${String(nodeData.params?.name || '')}`
          : nodeData.label}</span>
        {isModule && (
          <span className={`node-drill-badge ${hasContent ? '' : 'node-drill-badge-empty'}`} title="双击进入">
            ⤢
          </span>
        )}
      </div>

      {/* Body - parameter summary */}
      <div className="node-body">
        {nodeData.componentType === 'pwm_capture' ? <>
          <div className="node-param"><span className="param-label">捕获通道:</span><span className="param-value">{pwmChannels.length}/10</span></div>
          <div className="node-param"><span className="param-label">设备:</span><span className="param-value">{pwmChannels.map(channel => channel.device.replace('/dev/', '')).join(', ')}</span></div>
        </> : paramEntries.map(([key, paramDef]) => {
          const raw = nodeData.params[key];
          const val = key === 'transport'
            ? (raw === 'SERIAL' ? '串口' : '网口 UDP')
            : key === 'host' && !String(raw || '').trim() ? '板端默认'
            : displayVal(raw ?? paramDef.default);
          const unit = displayUnit(raw, paramDef.unit);
          // Skip non-displayable params (long strings, JSON arrays)
          if (val.length > 20 || val.startsWith('[')) return null;
          return (
            <div key={key} className="node-param">
              <span className="param-label">{key === 'name' && hilInput && nodeData.params?.transport !== 'SERIAL' ? '监听 IP' : paramDef.label}:</span>
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
          style={{ top: `${((i + 1) / (def.outputs.length + 1)) * 100}%`, background: def.color }}
          title={output.label}
        />
      ))}
    </div>
  );
}

export default memo(AircraftNode);
