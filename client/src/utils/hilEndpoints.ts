import { validateXmlSource } from './xmlDiagnostics';

export type HilEndpointKey = 'input' | 'sensor' | 'gps';
export type HilEndpoint = { ip: string; port: string };
export type HilEndpoints = Record<HilEndpointKey, HilEndpoint | null>;

type IoTag = { kind: 'input' | 'output'; type: string; name: string; transport: string; tag: string; start: number; end: number };
type IoNode = { id: string; data: { componentType: string; params?: Record<string, unknown> } };
const KEYS: HilEndpointKey[] = ['input', 'sensor', 'gps'];

function attribute(tag: string, key: string): string {
  return tag.match(new RegExp(`\\s${key}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || '';
}

function setAttribute(tag: string, key: string, value: string): string {
  const quoted = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const expression = new RegExp(`(\\s${key}\\s*=\\s*)(["']).*?\\2`, 'i');
  return expression.test(tag)
    ? tag.replace(expression, (_match, prefix) => `${prefix}"${quoted}"`)
    : tag.replace(/(\s*\/?>)$/, (_match, ending) => ` ${key}="${quoted}"${ending}`);
}

function removeAttribute(tag: string, key: string): string {
  return tag.replace(new RegExp(`\\s${key}\\s*=\\s*(["']).*?\\1`, 'i'), '');
}

/** Locate only direct fdm_config I/O tags, preserving all untouched XML bytes. */
function topLevelIo(xml: string): IoTag[] {
  validateXmlSource(xml, '模型 XML');
  const tags: IoTag[] = [];
  const stack: string[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][^>]*>/g;
  for (const match of xml.matchAll(tokens)) {
    const tag = match[0];
    if (tag.startsWith('<!') || tag.startsWith('<?')) continue;
    const closing = tag.startsWith('</');
    const name = tag.match(/^<\/?([A-Za-z_][\w:.-]*)/)?.[1]?.toLowerCase();
    if (!name) continue;
    if (closing) { stack.pop(); continue; }
    if (stack.length === 1 && stack[0] === 'fdm_config' && (name === 'input' || name === 'output')) {
      tags.push({ kind: name, type: attribute(tag, 'type').toUpperCase(), name: attribute(tag, 'name'),
        transport: attribute(tag, 'transport').toUpperCase(), tag,
        start: match.index, end: match.index + tag.length });
    }
    if (!/\/\s*>$/.test(tag)) stack.push(name);
  }
  return tags;
}

function one<T>(items: T[], label: string): T | null {
  if (items.length > 1) throw new Error(`模型 XML 中有多个网口 ${label}，无法确定要修改哪一个`);
  return items[0] || null;
}

function selectTags(tags: IoTag[]): Record<HilEndpointKey, IoTag | null> {
  const udp = tags.filter(tag => tag.transport !== 'SERIAL');
  const input = one(udp.filter(tag => tag.kind === 'input' && tag.type === 'HIL_ACTUATOR_CONTROLS'), 'HIL Input') ||
    one(udp.filter(tag => tag.kind === 'input' && tag.type === 'SOCKET' && isIpv4(tag.name)), 'Socket Input');
  return {
    input,
    sensor: one(udp.filter(tag => tag.kind === 'output' && tag.type === 'HIL_SENSOR'), 'HIL_SENSOR Output'),
    gps: one(udp.filter(tag => tag.kind === 'output' && tag.type === 'HIL_GPS'), 'HIL_GPS Output'),
  };
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function portValid(port: string): boolean {
  return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

export function readHilEndpoints(xml: string): HilEndpoints {
  const tags = selectTags(topLevelIo(xml));
  if (KEYS.every(key => !tags[key])) throw new Error('模型 XML 没有可用的网口 HIL Input/Output');
  return {
    input: tags.input ? { ip: tags.input.name, port: attribute(tags.input.tag, 'port') } : null,
    sensor: tags.sensor ? { ip: attribute(tags.sensor.tag, 'host'), port: attribute(tags.sensor.tag, 'port') } : null,
    gps: tags.gps ? { ip: attribute(tags.gps.tag, 'host'), port: attribute(tags.gps.tag, 'port') } : null,
  };
}

export function patchHilEndpoints(xml: string, values: HilEndpoints): string {
  const selected = selectTags(topLevelIo(xml));
  const replacements: { start: number; end: number; tag: string }[] = [];
  for (const key of KEYS) {
    const tag = selected[key];
    const value = values[key];
    if (!tag && !value) continue;
    if (!tag || !value) throw new Error(`${key} 节点已变化，请重新读取模型 XML`);
    const ip = value.ip.trim();
    const port = value.port.trim();
    if ((key === 'input' || ip) && !isIpv4(ip)) throw new Error(`${key} IP 不是有效的 IPv4 地址`);
    if (!portValid(port)) throw new Error(`${key} 端口须为 1～65535`);
    let updated = key === 'input' ? setAttribute(tag.tag, 'name', ip)
      : ip ? setAttribute(tag.tag, 'host', ip) : removeAttribute(tag.tag, 'host');
    updated = setAttribute(updated, 'port', port);
    replacements.push({ start: tag.start, end: tag.end, tag: updated });
  }
  return replacements.sort((a, b) => b.start - a.start).reduce(
    (current, replacement) => current.slice(0, replacement.start) + replacement.tag + current.slice(replacement.end), xml);
}

export function readHilEndpointsFromNodes(nodes: IoNode[]): HilEndpoints {
  const get = (kind: string, type: string) => nodes.filter(node =>
    node.data.componentType === kind && String(node.data.params?.type || '').toUpperCase() === type &&
    node.data.params?.transport !== 'SERIAL');
  const inputNode = one(get('input', 'HIL_ACTUATOR_CONTROLS'), 'HIL Input') ||
    one(get('input', 'SOCKET').filter(node => isIpv4(String(node.data.params?.name || ''))), 'Socket Input');
  const sensorNode = one(get('output', 'HIL_SENSOR'), 'HIL_SENSOR Output');
  const gpsNode = one(get('output', 'HIL_GPS'), 'HIL_GPS Output');
  const endpoint = (node: IoNode | null, key: HilEndpointKey): HilEndpoint | null => node ? {
    ip: String(node.data.params?.[key === 'input' ? 'name' : 'host'] || ''),
    port: String(node.data.params?.port ?? ''),
  } : null;
  return { input: endpoint(inputNode, 'input'), sensor: endpoint(sensorNode, 'sensor'), gps: endpoint(gpsNode, 'gps') };
}

export function syncHilEndpointsToNodes<T extends IoNode>(nodes: T[], values: HilEndpoints): T[] {
  const existing = readHilEndpointsFromNodes(nodes);
  if (KEYS.every(key => !existing[key])) return nodes;
  return nodes.map(node => {
    const type = String(node.data.params?.type || '').toUpperCase();
    const key: HilEndpointKey | null = node.data.componentType === 'input' &&
      (type === 'HIL_ACTUATOR_CONTROLS' || type === 'SOCKET' && isIpv4(String(node.data.params?.name || '')))
      ? 'input' : node.data.componentType === 'output' && type === 'HIL_SENSOR' ? 'sensor'
        : node.data.componentType === 'output' && type === 'HIL_GPS' ? 'gps' : null;
    const value = key && values[key];
    if (!key || !value || node.data.params?.transport === 'SERIAL') return node;
    return { ...node, data: { ...node.data, params: { ...node.data.params,
      [key === 'input' ? 'name' : 'host']: value.ip,
      port: Number(value.port),
    } } } as T;
  });
}
