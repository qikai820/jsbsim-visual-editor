import type { AircraftNodeData } from '../types';
import { getComponentDef } from './componentDefs';
import { SERIAL_SENSOR_DEVICES } from './serialDevices';

const TYPES = new Set(['U8', 'S8', 'U16', 'S16', 'U32', 'S32', 'F32', 'F64']);
const BAUDS = new Set(['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600']);
const CHECKSUMS = new Set(['NONE', 'SUM8', 'XOR8', 'CRC16_MODBUS']);
const XML_ERROR = 'parsererror';

function parseDocument(source: string): Document {
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  if (xml.getElementsByTagName(XML_ERROR).length) throw new Error('串口传感器 XML 格式错误');
  return xml;
}

function validateField(field: Element): void {
  if (field.tagName !== 'field' || field.children.length || !TYPES.has(field.getAttribute('type') || '') ||
      (!!field.getAttribute('property') === !!field.getAttribute('value'))) {
    throw new Error('field 需要 type，且 property 与 value 必须二选一');
  }
  for (const key of ['value', 'scale', 'offset']) {
    const value = field.getAttribute(key);
    if (value !== null && (value.trim() === '' || !Number.isFinite(Number(value)))) {
      throw new Error(`field 的 ${key} 必须是有限数字`);
    }
  }
}

function validateOutput(output: Element): void {
  const protocol = output.getAttribute('protocol') || 'CUSTOM';
  const device = output.getAttribute('device') || '';
  const baud = output.getAttribute('baud') || '';
  if (!['CUSTOM', 'VIZTRA_HYM1'].includes(protocol)) throw new Error(`不支持的串口协议：${protocol}`);
  if (!SERIAL_SENSOR_DEVICES.includes(device as typeof SERIAL_SENSOR_DEVICES[number])) throw new Error(`串口设备无效：${device}`);
  if (!BAUDS.has(baud)) throw new Error(`波特率无效：${baud}`);
  if (!output.getAttribute('logic_name')) throw new Error('串口传感器需要连接系统逻辑画布');
  if (protocol === 'VIZTRA_HYM1') return;
  const rate = Number(output.getAttribute('rate'));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 250) throw new Error('输出频率须为 0～250 Hz');
  if (!['7', '8'].includes(output.getAttribute('data_bits') || '8') ||
      !['NONE', 'EVEN', 'ODD'].includes(output.getAttribute('parity') || 'NONE') ||
      !['1', '2'].includes(output.getAttribute('stop_bits') || '1')) throw new Error('串口格式无效');
  if (!['LITTLE', 'BIG'].includes(output.getAttribute('byte_order') || 'LITTLE') ||
      !CHECKSUMS.has(output.getAttribute('checksum') || 'NONE')) throw new Error('字节顺序或校验类型无效');
  for (const key of ['prefix', 'suffix']) {
    const value = (output.getAttribute(key) || '').replace(/[\s,:-]/g, '');
    if (value.length % 2 || /[^0-9a-f]/i.test(value)) throw new Error(`${key} 须为成对十六进制字节`);
  }
  const start = Number(output.getAttribute('checksum_start') || '0');
  if (!Number.isInteger(start) || start < 0) throw new Error('校验起始字节下标无效');
  const fields = Array.from(output.children);
  if (!fields.length) throw new Error('自定义串口传感器至少需要一个 field');
  fields.forEach(validateField);
}

function logicOutputs(node: { data: AircraftNodeData }): string[] {
  let channels: any[] = [];
  try { channels = JSON.parse(String(node.data.params?.channels || '[]')); } catch { /* validation below */ }
  if (!Array.isArray(channels)) return [];
  const outputs = channels.flatMap(channel => (Array.isArray(channel.items) ? channel.items : [])
    .map((item: any) => String(item?.componentProps?.output?.value || item?.output || item?.name || '').trim())
    .filter(Boolean));
  try {
    const topLevel = JSON.parse(String(node.data.params?.topLevelItems || '[]'));
    if (Array.isArray(topLevel)) outputs.push(...topLevel.map(item => String(item?.name || '').trim()).filter(Boolean));
  } catch { /* channel outputs remain usable */ }
  return [...new Set(outputs)];
}

function defaultOutputs(node: { data: AircraftNodeData }, available: string[]): string[] {
  const identity = `${node.data.params?.file || ''} ${node.data.label || ''}`.toLowerCase();
  const presets = identity.includes('imu')
    ? ['sensor/imu/accelX_mps2', 'sensor/imu/accelY_mps2', 'sensor/imu/accelZ_mps2',
       'sensor/imu/gyroX_rps', 'sensor/imu/gyroY_rps', 'sensor/imu/gyroZ_rps',
       'sensor/imu/magX_nT', 'sensor/imu/magY_nT', 'sensor/imu/magZ_nT', 'sensor/imu/temp_C']
    : identity.includes('gps')
      ? ['sensor/gps/lat_rad', 'sensor/gps/long_rad', 'sensor/gps/alt_m',
         'sensor/gps/vNorth_mps', 'sensor/gps/vEast_mps', 'sensor/gps/vDown_mps']
      : identity.includes('baro')
        ? ['sensor/baro/presStatic_Pa', 'sensor/baro/temp_C']
        : available;
  return presets.filter(value => available.includes(value));
}

