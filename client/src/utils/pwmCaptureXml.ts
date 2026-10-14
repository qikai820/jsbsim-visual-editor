import type { AircraftNodeData } from '../types';
import { getPwmCaptureChannels } from './pwmCaptureConfig';

const numericKeys = ['min_us', 'max_us', 'output_min', 'output_max', 'failsafe', 'timeout_ms'] as const;

function parseDocument(source: string): Document {
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('PWM 捕获 XML 格式错误');
  return xml;
}

function validateInput(input: Element): void {
  const device = input.getAttribute('device') || '';
  const property = input.getAttribute('property') || '';
  if (input.tagName !== 'input' || input.children.length) throw new Error('PWM 捕获只允许空 input 元素');
  if (!/^\/dev\/capture[0-9]$/.test(device)) throw new Error(`捕获设备无效：${device}`);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\[[0-9]+\])?(?:\/[A-Za-z_][A-Za-z0-9_-]*(?:\[[0-9]+\])?)*$/.test(property)) {
    throw new Error(`模型属性无效：${property}`);
  }
  const values = Object.fromEntries(numericKeys.map(key => [key, Number(input.getAttribute(key))]));
  if (numericKeys.some(key => !input.getAttribute(key)?.trim() || !Number.isFinite(values[key]))) {
    throw new Error(`${device}：脉宽、输出值和超时须为有限数字`);
  }
  if (!Number.isInteger(values.min_us) || !Number.isInteger(values.max_us) ||
      values.min_us < 1 || values.max_us <= values.min_us || values.max_us > 1000000) {
    throw new Error(`${device}：脉宽范围无效`);
  }
  if (!Number.isInteger(values.timeout_ms) || values.timeout_ms < 1 || values.timeout_ms > 60000) {
    throw new Error(`${device}：信号丢失超时须为 1～60000 ms`);
  }
}

function validateRoot(root: Element): void {
  if (root.tagName !== 'pwm_inputs') throw new Error('PWM 捕获 XML 根节点须为 pwm_inputs');
  const devices = new Set<string>();
  const properties = new Set<string>();
  for (const input of Array.from(root.children)) {
    validateInput(input);
    const device = input.getAttribute('device')!;
    const property = input.getAttribute('property')!;
    if (devices.has(device)) throw new Error(`${device} 被多个 PWM 捕获模块占用`);
    if (properties.has(property)) throw new Error(`多个 PWM 捕获模块写入 ${property}`);
    devices.add(device);
    properties.add(property);
  }
}

export function serializePwmCaptures(nodes: Array<{ data: AircraftNodeData }>): string | null {
  const captures = nodes.filter(node => node.data.componentType === 'pwm_capture');
  if (!captures.length) return null;
  const doc = document.implementation.createDocument('', 'pwm_inputs');
  doc.documentElement.setAttribute('version', '1');
  for (const capture of captures) {
    const params = capture.data.params || {};
    const channels = getPwmCaptureChannels(params);
    if (!channels.length) throw new Error(`${params.name || 'PWM 捕获'}：请至少添加一路捕获通道`);
    for (const channel of channels) {
      const input = doc.createElement('input');
      for (const key of ['name', 'device', 'property', ...numericKeys] as const) {
        input.setAttribute(key, String(channel[key] ?? ''));
      }
      doc.documentElement.appendChild(input);
    }
  }
  validateRoot(doc.documentElement);
  return `<?xml version="1.0"?>\n${new XMLSerializer().serializeToString(doc.documentElement)}\n`;
}

export function parsePwmCaptures(source: string): AircraftNodeData[] {
  const root = parseDocument(source).documentElement;
  validateRoot(root);
  const channels = Array.from(root.children).map(input => {
    const channel: Record<string, any> = {};
    for (const attribute of Array.from(input.attributes)) channel[attribute.name] = attribute.value;
    for (const key of numericKeys) channel[key] = Number(channel[key]);
    return channel;
  });
  if (!channels.length) return [];
  return [{
    label: 'PWM 捕获 Hardware Input',
    componentType: 'pwm_capture' as const,
    params: { name: 'PWM Capture', channels },
  }];
}
