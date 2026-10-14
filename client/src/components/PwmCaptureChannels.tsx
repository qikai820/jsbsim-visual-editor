import type { AircraftNodeData } from '../types';
import SignalPathInput from './SignalPathInput';
import {
  defaultPwmCaptureChannel, getPwmCaptureChannels, PWM_CAPTURE_DEVICES,
  type PwmCaptureChannel,
} from '../utils/pwmCaptureConfig';
import './pwmCaptureChannels.css';

interface Props {
  nodeId: string;
  params: Record<string, any>;
  nodes: Array<{ id: string; data: AircraftNodeData }>;
  onChange: (channels: PwmCaptureChannel[]) => void;
}

const numberFields: Array<{ key: keyof PwmCaptureChannel; label: string }> = [
  { key: 'min_us', label: '最小脉宽 μs' },
  { key: 'max_us', label: '最大脉宽 μs' },
  { key: 'output_min', label: '最小输出值' },
  { key: 'output_max', label: '最大输出值' },
  { key: 'failsafe', label: '丢信号安全值' },
  { key: 'timeout_ms', label: '丢信号超时 ms' },
];

export default function PwmCaptureChannels({ nodeId, params, nodes, onChange }: Props) {
  let channels: PwmCaptureChannel[];
  try {
    channels = getPwmCaptureChannels(params);
  } catch (error) {
    return <p className="pwm-capture-error">{error instanceof Error ? error.message : String(error)}</p>;
  }

  const others = nodes.filter(node => node.id !== nodeId && node.data.componentType === 'pwm_capture')
    .flatMap(node => getPwmCaptureChannels(node.data.params));
  const used = new Set([...channels, ...others].map(channel => channel.device));
  const nextDevice = PWM_CAPTURE_DEVICES.find(device => !used.has(device));
  const update = (index: number, patch: Partial<PwmCaptureChannel>) => {
    onChange(channels.map((channel, offset) => offset === index ? { ...channel, ...patch } : channel));
  };

  return <div className="pwm-capture-editor">
    <div className="pwm-capture-heading">
      <strong>捕获通道（{channels.length}/10）</strong>
      <button type="button" disabled={!nextDevice} onClick={() => {
        if (nextDevice) onChange([...channels, defaultPwmCaptureChannel(nextDevice, channels.length)]);
      }}>＋ 添加通道</button>
    </div>
    <p className="pwm-capture-hint">每一路独立读取脉宽并写入一个 JSBSim 模型输入属性。设备须唯一；改动保存到仿真机后重启模型生效。</p>
    {channels.map((channel, index) => {
      const unavailable = new Set([...others, ...channels.filter((_, offset) => offset !== index)].map(item => item.device));
      return <section className="pwm-capture-card" key={index}>
        <div className="pwm-capture-card-header">
          <strong>通道 {index + 1}</strong>
          <button type="button" disabled={channels.length <= 1} onClick={() => onChange(channels.filter((_, offset) => offset !== index))}>删除</button>
        </div>
        <div className="field-row"><label>通道名称</label>
          <input type="text" value={channel.name} onChange={event => update(index, { name: event.target.value })} />
        </div>
        <div className="field-row"><label>捕获设备</label>
          <select value={channel.device} onChange={event => update(index, { device: event.target.value })}>
            {PWM_CAPTURE_DEVICES.map((device, offset) => <option key={device} value={device} disabled={unavailable.has(device)}>{device} · J23-{21 + offset}</option>)}
          </select>
        </div>
        <div className="field-row"><label>模型输入属性</label>
          <SignalPathInput value={channel.property} onChange={value => update(index, { property: value })}
            placeholder="例如 fcs/aileron-cmd-norm" />
        </div>
        <div className="pwm-capture-numbers">
          {numberFields.map(field => <div className="field-row" key={field.key}>
            <label>{field.label}</label>
            <input type="number" step={field.key === 'output_min' || field.key === 'output_max' || field.key === 'failsafe' ? 'any' : '1'}
              value={channel[field.key]} onChange={event => update(index, { [field.key]: event.target.value })} />
          </div>)}
        </div>
      </section>;
    })}
  </div>;
}
