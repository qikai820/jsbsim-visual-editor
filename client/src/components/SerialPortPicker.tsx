import type { LocalSerialPort } from '../utils/tauriApi';
import EditableComboBox from './EditableComboBox';
import SerialAssistantIcon from './SerialAssistantIcon';

export default function SerialPortPicker({ ports, value, disabled, onChange, onRefresh, refreshing }: {
  ports: LocalSerialPort[];
  value: string;
  disabled: boolean;
  onChange: (path: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return <EditableComboBox className="serial-assistant-port" label={`本机串口（${ports.length}）`} ariaLabel="本机串口或设备路径"
    options={ports.map(port => ({ value: port.path, label: port.label }))} value={value} disabled={disabled} onChange={onChange}
    placeholder="选择串口或输入设备路径" labelAction={<button className="serial-assistant-refresh" type="button" aria-label="刷新串口" title="刷新串口" disabled={refreshing || disabled} onClick={onRefresh}><SerialAssistantIcon name="refresh" /></button>} />;
}