export function serializeSerialSensors(
  nodes: Array<{ id: string; data: AircraftNodeData }>,
  edges: Array<{ source: string; target: string }> = [],
): string | null {
  const sensors = nodes.filter(node => node.data.componentType === 'serial_sensor');
  if (!sensors.length) return null;
  const doc = document.implementation.createDocument('', 'serial_outputs');
  doc.documentElement.setAttribute('version', '1');
  const usedDevices = new Set<string>();
  for (const sensor of sensors) {
    const params = { ...(sensor.data.params || {}) };
    const protocol = String(params.protocol || 'CUSTOM');
    const device = String(params.device || '');
    const sensorLabel = `${params.name || '串口传感器'}（${protocol} ${device}）`;
    if (usedDevices.has(device)) throw new Error(`${device} 被多个串口传感器占用`);
    usedDevices.add(device);
    const connection = edges.find(edge => edge.target === sensor.id);
    const source = nodes.find(node => node.id === connection?.source);
    if (source?.data.componentType !== 'system') {
      throw new Error(`${sensorLabel}：请连接一个系统节点，并在其逻辑画布中生成传感器信号`);
    }
    const outputs = logicOutputs(source);
    if (!outputs.length) throw new Error(`${sensorLabel}：系统逻辑画布还没有输出信号`);
    params.logic_name = String(source.data.params?.file || source.data.params?.name || '')
      .replace(/\.xml$/i, '').split('/').pop();
    if (protocol === 'VIZTRA_HYM1') {
      const required = ['px4/viztra/visible', 'px4/viztra/pixel-x', 'px4/viztra/pixel-y',
        'px4/viztra/width-px', 'px4/viztra/height-px',
        'px4/viztra/angle-x-deg', 'px4/viztra/angle-y-deg'];
      const missing = required.filter(property => !outputs.includes(property));
      if (missing.length) throw new Error(`Viztra 逻辑画布缺少输出：${missing.join(', ')}`);
    }
    if (protocol === 'CUSTOM') {
      if (!String(params.fields_xml || '').trim()) {
        const selected = defaultOutputs(source, outputs);
        params.fields_xml = (selected.length ? selected : outputs).map((property, index) =>
          `<field name="signal_${index + 1}" property="${property.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" type="F32"/>`).join('\n');
      }
    }
    const output = doc.createElement('output');
    for (const key of ['name', 'protocol', 'device', 'baud', 'logic_name']) {
      if (params[key]) output.setAttribute(key, String(params[key]));
    }
    if (protocol === 'CUSTOM') {
      for (const key of ['data_bits', 'parity', 'stop_bits', 'rate', 'prefix', 'suffix',
                         'byte_order', 'checksum', 'checksum_start']) {
        output.setAttribute(key, String(params[key] ?? ''));
      }
      const fragment = parseDocument(`<fields>${String(params.fields_xml || '')}</fields>`);
      for (const field of Array.from(fragment.documentElement.children)) {
        validateField(field);
        const property = field.getAttribute('property');
        if (property && !logicOutputs(source!).includes(property)) {
          throw new Error(`${params.name || '串口传感器'}：字段 ${field.getAttribute('property') || ''} 不是相连逻辑画布的输出`);
        }
        output.appendChild(doc.importNode(field, true));
      }
    }
    validateOutput(output);
    doc.documentElement.appendChild(output);
  }
  return `<?xml version="1.0"?>\n${new XMLSerializer().serializeToString(doc.documentElement)}\n`;
}

export function parseSerialSensors(source: string): AircraftNodeData[] {
  const root = parseDocument(source).documentElement;
  if (root.tagName !== 'serial_outputs') throw new Error('串口传感器 XML 根节点须为 serial_outputs');
  const definition = getComponentDef('serial_sensor');
  const defaults = Object.fromEntries(Object.entries(definition!.params).map(([key, def]) => [key, def.default]));
  return Array.from(root.children).map(output => {
    if (output.tagName !== 'output') throw new Error('serial_outputs 只允许 output 子节点');
    validateOutput(output);
    const params: Record<string, any> = { ...defaults };
    for (const attribute of Array.from(output.attributes)) params[attribute.name] = attribute.value;
    params.rate = Number(params.rate);
    params.checksum_start = Number(params.checksum_start);
    params.fields_xml = Array.from(output.children).map(field => new XMLSerializer().serializeToString(field)).join('\n');
    return { label: params.name || '串口传感器', componentType: 'serial_sensor' as const, params };
  });
}
