import { useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { generateXml, generateSubfile, parseXml, saveProject, getProjectPath, loadProject as loadProjectApi, loadAircraft, simListModels, ftpDownloadModel, ftpDownloadXml, ftpUploadModel, ftpUploadFile, ftpUploadModelAssets, checkModelAssets, ftpListSystems, ftpListEngines, listRemoteXmlParent, isRemoteUploadEnabled } from '../utils/tauriApi';
import { parseSerialSensors, serializeSerialSensors } from '../utils/serialSensorXml';
import { parsePwmCaptures, serializePwmCaptures } from '../utils/pwmCaptureXml';
import AircraftWizard from './AircraftWizard';
import AircraftLibrary from './AircraftLibrary';
import SimMenu, { type FleetControls } from './SimMenu';
import TelemetryRecorder from './TelemetryRecorder';
import SimulationConfigDialog from './SimulationConfigDialog';
import { fleetSlotIds, type FleetInitialOverrides, type FleetNetworkOverrides, type FleetModelGroup } from '../utils/fleetModelGroups';
import LocalSettingsDialog from './LocalSettingsDialog';
import J23GuideDialog from './J23GuideDialog';
import NshConsoleDialog from './NshConsoleDialog';
import SerialAssistantDialog from './SerialAssistantDialog';
import UsbFileManager from './UsbFileManager';
import XmlSourceBrowser, { type XmlSourceDocument } from './XmlSourceBrowser';
import { patchExistingSubfileXml } from '../utils/sourcePreservingXml';
import { xmlContentEqual } from '../utils/xmlContentEqual';
import { isTauri, selectModelImport, getSimulatorTransportMode, getPlotJugglerRate, setPlotJugglerRate, startPlotJuggler } from '../utils/tauriApi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLanguage } from '../i18n';
import { validateXmlSource, showXmlDiagnostic } from '../utils/xmlDiagnostics';
import { getToolbarAppearance, saveToolbarAppearance, toolbarBackground, type ToolbarAppearance } from '../utils/toolbarAppearance';

interface ToolbarProps {
  onShow3D?: () => void;
  jsbsimLogs?: string[];
  onLog?: (message: string) => void;
  onToggleJsbsimLog?: () => void;
  onToggleHud?: () => void;
  hudVisible?: boolean;
  onShowLogCenter?: () => void;
  fleetControls?: FleetControls;
  workspace?: 'editor' | 'multi';
  onSelectWorkspace?: (workspace: 'editor' | 'multi') => void;
  activeInstance?: string;
  instanceSlots?: Record<string, string>;
  editorSwitchRequest?: string | null;
  onEditorSwitchHandled?: () => void;
  onSelectInstance?: (id: string) => void;
  onSelectMultiInstance?: (id: string) => void;
  onAssignInstanceModel?: (id: string, model: string) => void;
  initialOverrides?: FleetInitialOverrides;
  networkOverrides?: FleetNetworkOverrides;
  onLoadFleetGroup?: (group: FleetModelGroup) => boolean | void;
  onModelContextChange?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  modifiedXmlFiles?: string[];
  onSaveComplete?: (savedFiles?: string[]) => void;
}

type ImportFileCategory = 'initialization' | 'model-config' | 'system' | 'engine' | 'companion';
type ImportFile = { name: string; xml: string; category: ImportFileCategory };

interface PendingModelImport {
  mainFileName: string;
  mainXml: string;
  referenceFiles: ImportFile[];
  assets: Array<{ name: string; size: number }>;
  fromDirectory: boolean;
  sourceDirectory?: string;
  originalModelName: string;
  modelName: string;
  renameFdmConfig: boolean;
}

function projectFingerprint(project: { aircraft: any; nodes: any[]; edges: any[]; subFiles?: any[]; xmlFiles?: any[] }): string {
  return JSON.stringify({
    aircraft: project.aircraft,
    nodes: project.nodes,
    edges: project.edges,
    subFiles: project.subFiles || [],
    xmlFiles: project.xmlFiles || [],
  });
}

function serialSensorFingerprint(project: { nodes?: any[]; edges?: any[] }): string {
  const sensors = (project.nodes || []).filter(node => node.data?.componentType === 'serial_sensor');
  const sensorIds = new Set(sensors.map(node => node.id));
  return JSON.stringify({
    sensors: sensors.map(node => ({ id: node.id, data: node.data })),
    connections: (project.edges || []).filter(edge => sensorIds.has(edge.target))
      .map(edge => ({ source: edge.source, target: edge.target })),
  });
}

function serialHilFingerprint(project: { nodes?: any[] }): string {
  return JSON.stringify((project.nodes || [])
    .filter(node => node.data?.componentType === 'serial_hil')
    .map(node => ({ id: node.id, data: node.data })));
}

function mainIoFingerprint(project: { nodes?: any[] }): string {
  return JSON.stringify((project.nodes || [])
    .filter(node => ['input', 'output', 'uavcan'].includes(node.data?.componentType))
    .map(node => ({
      id: node.id,
      componentType: node.data.componentType,
      params: Object.fromEntries(Object.entries(node.data.params || {})
        .filter(([key]) => key !== 'layout')),
    })));
}

function pwmCaptureFingerprint(project: { nodes?: any[] }): string {
  return JSON.stringify((project.nodes || [])
    .filter(node => node.data?.componentType === 'pwm_capture')
    .map(node => ({ id: node.id, data: node.data })));
}

function remoteBaselineKey(model: string): string {
  return `jsbsim-remote-baseline:${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

function serialSensorPath(model: string): string {
  return `config/models/${model}.serial.xml`;
}

function pwmCapturePath(model: string): string {
  return `config/models/${model}.pwm.xml`;
}

async function loadRemoteXmlForReview(path: string): Promise<string | null> {
  try {
    return (await ftpDownloadXml(path)).content;
  } catch (error) {
    const separator = path.lastIndexOf('/');
    if (separator < 0) throw error;
    const parent = await listRemoteXmlParent(path.slice(0, separator));
    const name = path.slice(separator + 1).toLowerCase();
    if (!parent.exists || !parent.files.some(file => file.toLowerCase() === name)) return null;
    throw error;
  }
}

async function withPwmCaptures(data: any, model: string): Promise<any> {
  let source: string;
  try {
    source = (await ftpDownloadXml(pwmCapturePath(model))).content;
  } catch (error) {
    const parent = await listRemoteXmlParent('config/models');
    if (parent.files.some(file => file.toLowerCase() === `${model}.pwm.xml`.toLowerCase())) throw error;
    return data;
  }
  const captures = parsePwmCaptures(source);
  const existing = Array.isArray(data.nodes) ? data.nodes : [];
  const right = existing.reduce((x: number, node: any) => Math.max(x, Number(node.position?.x) || 0), 0) + 320;
  const pwmNodes = captures.map((capture, index) => ({
    id: `pwm-capture-${index}`, type: 'aircraftComponent', data: capture,
    position: { x: right, y: index * 170 },
  }));
  return { ...data, nodes: [...existing, ...pwmNodes] };
}

async function withSerialSensors(data: any, model: string): Promise<any> {
  let source = '';
  try {
    const remote = await ftpDownloadXml(serialSensorPath(model));
    source = remote.content;
  } catch (error) {
    const parent = await listRemoteXmlParent('config/models');
    if (parent.files.some(file => file.toLowerCase() === `${model}.serial.xml`.toLowerCase())) {
      throw error;
    }
    // A firmware without the sidecar still has H7's original Viztra default.
    // Other models have no configured serial sensors until one is added.
    if (model !== 'H7') return data;
    source = '<?xml version="1.0"?><serial_outputs version="1"><output name="Viztra HYM1" protocol="VIZTRA_HYM1" device="/dev/ttyS1" baud="115200" logic_name="H7_Viztra"/></serial_outputs>';
  }
  const sensors = parseSerialSensors(source);
  const existing = Array.isArray(data.nodes) ? data.nodes : [];
  const right = existing.reduce((x: number, node: any) => Math.max(x, Number(node.position?.x) || 0), 0) + 320;
  const serialNodes = sensors.map((sensor, index) => ({
    id: `serial-sensor-${index}`, type: 'aircraftComponent', data: sensor,
    position: { x: right, y: index * 170 },
  }));
  const serialEdges = serialNodes.flatMap(node => {
    const logicName = String(node.data.params.logic_name || '');
    const source = existing.find((candidate: any) => {
      const params = candidate.data?.params || {};
      const file = String(params.file || params._source_file || '').replace(/\.xml$/i, '').split('/').pop();
      return candidate.data?.componentType === 'system' && logicName &&
        (file === logicName || params.name === logicName);
    });
    return source ? [{ id: `serial-link-${node.id}`, source: source.id, sourceHandle: 'system',
      target: node.id, targetHandle: 'sensor', type: 'smoothstep' }] : [];
  });
  return { ...data, nodes: [...existing, ...serialNodes], edges: [...(data.edges || []), ...serialEdges] };
}

function subFileRemotePath(file: any): string {
  const name = String(file.fileName || '').replace(/^\/+/, '').replace(/\.xml$/i, '') + '.xml';
  return `${file.fileType === 'system' ? 'systems' : 'engine'}/${name}`;
}

function nodeOwnedPath(node: any): string {
  const type = node?.data?.componentType;
  const params = node?.data?.params || {};
  const raw = String(params.referencePath || params._source_file || params.file || '').trim();
  if (!raw) return '';
  const withExt = raw.toLowerCase().endsWith('.xml') ? raw : `${raw}.xml`;
  if (withExt.includes('/')) return withExt;
  return type === 'system' || type === 'flight_control'
    ? `systems/${withExt}`
    : type === 'engine' || type === 'propeller'
      ? `engine/${withExt}`
      : withExt;
}

function comparableXml(xml: string): string {
  return String(xml || '').replace(/\r\n?/g, '\n').trim();
}

function escapeXmlAttribute(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getXmlAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

function setXmlAttribute(tag: string, name: string, value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === '') return tag;
  const escaped = escapeXmlAttribute(value);
  const expression = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`, 'i');
  if (expression.test(tag)) {
    return tag.replace(expression, (_match, prefix) => `${prefix}"${escaped}"`);
  }
  return tag.replace(/(\s*\/?>)$/, (_match, ending) => ` ${name}="${escaped}"${ending}`);
}

function removeXmlAttribute(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(["']).*?\\1`, 'i'), '');
}

function fdmConfigName(xml: string): string {
  const tag = xml.match(/<fdm_config\b[^>]*>/i)?.[0] || '';
  return getXmlAttribute(tag, 'name').trim();
}

function renameFdmConfig(xml: string, modelName: string): string {
  let changed = false;
  const renamed = xml.replace(/<fdm_config\b[^>]*>/i, tag => {
    changed = true;
    return setXmlAttribute(tag, 'name', modelName);
  });
  if (!changed) throw new Error('未找到 <fdm_config> 主模型标签。');
  return renamed;
}

function xmlRoot(xml: string, name: string): string {
  validateXmlSource(xml, name);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(`${name} 不是有效的 XML，请检查文件内容。`);
  return doc.documentElement.localName.toLowerCase();
}

function importedFileCategory(name: string, xml: string): ImportFileCategory {
  const lower = name.toLowerCase();
  const root = xmlRoot(xml, name);
  // Check the actual document root, including comments/DOCTYPE before it.
  // A misleading filename must not turn a system/model into initialization.
  if (root === 'initialize') return 'initialization';
  if (root === 'propertylist' || root === 'fdm_config' || lower.endsWith('-set.xml')) return 'model-config';
  if (['system', 'flight_control'].includes(root)) return 'system';
  if (['piston_engine', 'turbine_engine', 'turboprop_engine', 'rocket_engine', 'electric_engine', 'propeller', 'thruster'].includes(root)) return 'engine';
  if (lower.includes('/systems/') || lower.startsWith('systems/')) return 'system';
  if (lower.includes('/engine/') || lower.startsWith('engine/')) return 'engine';
  return 'companion';
}

function suggestedImportModelName(mainFileName: string): string {
  const base = mainFileName.replace(/\\/g, '/').split('/').pop() || 'aircraft';
  return base.replace(/\.xml$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'aircraft';
}

function importCategoryLabel(category: ImportFileCategory | 'main', isZh: boolean): string {
  const zh: Record<ImportFileCategory | 'main', string> = {
    main: '主模型', initialization: '初始化/重置', 'model-config': '模型配置', system: '系统', engine: '发动机/螺旋桨', companion: '关联文件',
  };
  const en: Record<ImportFileCategory | 'main', string> = {
    main: 'Main model', initialization: 'Initialization', 'model-config': 'Model config', system: 'System', engine: 'Engine / propeller', companion: 'Companion',
  };
  return (isZh ? zh : en)[category];
}

/**
 * Apply editor changes to the original top-level I/O tags without rebuilding
 * the aircraft document. generateXml() operates on the expanded visual graph,
 * so using it for an imported model serializes referenced engine/system files
 * into the main aircraft XML.
 */
function isViztraUdpType(type: unknown): boolean {
  return type === 'VIZTRA_UDP_JSON' || type === 'VIZTRA_UDP_QGC';
}

function patchMainIoAttributes(sourceXml: string, nodes: any[]): string {
  const ioNodes = nodes.filter(node => ['input', 'output', 'uavcan'].includes(node?.data?.componentType) &&
    !isViztraUdpType(node?.data?.params?.type));
  const used = new Set<number>();

  // Top-level JSBSim transport declarations have both name and type
  // attributes. Nested FCS expression tags such as <input>property</input>
  // do not; excluding them prevents an I/O edit from touching control logic.
  return sourceXml.replace(/<(input|output)\b(?=[^>]*\bname\s*=)(?=[^>]*\btype\s*=)[^>]*>/gi, (tag, tagName: string) => {
    if (isViztraUdpType(getXmlAttribute(tag, 'type'))) return tag;
    if (getXmlAttribute(tag, 'transport') === 'SERIAL' && !getXmlAttribute(tag, 'editor_module') &&
        ['HIL_SENSOR', 'HIL_GPS', 'HIL_ACTUATOR_CONTROLS'].includes(getXmlAttribute(tag, 'type'))) return tag;
    const expectedTypes = tagName.toLowerCase() === 'input' ? new Set(['input']) : new Set(['output', 'uavcan']);
    const originalName = getXmlAttribute(tag, 'name');
    const originalType = getXmlAttribute(tag, 'type');
    const compatible = (node: any, index: number) => !used.has(index) && expectedTypes.has(node?.data?.componentType);
    let index = ioNodes.findIndex((node, candidateIndex) => {
      if (!compatible(node, candidateIndex)) return false;
      const params = node.data?.params || {};
      return String(params.name ?? '') === originalName &&
        String(node.data.componentType === 'uavcan' ? 'UAVCAN' : params.type ?? '') === originalType;
    });
    if (index < 0) {
      index = ioNodes.findIndex((node, candidateIndex) =>
        compatible(node, candidateIndex) && String(node.data?.params?.name ?? '') === originalName
      );
    }
    if (index < 0) index = ioNodes.findIndex(compatible);
    if (index < 0) return tag;

    used.add(index);
    const node = ioNodes[index];
    const params = node.data?.params || {};
    const attributes = node.data.componentType === 'uavcan'
      ? ['name', 'interface', 'node_id', 'subject_id', 'rate', 'dsdl_path', 'dsdl_type', 'sensor_type']
      : ['name', 'type', 'port', 'rate'];
    let patched = tag;
    if (node.data.componentType === 'uavcan') patched = setXmlAttribute(patched, 'type', 'UAVCAN');
    for (const attribute of attributes) patched = setXmlAttribute(patched, attribute, params[attribute]);
    if (['input', 'output'].includes(node.data.componentType)) {
      const hil = node.data.componentType === 'input'
        ? params.type === 'HIL_ACTUATOR_CONTROLS'
        : ['HIL_SENSOR', 'HIL_GPS'].includes(params.type);
      const serial = hil && params.transport === 'SERIAL';
      if (hil || getXmlAttribute(tag, 'editor_module') === node.data.componentType) {
        for (const attribute of ['transport', 'device', 'baud', 'editor_module']) {
          patched = removeXmlAttribute(patched, attribute);
        }
        if (serial) {
          patched = setXmlAttribute(patched, 'transport', 'SERIAL');
          patched = setXmlAttribute(patched, 'editor_module', node.data.componentType);
          patched = setXmlAttribute(patched, 'device', params.device || '/dev/ttyS1');
          patched = setXmlAttribute(patched, 'baud', params.baud || '921600');
        }
        if (node.data.componentType === 'output') {
          patched = removeXmlAttribute(patched, 'host');
          if (hil && !serial && String(params.host || '').trim()) {
            patched = setXmlAttribute(patched, 'host', String(params.host).trim());
          }
        }
      }
    }
    return patched;
  });
}

/** Update only Viztra JSON declarations; preserve every other model section. */
function patchMainViztraUdpOutputs(sourceXml: string, nodes: any[], previousNodes: any[] = []): string {
  const unsafe = (message: string) => Object.assign(new Error(message), { name: 'XmlPatchUnsafeError' });
  const outputs = nodes.filter(node => node?.data?.componentType === 'output' &&
    isViztraUdpType(node?.data?.params?.type));
  const otherOutputNames = new Set(nodes.filter(node => node?.data?.componentType === 'output' &&
    !isViztraUdpType(node?.data?.params?.type))
    .map(node => String(node.data.params?.name || '').trim()));
  const names = new Set<string>();
  for (const node of outputs) {
    const p = node.data.params || {};
    const name = String(p.name || '').trim();
    const host = String(p.host || '').trim();
    const port = Number(p.port);
    const rate = Number(p.rate);
    if (!name || names.has(name) || otherOutputNames.has(name)) {
      throw unsafe('Viztra UDP 输出名称须与其他输出不同且不能为空。');
    }
    names.add(name);
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.split('.').some(part => Number(part) > 255)) {
      throw unsafe(`${name}：目标 IP 须为有效的 IPv4 地址。`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw unsafe(`${name}：UDP 端口须为 1～65535。`);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 250) throw unsafe(`${name}：频率须大于 0 且不超过 250 Hz。`);
    for (const key of ['viztra_north', 'viztra_east', 'viztra_down']) {
      if (!String(p[key] || '').trim()) throw unsafe(`${name}：${key} 属性不能为空。`);
    }
  }

  const escaped = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const used = new Set<string>();
  const previousById = new Map(previousNodes.map(node => [node.id, node]));
  const blockFor = (node: any, indent: string) => {
    const p = node.data.params;
    const attributes = `name="${escaped(String(p.name))}" type="${escaped(String(p.type))}" host="${escaped(String(p.host).trim())}" port="${Number(p.port)}" rate="${Number(p.rate)}" editor_module="output"`;
    const properties = ['viztra_north', 'viztra_east', 'viztra_down']
      .map(key => `${indent}  <property>${escaped(String(p[key]).trim())}</property>`).join('\n');
    return `${indent}<output ${attributes}>\n${properties}\n${indent}</output>`;
  };
  const otherBlockFor = (node: any, indent: string) => {
    const p = node.data.params || {};
    const type = String(p.type || 'SOCKET');
    const attributes = [`name="${escaped(String(p.name || ''))}"`, `type="${escaped(type)}"`];
    if (p.port != null) attributes.push(`port="${escaped(String(p.port))}"`);
    if (p.rate != null) attributes.push(`rate="${escaped(String(p.rate))}"`);
    if (['HIL_SENSOR', 'HIL_GPS'].includes(type)) {
      if (p.transport === 'SERIAL') {
        attributes.push('transport="SERIAL"', 'editor_module="output"',
          `device="${escaped(String(p.device || '/dev/ttyS1'))}"`,
          `baud="${escaped(String(p.baud || '921600'))}"`);
      } else if (String(p.host || '').trim()) {
        attributes.push(`host="${escaped(String(p.host).trim())}"`);
      }
    }
    const groups = ['simulation', 'atmosphere', 'massprops', 'rates', 'velocities',
      'forces', 'moments', 'position', 'propulsion', 'aerosurfaces', 'fcs',
      'ground_reactions', 'coefficients'];
    const lines = groups.filter(key => p[key] === 'ON')
      .map(key => `${indent}  <${key}>ON</${key}>`);
    const keys = type === 'HIL_SENSOR'
      ? ['hil_imu_accel_x', 'hil_imu_accel_y', 'hil_imu_accel_z', 'hil_imu_gyro_x',
          'hil_imu_gyro_y', 'hil_imu_gyro_z', 'hil_imu_mag_x', 'hil_imu_mag_y',
          'hil_imu_mag_z', 'hil_pressure_abs', 'hil_pressure_diff', 'hil_pressure_alt', 'hil_temperature']
      : type === 'HIL_GPS'
        ? ['hil_gps_lat', 'hil_gps_lon', 'hil_gps_alt', 'hil_gps_vn', 'hil_gps_ve',
            'hil_gps_vn', 'hil_gps_ve', 'hil_gps_vd'] : [];
    const properties = keys.length
      ? keys.map(key => String(p[key] || '').trim()).filter(Boolean)
      : String(p.properties || '').split(',').map(value => value.trim()).filter(Boolean);
    lines.push(...properties.map(value => `${indent}  <property>${escaped(value)}</property>`));
    return `${indent}<output ${attributes.join(' ')}>\n${lines.join('\n')}\n${indent}</output>`;
  };

  // Match by the existing output name so an output node can be changed from
  // SOCKET/HIL to this protocol without leaving a second declaration behind.
  let xml = sourceXml.replace(/([ \t]*)<output\b(?=[^>]*\bname\s*=)(?=[^>]*\btype\s*=)[^>]*>[\s\S]*?<\/output\s*>/gi,
    (block, indent: string) => {
      const tag = block.slice(block.indexOf('<output'), block.indexOf('>') + 1);
      const oldName = getXmlAttribute(tag, 'name');
      const oldType = getXmlAttribute(tag, 'type');
      const candidate = outputs.find(node => {
        const previous = previousById.get(node.id) as any;
        return previous?.data?.componentType === 'output' &&
          String(previous.data.params?.name || '').trim() === oldName;
      }) || outputs.find(node =>
        String(node.data.params?.name || '').trim() === oldName &&
        (!previousNodes.length || previousById.has(node.id)));
      if (!candidate && isViztraUdpType(oldType)) {
        const replacement = nodes.find(node => {
          const previous = previousById.get(node.id) as any;
          return node.data?.componentType === 'output' && !isViztraUdpType(node.data?.params?.type) &&
            (isViztraUdpType(previous?.data?.params?.type) &&
             String(previous.data.params?.name || '').trim() === oldName ||
             !previousNodes.length && String(node.data?.params?.name || '').trim() === oldName);
        });
        return replacement ? otherBlockFor(replacement, indent) : '';
      }
      if (!candidate) return block;
      if (!isViztraUdpType(oldType) &&
          outputs.some(node => node !== candidate && String(node.data.params?.name || '').trim() === oldName)) {
        throw unsafe(`Viztra UDP 输出名称 ${oldName} 与现有输出冲突。`);
      }
      if (used.has(oldName)) throw unsafe(`主模型中有多个名为 ${oldName} 的输出，无法安全写入 Viztra UDP JSON。`);
      used.add(oldName);
      used.add(String(candidate.data.params?.name || '').trim());
      return blockFor(candidate, indent);
    });
  const pending = outputs.filter(node => !used.has(String(node.data.params?.name || '').trim()));
  if (pending.length) {
    const end = xml.lastIndexOf('</fdm_config>');
    if (end < 0) throw unsafe('主模型缺少 fdm_config 结束标签，无法添加 Viztra UDP JSON 输出。');
    xml = `${xml.slice(0, end).replace(/\s*$/, '')}\n\n${pending.map(node => blockFor(node, '  ')).join('\n\n')}\n${xml.slice(end)}`;
  }
  return xml;
}

function savedRemoteNodes(model: string): any[] {
  try {
    const nodes = JSON.parse(localStorage.getItem(remoteBaselineKey(model)) || '{}').nodes;
    return Array.isArray(nodes) ? nodes : [];
  } catch { return []; }
}

/** Patch the three legacy serial HIL declarations in place so unrelated model XML survives. */
function patchMainSerialHil(sourceXml: string, nodes: any[]): string {
  const unsafe = (message: string) => Object.assign(new Error(message), { name: 'XmlPatchUnsafeError' });
  const serialNodes = nodes.filter(node => node.data?.componentType === 'serial_hil');
  if (!serialNodes.length) throw unsafe('PX4 串口 HIL 节点已删除；主模型串口声明无法安全更新。');
  const counts = new Map<string, Set<string>>();
  const xml = sourceXml.replace(/<(input|output)\b(?=[^>]*\bname\s*=)(?=[^>]*\btype\s*=)[^>]*>[\s\S]*?<\/\1\s*>/gi, block => {
    const tag = block.slice(0, block.indexOf('>') + 1);
    const type = getXmlAttribute(tag, 'type');
    if (getXmlAttribute(tag, 'transport') !== 'SERIAL' || getXmlAttribute(tag, 'editor_module') ||
        !['HIL_SENSOR', 'HIL_GPS', 'HIL_ACTUATOR_CONTROLS'].includes(type)) return block;
    const oldName = getXmlAttribute(tag, 'name');
    const candidates = serialNodes.filter(node => String(node.data.params?.name || '') === oldName);
    const serial = candidates.length === 1 ? candidates[0] : serialNodes.length === 1 ? serialNodes[0] : null;
    if (!serial) throw unsafe(`无法确定串口 HIL 声明 ${oldName} 对应的图形节点，已取消上传。`);
    const found = counts.get(serial.id) || new Set<string>();
    if (found.has(type)) throw unsafe(`串口 HIL ${oldName} 存在重复的 ${type} 声明，已取消上传。`);
    found.add(type);
    counts.set(serial.id, found);
    const params = serial.data.params || {};
    let patched = tag;
    const attributes = ['name', 'device', 'baud', 'data_bits', 'parity', 'stop_bits', 'flow_control', 'mavlink_version'];
    if (type !== 'HIL_ACTUATOR_CONTROLS') attributes.push('system_id', 'component_id');
    for (const attribute of attributes) {
      patched = params[attribute] === undefined || params[attribute] === null || String(params[attribute]).trim() === ''
        ? removeXmlAttribute(patched, attribute)
        : setXmlAttribute(patched, attribute, params[attribute]);
    }
    if (type !== 'HIL_ACTUATOR_CONTROLS') {
      const rate = params[type === 'HIL_SENSOR' ? 'sensor_rate' : 'gps_rate'];
      patched = rate === undefined || rate === null || String(rate).trim() === ''
        ? removeXmlAttribute(patched, 'rate') : setXmlAttribute(patched, 'rate', rate);
    }
    const propertyKey = type === 'HIL_SENSOR' ? 'sensor_properties'
      : type === 'HIL_GPS' ? 'gps_properties' : 'actuator_properties';
    const desired = String(params[propertyKey] || '').split(',').map(value => value.trim()).filter(Boolean);
    const body = block.slice(tag.length, block.lastIndexOf('</'));
    const propertyPattern = /<property(?:\s[^>]*)?>[\s\S]*?<\/property\s*>/gi;
    const existing = Array.from(body.matchAll(propertyPattern), match => match[0].replace(/^<property(?:\s[^>]*)?>|<\/property\s*>$/gi, '').trim());
    let patchedBody = body;
    if (JSON.stringify(existing) !== JSON.stringify(desired)) {
      if (/<(?!\/?property\b)[A-Za-z][^>]*>/.test(body)) {
        throw unsafe(`串口 HIL ${type} 含有未识别的子元素，已取消属性映射修改。`);
      }
      const indent = body.match(/\n([ \t]*)<property\b/i)?.[1] || '    ';
      const properties = desired.map(value => `<property>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</property>`);
      patchedBody = body.replace(propertyPattern, '').replace(/\s*$/, '') +
        (properties.length ? `\n${indent}${properties.join(`\n${indent}`)}` : '') + '\n';
    }
    return patched + patchedBody + block.slice(block.lastIndexOf('</'));
  });
  for (const serial of serialNodes) {
    const found = counts.get(serial.id);
    if (!found || ['HIL_SENSOR', 'HIL_GPS', 'HIL_ACTUATOR_CONTROLS'].some(type => !found.has(type))) {
      throw unsafe('主模型缺少完整的 PX4 串口 HIL 声明，已取消上传以保护原始 XML。');
    }
  }
  return xml;
}

async function patchInlineSerialLogic(sourceXml: string, nodes: any[], edges: any[]): Promise<string> {
  const priorNames = new Set(Array.from(sourceXml.matchAll(/<!-- SERIAL_SENSOR_LOGIC_BEGIN ([A-Za-z0-9_.-]+) -->/g),
    match => match[1]));
  const marker = /\s*<!-- SERIAL_SENSOR_LOGIC_BEGIN [A-Za-z0-9_.-]+ -->[\s\S]*?<!-- SERIAL_SENSOR_LOGIC_END [A-Za-z0-9_.-]+ -->/g;
  let xml = sourceXml.replace(marker, '');
  const sourceIds = new Set(edges.filter(edge =>
    nodes.some(node => node.id === edge.target && node.data?.componentType === 'serial_sensor'))
    .map(edge => edge.source));
  const blocks: string[] = [];
  for (const source of nodes.filter(node => node.data?.componentType === 'system' &&
      (sourceIds.has(node.id) || priorNames.has(String(node.data.params?.name || ''))))) {
    const params = source.data.params || {};
    if (String(params.file || '').trim()) continue;
    const name = String(params.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('新传感器系统需要有效的系统名称');
    if (new RegExp(`<system\\b[^>]*\\bname=["']${name}["']`, 'i').test(xml)) {
      throw new Error(`系统 ${name} 已在主模型中存在，请先从仿真机重新加载该模型`);
    }
    const systemXml = (await generateSubfile('system', name, params))
      .replace(/^\s*<\?xml[^?]*\?>\s*/i, '').trim();
    blocks.push(`  <!-- SERIAL_SENSOR_LOGIC_BEGIN ${name} -->\n  ${systemXml}\n  <!-- SERIAL_SENSOR_LOGIC_END ${name} -->`);
  }
  if (!blocks.length) return xml;
  const anchor = /\n(?=\s*<(?:system|flight_control|aerodynamics|input|output)\b)/i.exec(xml);
  const index = anchor ? anchor.index : xml.lastIndexOf('</fdm_config>');
  if (index < 0) throw new Error('主模型缺少 fdm_config 结束标签');
  xml = `${xml.slice(0, index)}\n${blocks.join('\n')}\n${xml.slice(index)}`;
  return xml;
}

function originalMainXml(mainFile: any): string {
  // originalXml is the immutable import/download snapshot. currentXml may
  // contain output produced by an older, lossy regeneration path.
  return mainFile?.originalXml?.trim()
    ? mainFile.originalXml
    : mainFile?.currentXml?.trim()
      ? mainFile.currentXml
      : localStorage.getItem('jsbsim-raw-xml') || '';
}

function childFileType(componentType: string): 'engine' | 'thruster' | 'system' {
  if (componentType === 'system' || componentType === 'flight_control') return 'system';
  return componentType === 'propeller' ? 'thruster' : 'engine';
}

async function buildChildUploadXml(current: any, path: string): Promise<string> {
  const tracked = (current.xmlFiles || []).find((file: any) => file.path === path);
  const owners = (current.nodes || []).filter((node: any) => nodeOwnedPath(node) === path &&
    ['engine', 'propeller', 'system', 'flight_control'].includes(node.data?.componentType));
  const subFile = (current.subFiles || []).find((item: any) => subFileRemotePath(item) === path);
  const firstOwner = owners[0];
  const fileType = firstOwner
    ? childFileType(firstOwner.data.componentType)
    : subFile?.fileType === 'system' ? 'system' : subFile?.fileType === 'thruster' ? 'thruster' : 'engine';
  const fileName = path.replace(/^.*\//, '').replace(/\.xml$/i, '');
  // originalXml is the last complete import/upload snapshot. A dirty currentXml
  // may have been produced by an older lossy generator, so never choose it in
  // preference to the complete source.
  const source = tracked?.originalXml?.trim()
    ? tracked.originalXml
    : tracked?.currentXml?.trim() ? tracked.currentXml : '';

  if (source.trim()) {
    const patches = owners.length ? owners.map((node: any) => node.data?.params || {}) : subFile ? [subFile.data || {}] : [];
    if (!patches.length) {
      throw new Error(`子文件 ${path} 没有对应的图形模块，已取消覆盖以保护原始 XML。`);
    }
    let content = source;
    for (const params of patches) {
      // The System's XML name can differ from its filename (for example the
      // H7 barometer file). Generating with the filename changes that name.
      const systemPatch = fileType === 'system'
        ? await generateSubfile('system', String(params.name || '').trim() || fileName, params)
        : undefined;
      content = patchExistingSubfileXml(content, fileType, params, systemPatch);
    }
    // A graph round-trip can rewrite only indentation/blank lines. Keep the
    // downloaded source verbatim when its XML content has not changed.
    return xmlContentEqual(source, content) ? source : content;
  }

  // Full generation is permitted only for an explicitly-created subfile. An
  // imported reference with missing source is unsafe because unknown fields,
  // comments and lookup tables cannot be reconstructed from node parameters.
  if (!subFile) {
    throw new Error(`子文件 ${path} 缺少原始 XML。为防止丢失未建模字段、查表或注释，本次上传已取消；请重新导入完整目录。`);
  }
  return generateSubfile(subFile.fileType, subFile.fileName, subFile.data);
}

export default function Toolbar({ onShow3D, jsbsimLogs = [], onLog, onToggleJsbsimLog, onToggleHud, hudVisible = true, onShowLogCenter, fleetControls, workspace = 'editor', onSelectWorkspace, activeInstance = '01', instanceSlots = {}, editorSwitchRequest,
  onEditorSwitchHandled, onSelectInstance, onSelectMultiInstance, onAssignInstanceModel, initialOverrides, networkOverrides, onLoadFleetGroup, onModelContextChange, onUndo, onRedo, onCopy, onPaste, modifiedXmlFiles = [], onSaveComplete }: ToolbarProps) {
  const { isZh } = useLanguage();
  const { aircraft, setAircraft, nodes, edges, subFiles, xmlFiles, loadProject, clearAll } = useFlowStore();
  const hasLoadedModel = nodes.length > 0 || xmlFiles.length > 0;
  const loadedModelDirectory = (() => {
    const mainPath = xmlFiles.find(file => file.category === 'main')?.path || '';
    const match = mainPath.replace(/\\/g, '/').match(/^aircraft\/([^/]+)\//i);
    return match?.[1] || '';
  })();
  // handleOpenRemoteModel records the exact FTP directory selected by the
  // user/script. This remains authoritative even when parsing replaces the
  // project aircraft name with the human-readable fdm_config name.
  const remoteModelDirectory = localStorage.getItem('jsbsim-remote-model') || '';
  const [showXml, setShowXml] = useState(false);
  const [showXmlSourceBrowser, setShowXmlSourceBrowser] = useState(false);
  const [uploadReview, setUploadReview] = useState<{ documents: XmlSourceDocument[]; resolve: () => void } | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingModelImport | null>(null);
  const [xmlContent, setXmlContent] = useState('');
  // An import result belongs to the current import action. Restoring the old
  // modal on startup makes stale references look like a new import result.
  const [importedSubFiles, setImportedSubFiles] = useState<Array<{ name: string; referenced: boolean; category?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [showInstanceMenu, setShowInstanceMenu] = useState(false);
  const [instanceModels, setInstanceModels] = useState<string[]>([]);
  const [instanceModelsError, setInstanceModelsError] = useState('');
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showTelemetryRecorder, setShowTelemetryRecorder] = useState(false);
  const [telemetryRecording, setTelemetryRecording] = useState(false);
  const [showNshConsole, setShowNshConsole] = useState(false);
  const [showSerialAssistant, setShowSerialAssistant] = useState(false);
  const [showUsbFiles, setShowUsbFiles] = useState(false);
  const [showSimulationConfig, setShowSimulationConfig] = useState(false);
  const [plotJugglerOpening, setPlotJugglerOpening] = useState(false);
  const [showLocalSettings, setShowLocalSettings] = useState(false);
  const [showJ23Guide, setShowJ23Guide] = useState(false);
  const [toolbarAppearance, setToolbarAppearance] = useState<ToolbarAppearance>(getToolbarAppearance);
  const updateToolbarAppearance = (appearance: ToolbarAppearance) => {
    setToolbarAppearance(appearance);
    saveToolbarAppearance(appearance);
  };
  const [librarySimulationModel, setLibrarySimulationModel] = useState('');
  const [recentProjects, setRecentProjects] = useState<Array<{ filename: string; path: string; openedAt: string }>>(() => JSON.parse(localStorage.getItem('jsbsim-recent-projects') || '[]'));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const instanceMenuRef = useRef<HTMLDivElement>(null);
  const editMenuRef = useRef<HTMLDivElement>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const xmlSourceDocuments: XmlSourceDocument[] = [...xmlFiles
    .filter(file => file.currentXml?.trim() || file.originalXml?.trim())
    .map(file => ({
      path: file.path,
      content: file.currentXml?.trim() ? file.currentXml : file.originalXml,
      category: file.category,
      dirty: file.dirty,
    }))];
  if (!xmlSourceDocuments.some(file => file.category === 'main')) {
    const rawXml = localStorage.getItem('jsbsim-raw-xml') || '';
    if (rawXml.trim()) xmlSourceDocuments.unshift({ path: `${aircraft.name || 'model'}.xml`, content: rawXml, category: 'main' });
  }
  const windowAction = async (action: 'min' | 'max' | 'close') => {
    if (!isTauri) return;
    const window = getCurrentWindow();
    if (action === 'min') await window.minimize();
    else if (action === 'max') await window.toggleMaximize();
    else await window.close();
  };
  const openPlotJuggler = async () => {
    setShowToolsMenu(false);
    setPlotJugglerOpening(true);
    try {
      await setPlotJugglerRate(getPlotJugglerRate());
      await startPlotJuggler();
    } catch (error) {
      window.alert(`${isZh ? '无法打开 PlotJuggler' : 'Could not open PlotJuggler'}: ${String(error)}`);
    } finally {
      setPlotJugglerOpening(false);
    }
  };
  const startWindowDrag = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isTauri || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, select, [role="menu"]')) return;
    void getCurrentWindow().startDragging();
  };
  // The import summary describes one import action, not persistent project data.
  const clearImportedSubFiles = () => {
    setImportedSubFiles([]);
  };

  useEffect(() => {
    // Remove summaries persisted by older versions. They describe a previous
    // import and must never appear as a result of launching the editor.
    localStorage.removeItem('jsbsim-imported-subfiles');
  }, []);

  const rememberProject = (filename: string, path: string) => {
    setRecentProjects(current => {
      const next = [{ filename, path, openedAt: new Date().toISOString() }, ...current.filter(item => item.filename !== filename)].slice(0, 6);
      localStorage.setItem('jsbsim-recent-projects', JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const closeFileMenu = (event: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(event.target as Node)) {
        setShowWorkspaceMenu(false);
      }
      if (instanceMenuRef.current && !instanceMenuRef.current.contains(event.target as Node)) {
        setShowInstanceMenu(false);
      }
      if (fileMenuRef.current && !fileMenuRef.current.contains(event.target as Node)) {
        setShowFileMenu(false);
      }
      if (editMenuRef.current && !editMenuRef.current.contains(event.target as Node)) {
        setShowEditMenu(false);
      }
      if (displayMenuRef.current && !displayMenuRef.current.contains(event.target as Node)) {
        setShowDisplayMenu(false);
      }
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
        setShowToolsMenu(false);
      }
    };

    document.addEventListener('mousedown', closeFileMenu);
    return () => document.removeEventListener('mousedown', closeFileMenu);
  }, []);

  const handleExportXml = async () => {
    setLoading(true);
    try {
      const xml = await generateXml({ aircraft, nodes, edges });
      setXmlContent(xml);
      setShowXml(true);
    } catch (err: any) {
      alert('导出失败: ' + err.message);
    }
    setLoading(false);
  };

  const commitModelImport = async (pending: PendingModelImport) => {
    const modelName = pending.modelName.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(modelName)) {
      alert('模型目录名只能使用字母、数字、点、下划线或连字符，并且必须以字母或数字开头。');
      return;
    }
    setLoading(true);
    try {
      const mainXml = pending.renameFdmConfig
        ? renameFdmConfig(pending.mainXml, modelName)
        : pending.mainXml;
      const refFiles = pending.referenceFiles;
      const allXml = [mainXml, ...refFiles.map(file => file.xml)].join('\n').toLowerCase();
      const data = await parseXml(mainXml, refFiles,
        pending.sourceDirectory ? `${pending.sourceDirectory}/${pending.mainFileName}` : pending.mainFileName);
      loadProject(data);
      const selectedFiles = refFiles.map(file => file.name);
      const parsedFiles = (data.xmlFiles || []).filter((file: any) => file.category !== 'main').map((file: any) => String(file.path || ''));
      const packageCategories = new Map<string, string>((data.packageFiles || []).map((file: any) => [String(file.path || ''), String(file.category || 'companion')]));
      const packagePaths = Array.from(packageCategories.keys()).filter(Boolean);
      const importedFiles = Array.from(new Set([...selectedFiles, ...parsedFiles, ...packagePaths].filter(Boolean))).map(name => {
        const normalized = name.replace(/\\/g, '/').toLowerCase();
        const basename = normalized.split('/').pop() || normalized;
        const selected = refFiles.find(file => file.name === name);
        return {
          name,
          referenced: parsedFiles.includes(name) || allXml.includes(normalized) || allXml.includes(basename),
          category: packageCategories.get(name) || selected?.category || 'companion',
        };
      }).sort((a, b) => Number(b.referenced) - Number(a.referenced) || a.name.localeCompare(b.name));
      setImportedSubFiles(importedFiles);

      // Store the edited source as the canonical import snapshot. This keeps
      // the model identity used by the UI, the upload directory and fdm_config
      // aligned instead of recreating the former dflyer/quadrotor_x mismatch.
      localStorage.setItem('jsbsim-project', JSON.stringify(data));
      localStorage.setItem('jsbsim-raw-xml', mainXml);
      localStorage.setItem('jsbsim-reference-files', JSON.stringify(refFiles));
      localStorage.setItem('jsbsim-import-assets', JSON.stringify(pending.assets));
      if (pending.sourceDirectory?.startsWith('/')) localStorage.setItem('jsbsim-import-directory', pending.sourceDirectory);
      else localStorage.removeItem('jsbsim-import-directory');
      // The directory chosen in the import dialog is the remote pathname.
      // The XML's fdm_config name can intentionally remain different.
      localStorage.setItem('jsbsim-remote-model', modelName);
      localStorage.removeItem(remoteBaselineKey(modelName));
      if (refFiles.length > 0) {
        console.log(`[Import] Associated ${refFiles.length} XML file(s): ${refFiles.map(file => file.name).join(', ')}`);
      }
      setPendingImport(null);
    } catch (err: any) {
      showXmlDiagnostic(err, 'XML 导入失败');
    } finally {
      setLoading(false);
    }
  };

  const prepareModelImport = (files: Array<{ name: string; xml: string }>, fromDirectory: boolean, sourceDirectory?: string, selectedMain?: string | null, assets: Array<{ name: string; size: number }> = []) => {
    const mainFiles = files.filter(file => xmlRoot(file.xml, file.name) === 'fdm_config');
    const folderName = sourceDirectory?.replace(/\\/g, '/').split('/').pop();
    const mainFile = selectedMain
      ? mainFiles.find(file => file.name === selectedMain)
      : mainFiles.find(file => file.name === `${folderName}.xml`) || (mainFiles.length === 1 ? mainFiles[0] : undefined);
    if (!mainFile) throw new Error(mainFiles.length > 1
      ? '目录包含多个主模型，请使用「导入 XML」指定其中一个主模型文件。'
      : '所选主模型必须以 <fdm_config> 为根标签。');
    const originalModelName = fdmConfigName(mainFile.xml);
    const suggestedName = suggestedImportModelName(mainFile.name);
    setPendingImport({
      mainFileName: mainFile.name, mainXml: mainFile.xml,
      referenceFiles: files.filter(file => file !== mainFile).map(file => ({ ...file, category: importedFileCategory(file.name, file.xml) })), assets,
      fromDirectory, sourceDirectory, originalModelName, modelName: suggestedName,
      renameFdmConfig: Boolean(originalModelName && originalModelName !== suggestedName),
    });
  };

  const beginModelImport = async (directory: boolean) => {
    setShowFileMenu(false);
    if (!isTauri || !/Linux/i.test(navigator.userAgent)) {
      (directory ? directoryInputRef : fileInputRef).current?.click();
      return;
    }
    setLoading(true);
    clearImportedSubFiles();
    try {
      const scanned = await selectModelImport(directory);
      if (scanned) prepareModelImport(scanned.files, true, scanned.directory, scanned.mainFile, scanned.assets);
    } catch (err: any) {
      showXmlDiagnostic(err, 'XML 导入失败');
    } finally { setLoading(false); }
  };

  const handleImportXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    clearImportedSubFiles();
    try {
      // Read all files
      const allFiles: { name: string; xml: string }[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        if (!/\.xml$/i.test(f.name)) continue;
        const text = await f.text();
        // Keep the relative path when a directory is selected.  JSBSim XML
        // references are relative to the data root, so flattening filenames
        // breaks aircraft/engine/system relationships.
        allFiles.push({ name: (f as any).webkitRelativePath || f.name, xml: text });
      }

      // Browser directory selection prefixes every entry with the selected
      // folder name (for example jsbsim/systems/Foo.xml).  JSBSim references
      // are rooted at aircraft/, engine/, systems/ and scripts/, so remove
      // only the common browser-added directory prefix.
      const normalizedFiles = allFiles.map(file => ({ ...file, name: file.name.replace(/\\/g, '/').replace(/^\.\//, '') }));
      const firstSegments = normalizedFiles.map(file => file.name.split('/')[0]);
      const commonRoot = normalizedFiles.length > 0 && normalizedFiles.every(file => file.name.includes('/')) && firstSegments.every(segment => segment === firstSegments[0]) ? `${firstSegments[0]}/` : '';
      if (commonRoot) normalizedFiles.forEach(file => { file.name = file.name.slice(commonRoot.length); });

      prepareModelImport(normalizedFiles, e.target === directoryInputRef.current, commonRoot.replace(/\/$/, '') || undefined);
    } catch (err: any) {
      showXmlDiagnostic(err, 'XML 导入失败');
    }
    // Reset the input that actually fired. A <input type="file"> only raises
    // `change` when its value differs from the previous selection, so leaving
    // the directory picker populated makes re-importing the same folder a
    // silent no-op.
    e.target.value = '';
  };

  const handleSave = async () => {
    const model = localStorage.getItem('jsbsim-remote-model') || aircraft.name || 'aircraft';
    const safeModel = model.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filename = `${safeModel}.project.json`;
    let targetPath = filename;
    try { targetPath = await getProjectPath(filename); } catch { /* filename remains a safe fallback */ }
    const fileList = modifiedXmlFiles.length ? modifiedXmlFiles.map(file => `  • ${file}`).join('\n') : '  • 无 XML 内容变更';
    if (!confirm(`即将保存模型工程：${filename}\n\n保存路径：\n${targetPath}\n\n变更的 XML 文件：\n${fileList}\n\n工程将包含模型数据、XML 内容、布局和用户设置。确认继续吗？`)) return;
    try {
      const project = {
        format: 'jsbsim-model-project', version: 3, model, savedAt: new Date().toISOString(),
        project: { aircraft, nodes, edges, subFiles, xmlFiles },
        files: {
          main: { name: `${model}.xml`, xml: localStorage.getItem('jsbsim-raw-xml') || '' },
          references: JSON.parse(localStorage.getItem('jsbsim-reference-files') || '[]'),
          assets: JSON.parse(localStorage.getItem('jsbsim-import-assets') || '[]'),
          assetSource: localStorage.getItem('jsbsim-import-directory') || '',
          subFiles,
          xmlFiles,
        },
        layout: { nodes: nodes.map(node => ({ id: node.id, position: node.position })) },
        userSettings: {
          pinnedProperties: JSON.parse(localStorage.getItem('jsbsim-pinned-properties') || '[]'),
          unitSystem: localStorage.getItem('jsbsim-unit-system') || 'imperial',
          paletteCollapsed: localStorage.getItem('jsbsim-palette-collapsed') === 'true',
          paletteWidth: Number(localStorage.getItem('jsbsim-palette-width') || 250),
          hudPosition: JSON.parse(localStorage.getItem('jsbsim-hud-position') || '{"x":0,"y":0}'),
          logPosition: JSON.parse(localStorage.getItem('jsbsim-log-position') || '{"x":0,"y":0}'),
        },
      };
      const saved = await saveProject(filename, project);
      const savedPath = saved.path || filename;
      rememberProject(filename, savedPath);
      onSaveComplete?.();
      alert(`工程已保存：\n${savedPath}`);
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    }
  };

  const handleSaveToSimulator = async () => {
    const model = localStorage.getItem('jsbsim-remote-model') || aircraft.name;
    if (!model || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model)) {
      alert('无法确定有效的仿真机模型名称，请先导入或从仿真机加载模型。');
      return;
    }
    const target = `/mnt/sdcard/jsbsim/aircraft/${model}/${model}.xml`;
    const stateBeforeSave = useFlowStore.getState();
    let serialHilChanged = false;
    let mainIoChanged = false;
    try {
      const baseline = localStorage.getItem(remoteBaselineKey(model));
      if (baseline) {
        const previous = JSON.parse(baseline);
        serialHilChanged = serialHilFingerprint(stateBeforeSave) !== serialHilFingerprint(previous);
        mainIoChanged = mainIoFingerprint(stateBeforeSave) !== mainIoFingerprint(previous);
      }
    } catch { /* The visible dirty-file list remains available. */ }
    const serialPath = serialSensorPath(model);
    const serialTarget = `/mnt/sdcard/jsbsim/${serialPath}`;
    const pwmPath = pwmCapturePath(model);
    const pwmTarget = `/mnt/sdcard/jsbsim/${pwmPath}`;
    let serialXml: string | null = null;
    let pwmXml: string | null = null;
    try {
      serialXml = serializeSerialSensors(stateBeforeSave.nodes, stateBeforeSave.edges);
      const previous = JSON.parse(localStorage.getItem(remoteBaselineKey(model)) || '{}');
      if (serialXml === null && Array.isArray(previous.nodes) &&
          previous.nodes.some((node: any) => node?.data?.componentType === 'serial_sensor')) {
        serialXml = '<?xml version="1.0"?>\n<serial_outputs version="1"/>\n';
      }
      pwmXml = serializePwmCaptures(stateBeforeSave.nodes);
      if (pwmXml === null && Array.isArray(previous.nodes) &&
          previous.nodes.some((node: any) => node?.data?.componentType === 'pwm_capture')) {
        pwmXml = '<?xml version="1.0"?>\n<pwm_inputs version="1"/>\n';
      }
    } catch (error) {
      alert(`硬件关联配置无效：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Without a baseline, upload the main file and the files explicitly
    // selected at import. Indexed global references are not owned by this
    // model and must not be regenerated or overwritten automatically.
    const hasBaseline = !!localStorage.getItem(remoteBaselineKey(model));
    const dirtyRecords = (stateBeforeSave.xmlFiles || []).filter(file => file.dirty);
    let packageFiles: Array<{ path: string; xml: string }> = [];
    let assetFiles: Array<{ name: string; size: number }> = [];
    let assetSource = '';
    if (!hasBaseline) {
      try {
        const references: ImportFile[] = JSON.parse(localStorage.getItem('jsbsim-reference-files') || '[]');
        if (!Array.isArray(references)) throw new Error('关联文件清单格式无效');
        const seen = new Set<string>();
        packageFiles = references.map(file => {
          const name = String(file.name || '').replace(/\\/g, '/');
          const parts = name.split('/');
          if (parts.length > 4 || !parts.every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && part !== '..') ||
              !name.toLowerCase().endsWith('.xml') || !String(file.xml || '').trim() || name.toLowerCase() === `${model.toLowerCase()}.xml` || seen.has(name.toLowerCase())) {
            throw new Error(`关联 XML 的路径或内容无效：${name}`);
          }
          seen.add(name.toLowerCase());
          return { path: `aircraft/${model}/${name}`, xml: file.xml };
        });
        assetFiles = JSON.parse(localStorage.getItem('jsbsim-import-assets') || '[]');
        assetSource = localStorage.getItem('jsbsim-import-directory') || '';
        if (!Array.isArray(assetFiles) || (assetFiles.length && !assetSource.startsWith('/')) ||
            assetFiles.some(file => !file.name || !file.name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && part !== '..') ||
              !Number.isSafeInteger(file.size) || file.size < 0)) {
          throw new Error('模型资源清单或源目录无效，请重新导入');
        }
      } catch (error) {
        alert(`无法准备关联 XML，未开始上传：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const trackedFiles = dirtyRecords.map(file => file.path);
    const connectedSystemIds = new Set(stateBeforeSave.edges.filter(edge =>
      stateBeforeSave.nodes.some(node => node.id === edge.target && node.data.componentType === 'serial_sensor'))
      .map(edge => edge.source));
    const hasInlineSerialLogic = stateBeforeSave.nodes.some(node => connectedSystemIds.has(node.id) &&
      node.data.componentType === 'system' && !String(node.data.params?.file || '').trim());
    const hadInlineSerialLogic = originalMainXml((stateBeforeSave.xmlFiles || []).find(file => file.category === 'main'))
      .includes('SERIAL_SENSOR_LOGIC_BEGIN');
    const changesList = Array.from(new Set([...modifiedXmlFiles, ...trackedFiles, ...packageFiles.map(file => file.path),
      ...(serialHilChanged || mainIoChanged ? [`aircraft/${model}/${model}.xml`] : []),
      ...(serialXml !== null ? [serialPath] : []),
      ...(pwmXml !== null ? [pwmPath] : []),
      ...(hasInlineSerialLogic || hadInlineSerialLogic ? [`aircraft/${model}/${model}.xml`] : [])]));
    const changes = changesList.length
      ? changesList.map(file => `  • ${file}`).join('\n')
      : hasBaseline ? '  • 当前未记录到 XML 修改' : `  • 全量上传：${model} 尚无同步基线`;
    const mainDirty = hasBaseline
      ? dirtyRecords.some(file => file.category === 'main') ||
        modifiedXmlFiles.some(file => file === `${model}.xml` || file.endsWith(`/${model}.xml`)) ||
        hasInlineSerialLogic || hadInlineSerialLogic || serialHilChanged || mainIoChanged
      : true;
    const externalPaths = new Set(dirtyRecords.filter(file => ['engine', 'thruster', 'system'].includes(file.category)).map(file => {
      const path = file.path.toLowerCase().endsWith('.xml') ? file.path : `${file.path}.xml`;
      if (path.includes('/')) return path;
      return file.category === 'system' ? `systems/${path}` : `engine/${path}`;
    }));
    for (const file of modifiedXmlFiles) {
      if (file.startsWith('systems/') || file.startsWith('engine/')) externalPaths.add(file);
    }
    const writes = [...(mainDirty ? [target] : []), ...(serialXml !== null ? [serialTarget] : []),
      ...(pwmXml !== null ? [pwmTarget] : []),
      ...Array.from(externalPaths).map(path => `/mnt/sdcard/jsbsim/${path}`),
      ...packageFiles.map(file => `/mnt/sdcard/jsbsim/${file.path}`),
      ...assetFiles.map(file => `/mnt/sdcard/jsbsim/aircraft/${model}/${file.name}`)];
    if (!writes.length) {
      alert('当前没有需要写入仿真机的 XML 修改。');
      return;
    }
    if (!isRemoteUploadEnabled()) {
      alert(isZh ? '仿真机模型上传当前已关闭。请在「本地配置」中开启后再试。' : 'Model upload is disabled. Enable it in Local Settings first.');
      return;
    }
    try {
      if (externalPaths.size) {
        const [systems, engines] = await Promise.all([ftpListSystems(), ftpListEngines()]);
        const existing = new Set([
          ...systems.map(file => `systems/${String(file).replace(/^systems\//, '').replace(/^\/+/, '')}`),
          ...engines.map(file => `engine/${String(file).replace(/^engine\//, '').replace(/^\/+/, '')}`),
        ].map(path => path.toLowerCase()));
        const conflicts = Array.from(externalPaths).filter(path => existing.has(path.replace(/^\/+/, '').toLowerCase()));
        if (conflicts.length && !confirm(`检测到同名子文件：\n\n${conflicts.map(path => `  • /mnt/sdcard/jsbsim/${path}`).join('\n')}\n\n继续将覆盖这些文件。是否确认覆盖？`)) return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || '未知错误');
      // Do not continue when the preflight listing failed.  Continuing here
      // made a network outage look like a harmless name conflict and could
      // leave the upload half-completed on NuttX.
      const mode = getSimulatorTransportMode();
      const hint = mode === 'usb'
        ? '当前为 USB 模式：请检查 USB 文件服务是否响应，并确认没有其他程序占用设备；无需启动 FTP。'
        : mode === 'network'
          ? '当前为网络模式：请确认网络连接和 FTP 服务正常。'
          : '当前为自动模式：请检查 USB 文件服务或网络 FTP 连接。';
      alert(`无法读取仿真机现有子文件列表，已取消上传，未写入模型。\n\n${hint}\n${detail}`);
      return;
    }
    if (!confirm(`即将保存到仿真机。\n\n检测到的变更：\n${changes}\n\n本次实际写入：\n${writes.map(path => `  • ${path}`).join('\n')}\n\n已有文件将逐个比较并在覆盖前确认。确认继续吗？`)) return;
    setLoading(true);
    try {
      const current = useFlowStore.getState();
      const mainFile = (current.xmlFiles || []).find(file => file.category === 'main');
      const mainSource = originalMainXml(mainFile);
      let xml = mainSource;
      if (mainDirty) {
        if (!mainSource.trim()) {
          throw new Error('主 XML 原始源码缺失。为防止把子文件展开进主文件，本次上传已取消。请重新从仿真机加载模型。');
        }
        const ioXml = patchMainViztraUdpOutputs(
          patchMainIoAttributes(mainSource, current.nodes), current.nodes, savedRemoteNodes(model));
        xml = await patchInlineSerialLogic(
          serialHilChanged ? patchMainSerialHil(ioXml, current.nodes) : ioXml,
          current.nodes, current.edges);
      }
      const uploadedChildren = new Map<string, string>();
      for (const path of externalPaths) {
        const content = await buildChildUploadXml(current, path);
        uploadedChildren.set(path, content);
      }
      if (assetFiles.length) await checkModelAssets(assetSource, assetFiles.map(file => file.name));
      // Every local source must be ready before the first remote write.
      const written: string[] = [];
      const verified: string[] = [];
      if (mainDirty) {
        const result = await ftpUploadModel(model, xml);
        const remote = await ftpDownloadModel(model);
        if (comparableXml(remote.xml) !== comparableXml(xml)) throw new Error(`主模型回读不一致：${target}`);
        verified.push(target);
        if (result.uploaded) written.push(target);
      }
      if (serialXml !== null) {
        const result = await ftpUploadFile(serialPath, serialXml);
        const remote = await ftpDownloadXml(serialPath);
        if (comparableXml(remote.content) !== comparableXml(serialXml)) {
          throw new Error(`串口传感器 XML 回读不一致：${serialTarget}`);
        }
        verified.push(serialTarget);
        if (result.uploaded) written.push(serialTarget);
      }
      if (pwmXml !== null) {
        const result = await ftpUploadFile(pwmPath, pwmXml);
        const remote = await ftpDownloadXml(pwmPath);
        if (comparableXml(remote.content) !== comparableXml(pwmXml)) {
          throw new Error(`PWM 捕获 XML 回读不一致：${pwmTarget}`);
        }
        verified.push(pwmTarget);
        if (result.uploaded) written.push(pwmTarget);
      }
      for (const [path, content] of uploadedChildren) {
        const result = await ftpUploadFile(path, content);
        const remote = await ftpDownloadXml(path);
        if (comparableXml(remote.content) !== comparableXml(content)) throw new Error(`子文件回读不一致：/mnt/sdcard/jsbsim/${path}`);
        const fullPath = `/mnt/sdcard/jsbsim/${path}`;
        verified.push(fullPath);
        if (result.uploaded) written.push(fullPath);
      }
      for (const file of packageFiles) {
        const result = await ftpUploadFile(file.path, file.xml);
        const remote = await ftpDownloadXml(file.path);
        if (comparableXml(remote.content) !== comparableXml(file.xml)) throw new Error(`关联文件回读不一致：/mnt/sdcard/jsbsim/${file.path}`);
        const fullPath = `/mnt/sdcard/jsbsim/${file.path}`;
        verified.push(fullPath);
        if (result.uploaded) written.push(fullPath);
      }
      const xmlWritten = written.length;
      if (assetFiles.length) {
        const result = await ftpUploadModelAssets(assetSource, model, assetFiles.map(file => file.name));
        const expected = assetFiles.map(file => `/mnt/sdcard/jsbsim/aircraft/${model}/${file.name}`);
        if (JSON.stringify(result.files) !== JSON.stringify(expected)) throw new Error('模型资源上传结果与源目录不一致');
        verified.push(...result.files);
        written.push(...result.files);
      }
      // A pathname read can succeed while FAT directory enumeration is already
      // damaged. Check the same directory view that NSH's ls command uses.
      const directoryEntries = new Map<string, string[]>();
      for (const fullPath of verified) {
        const relative = fullPath.replace(/^\/mnt\/sdcard\/jsbsim\//, '');
        const separator = relative.lastIndexOf('/');
        if (separator < 0) throw new Error(`无法验证仿真机目录：${fullPath}`);
        const parent = relative.slice(0, separator);
        const name = relative.slice(separator + 1);
        if (!directoryEntries.has(parent)) {
          const listing = await listRemoteXmlParent(parent);
          if (!listing.exists) throw new Error(`仿真机目录不存在或目录项异常：/mnt/sdcard/jsbsim/${parent}`);
          directoryEntries.set(parent, listing.files);
        }
        const names = directoryEntries.get(parent)!;
        if (!names.includes(name)) {
          throw new Error(`文件回读成功，但目录列表中找不到 ${fullPath}；当前目录项：${names.join(', ') || '空'}。请停止写入 SD 并检查文件系统。`);
        }
      }
      useFlowStore.setState({ xmlFiles: (current.xmlFiles || []).map(file =>
        file.category === 'main'
          ? { ...file, originalXml: mainDirty ? xml : file.originalXml, currentXml: mainDirty ? xml : file.currentXml, dirty: false }
          : uploadedChildren.has(file.path)
            ? { ...file, originalXml: uploadedChildren.get(file.path)!, currentXml: uploadedChildren.get(file.path)!, dirty: false }
            : file
      ) });
      if (mainDirty) localStorage.setItem('jsbsim-raw-xml', xml);
      localStorage.setItem('jsbsim-remote-model', model);
      onAssignInstanceModel?.(activeInstance, model);
      localStorage.setItem(remoteBaselineKey(model), projectFingerprint({ aircraft: current.aircraft, nodes: current.nodes, edges: current.edges, subFiles: current.subFiles }));
      onSaveComplete?.(changesList);
      const status = written.length > 0
        ? `已写入 ${xmlWritten} 个 XML、${written.length - xmlWritten} 个资源文件并回读确认`
        : '仿真机上的文件与本地一致，本次未写入';
      onLog?.(`[${new Date().toLocaleTimeString()}] ${status}: ${verified.join(', ')}`);
      alert(`${status}：\n${verified.join('\n')}`);
    } catch (err: any) {
      alert(`保存到仿真机失败：${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  // Unload the model currently held by the editor and return to a blank
  // project. The simulator binding (jsbsim-remote-model) is deliberately kept
  // so the same model can be re-downloaded afterwards.
  const handleCloseModel = () => {
    const current = useFlowStore.getState();
    const dirtyPaths = (current.xmlFiles || []).filter(file => file.dirty).map(file => file.path);
    const changes = Array.from(new Set([...modifiedXmlFiles, ...dirtyPaths].filter(Boolean)));
    if (changes.length && !confirm(
      `当前模型存在未保存的修改：\n\n${changes.map(file => `  • ${file}`).join('\n')}\n\n关闭后会丢失这些修改。确认关闭吗？`
    )) return;
    const closedName = current.aircraft?.name || '';
    clearAll();
    // clearAll() only drops the canvas; the aircraft identity has to be reset
    // separately or the next save would still target the closed model.
    setAircraft({ name: 'New Aircraft', version: '2.0', release: 'PRODUCTION' });
    clearImportedSubFiles();
    localStorage.removeItem('jsbsim-project');
    localStorage.removeItem('jsbsim-raw-xml');
    localStorage.removeItem('jsbsim-reference-files');
    localStorage.removeItem('jsbsim-import-assets');
    localStorage.removeItem('jsbsim-import-directory');
    Object.keys(localStorage)
      .filter(key => key.startsWith('jsbsim-remote-baseline:'))
      .forEach(key => localStorage.removeItem(key));
    // App owns the dirty-file list; without this the closed model's pending
    // changes would leak into whatever is imported next.
    onSaveComplete?.();
    onLog?.(`[${new Date().toLocaleTimeString()}] 已关闭模型: ${closedName || '未命名'}`);
  };

  const handleLoad = async (requestedFilename?: string) => {
    const model = localStorage.getItem('jsbsim-remote-model') || aircraft.name || 'aircraft';
    const filename = requestedFilename || `${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}.project.json`;
      try {
        const data = await loadProjectApi(filename);
        if (data?.format !== 'jsbsim-model-project' || data?.version !== 3) {
          throw new Error('工程格式过旧或无效，请重新从模型 XML 创建 v3 工程');
        }
        const content = data.project || data;
      loadProject({ ...content, preserveLayout: true });
      clearImportedSubFiles();
      if (data.files?.main?.xml) localStorage.setItem('jsbsim-raw-xml', data.files.main.xml);
      if (data.files?.references) localStorage.setItem('jsbsim-reference-files', JSON.stringify(data.files.references));
      localStorage.setItem('jsbsim-import-assets', JSON.stringify(data.files?.assets || []));
      if (data.files?.assetSource) localStorage.setItem('jsbsim-import-directory', data.files.assetSource);
      else localStorage.removeItem('jsbsim-import-directory');
      if (data.model) localStorage.setItem('jsbsim-remote-model', data.model);
      if (data.userSettings) {
        localStorage.setItem('jsbsim-pinned-properties', JSON.stringify(data.userSettings.pinnedProperties || []));
        localStorage.setItem('jsbsim-unit-system', data.userSettings.unitSystem || 'imperial');
        localStorage.setItem('jsbsim-palette-collapsed', String(!!data.userSettings.paletteCollapsed));
        localStorage.setItem('jsbsim-palette-width', String(data.userSettings.paletteWidth || 250));
        localStorage.setItem('jsbsim-hud-position', JSON.stringify(data.userSettings.hudPosition || { x: 0, y: 0 }));
        localStorage.setItem('jsbsim-log-position', JSON.stringify(data.userSettings.logPosition || { x: 0, y: 0 }));
        window.dispatchEvent(new CustomEvent('jsbsim-project-settings-loaded', { detail: data.userSettings }));
      }
      const openedPath = data._projectPath || filename;
      rememberProject(filename, openedPath);
      alert(`工程已打开：\n${openedPath}`);
    } catch (err: any) {
      if (requestedFilename) {
        setRecentProjects(current => {
          const next = current.filter(item => item.filename !== requestedFilename);
          localStorage.setItem('jsbsim-recent-projects', JSON.stringify(next));
          return next;
        });
      }
      alert('加载失败: ' + err.message);
    }
  };

  const handleCopyXml = () => {
    navigator.clipboard.writeText(xmlContent);
  };

  const handleOpenRemoteModel = async (model: string, bindInstance = activeInstance) => {
    // The aircraft XML consists mostly of file references. Fetch the whole
    // reference tree before replacing the current canvas.
    const data = await withPwmCaptures(await withSerialSensors(await loadAircraft(model), model), model);
    clearAll();
    // Commit the selected directory before loadProject updates the parsed
    // display name, preventing a render from briefly reusing the prior model.
    localStorage.setItem('jsbsim-remote-model', model);
    // The file name and JSBSim's internal <fileheader> name are allowed to
    // differ (for example c172r.xml may contain the internal name c172).
    // The requested remote path is therefore the model identity; do not
    // reject a valid model just because those two names differ.
    loadProject(data);
    // Keep the remote directory ID as the launch target; the parsed XML may
    // expose a different human-readable fdm_config name.
    setLibrarySimulationModel(model);
    clearImportedSubFiles();
    // Keep a separate baseline for every aircraft. A single global baseline
    // makes switching c172x -> 737 look like a local edit and can upload the
    // previous aircraft into the newly selected aircraft directory.
    const snapshot = projectFingerprint(useFlowStore.getState());
    localStorage.setItem(remoteBaselineKey(model), snapshot);
    localStorage.setItem('jsbsim-project', snapshot);
    localStorage.setItem('jsbsim-raw-xml', data.sourceXml || '');
    localStorage.setItem('jsbsim-reference-files', JSON.stringify(data.referenceFiles || []));
    onAssignInstanceModel?.(bindInstance, model);
    onLog?.(`[${new Date().toLocaleTimeString()}] 已从 NuttX 加载模型: ${model}`);
  };

  const handleSelectInstance = async (id: string, binding?: string) => {
    if (loading || !onSelectInstance || !/^0[1-8]$/.test(id)) return;
    const model = binding ?? instanceSlots[id] ?? '';
    const currentModel = localStorage.getItem('jsbsim-remote-model') || loadedModelDirectory;
    const replacesCanvas = !model || model !== currentModel || !hasLoadedModel;
    if (replacesCanvas) {
      const current = useFlowStore.getState();
      const changes = Array.from(new Set([
        ...modifiedXmlFiles,
        ...(current.xmlFiles || []).filter(file => file.dirty).map(file => file.path),
      ].filter(Boolean)));
      if (changes.length && !confirm(`当前模型有未保存的修改：\n${changes.join('\n')}\n切换实例会丢弃这些修改。继续吗？`)) return;
      setLoading(true);
      try {
        if (model) {
          await handleOpenRemoteModel(model, id);
        } else {
          clearAll();
          setAircraft({ name: 'New Aircraft', version: '2.0', release: 'PRODUCTION' });
          localStorage.removeItem('jsbsim-remote-model');
          localStorage.removeItem('jsbsim-project');
          localStorage.removeItem('jsbsim-raw-xml');
          localStorage.removeItem('jsbsim-reference-files');
          localStorage.removeItem('jsbsim-import-assets');
          localStorage.removeItem('jsbsim-import-directory');
          setLibrarySimulationModel('');
        }
        onModelContextChange?.();
        onSaveComplete?.();
      } catch (error) {
        alert(`实例 ${id} 模型加载失败：${String(error)}`);
        return;
      } finally {
        setLoading(false);
      }
    }
    if (binding !== undefined) onAssignInstanceModel?.(id, binding);
    onSelectInstance(id);
    setShowInstanceMenu(false);
  };

  useEffect(() => {
    if (workspace !== 'editor' || !editorSwitchRequest) return;
    void handleSelectInstance(editorSwitchRequest).finally(() => onEditorSwitchHandled?.());
    // A request is issued only when returning from the multi-aircraft page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, editorSwitchRequest]);

  const openInstanceMenu = () => {
    setShowInstanceMenu(value => !value);
    if (!instanceModels.length) {
      void simListModels().then(items => {
        setInstanceModels([...new Set(items.map(item => String(item?.name || '')).filter(Boolean))].sort());
        setInstanceModelsError('');
      }).catch(error => setInstanceModelsError(String(error)));
    }
  };

  const syncRemoteModel = async (model: string, force: boolean): Promise<boolean> => {
    if (!isRemoteUploadEnabled()) {
      const current = useFlowStore.getState();
      const dirtyFiles = (current.xmlFiles || []).filter(file => file.dirty).map(file => file.path);
      const mainPath = (current.xmlFiles || []).find(file => file.category === 'main')?.path || `aircraft/${model}/${model}.xml`;
      const baseline = localStorage.getItem(remoteBaselineKey(model));
      if (baseline) {
        try {
          const previous = JSON.parse(baseline);
          if (serialSensorFingerprint(current) !== serialSensorFingerprint(previous)) {
            dirtyFiles.push(serialSensorPath(model));
          }
          if (pwmCaptureFingerprint(current) !== pwmCaptureFingerprint(previous)) {
            dirtyFiles.push(pwmCapturePath(model));
          }
          if (serialHilFingerprint(current) !== serialHilFingerprint(previous)) {
            dirtyFiles.push(mainPath);
          }
          if (mainIoFingerprint(current) !== mainIoFingerprint(previous)) {
            dirtyFiles.push(mainPath);
          }
        } catch { /* Existing XML dirty flags remain available for the warning. */ }
      } else {
        dirtyFiles.push(...modifiedXmlFiles);
        if (current.nodes.some(node => node.data?.componentType === 'serial_sensor')) {
          dirtyFiles.push(serialSensorPath(model));
        }
        if (current.nodes.some(node => node.data?.componentType === 'output' &&
          isViztraUdpType(node.data?.params?.type))) {
          dirtyFiles.push(mainPath);
        }
      }
      const changedPaths = Array.from(new Set(dirtyFiles));
      if (changedPaths.length && !force) {
        const list = `\n\n${changedPaths.map(path => `  • ${path}`).join('\n')}`;
        const error = new Error(isZh
          ? `本地模型修改尚未同步到仿真机${list}\n\n请在“本地配置”中开启“允许写入仿真机模型”，然后重新运行。`
          : `Local model changes are not synced to the simulator${list}\n\nEnable model uploads in Local Settings, then run again.`);
        error.name = 'ModelSyncRequiredError';
        throw error;
      }
      onLog?.(`[${new Date().toLocaleTimeString()}] 已保护模型文件，跳过上传到 NuttX: ${model}`);
      return false;
    }
    const current = useFlowStore.getState();
    const project = {
      aircraft: current.aircraft,
      nodes: current.nodes,
      edges: current.edges,
      subFiles: current.subFiles,
      xmlFiles: current.xmlFiles,
    };
    const sourceMain = (current.xmlFiles || []).find(file => file.category === 'main');
    const sourceDirectory = sourceMain?.path.match(/^aircraft\/([^/]+)\//)?.[1];
    if (sourceDirectory && sourceDirectory !== model) {
      throw new Error(`当前工程属于 ${sourceDirectory}，无法同步到 ${model}；请先加载对应模型。`);
    }
    if (!sourceMain && current.aircraft.name !== model) {
      throw new Error(`当前工程为 ${current.aircraft.name}，无法同步到 ${model}；请先加载对应模型。`);
    }
    const fingerprint = projectFingerprint(project);
    if (!force && localStorage.getItem(remoteBaselineKey(model)) === fingerprint) {
      onLog?.(`[${new Date().toLocaleTimeString()}] 未检测到本地修改，跳过 NuttX 模型同步`);
      return false;
    }
    const mainFile = (current.xmlFiles || []).find(file => file.category === 'main');
    const mainPath = mainFile?.path || `aircraft/${model}/${model}.xml`;
    let serialHilChanged = false;
    let mainIoChanged = false;
    try {
      const baseline = localStorage.getItem(remoteBaselineKey(model));
      if (baseline) {
        const previous = JSON.parse(baseline);
        serialHilChanged = serialHilFingerprint(current) !== serialHilFingerprint(previous);
        mainIoChanged = mainIoFingerprint(current) !== mainIoFingerprint(previous);
      }
    } catch { /* The tracked main-file dirty flag remains available. */ }
    const mainCandidate = serialHilChanged || mainIoChanged || !!mainFile?.dirty || modifiedXmlFiles.some(file =>
      file === `${model}.xml` || file.endsWith(`/${model}.xml`)
    );
    const mainSource = originalMainXml(mainFile);
    if (mainCandidate && !mainSource.trim()) {
      throw new Error('主 XML 原始源码缺失。为防止把子文件展开进主文件，本次同步已取消。请重新从仿真机加载模型。');
    }
    const candidateMainXml = mainCandidate
      ? serialHilChanged
        ? patchMainSerialHil(patchMainViztraUdpOutputs(patchMainIoAttributes(mainSource, current.nodes), current.nodes, savedRemoteNodes(model)), current.nodes)
        : patchMainViztraUdpOutputs(patchMainIoAttributes(mainSource, current.nodes), current.nodes, savedRemoteNodes(model))
      : mainSource;
    const childCandidates = (current.xmlFiles || []).filter(file => file.dirty && file.category !== 'main');
    const childContent = new Map<string, string>();
    for (const file of childCandidates) {
      childContent.set(file.path, await buildChildUploadXml(current, file.path));
    }
    const serialPath = serialSensorPath(model);
    const pwmPath = pwmCapturePath(model);
    let serialXml = serializeSerialSensors(current.nodes, current.edges);
    let pwmXml = serializePwmCaptures(current.nodes);
    try {
      const baseline = JSON.parse(localStorage.getItem(remoteBaselineKey(model)) || '{}');
      if (Array.isArray(baseline.nodes)) {
        if (serialXml === null && baseline.nodes.some((node: any) => node.data?.componentType === 'serial_sensor')) {
          serialXml = '<?xml version="1.0"?>\n<serial_outputs version="1"/>\n';
        }
        if (pwmXml === null && baseline.nodes.some((node: any) => node.data?.componentType === 'pwm_capture')) {
          pwmXml = '<?xml version="1.0"?>\n<pwm_inputs version="1"/>\n';
        }
      }
    } catch { /* No usable baseline: leave unrelated remote sidecars untouched. */ }
    const candidatePaths = Array.from(new Set([
      ...(mainCandidate ? [mainPath] : []),
      ...childCandidates.map(file => file.path),
      ...(serialXml !== null ? [serialPath] : []),
      ...(pwmXml !== null ? [pwmPath] : []),
    ]));
    const unchangedPaths: string[] = [];
    const pendingFiles: string[] = [];
    for (const path of candidatePaths) {
      const localContent = path === mainPath
        ? candidateMainXml
        : path === serialPath ? serialXml || ''
          : path === pwmPath ? pwmXml || '' : childContent.get(path) || '';
      if (!localContent.trim()) {
        pendingFiles.push(path);
        continue;
      }
      try {
        const remote = await ftpDownloadXml(path);
        if (comparableXml(localContent) === comparableXml(remote.content)) unchangedPaths.push(path);
        else pendingFiles.push(path);
      } catch {
        // A missing remote file is a real upload candidate. A transient FTP
        // failure is reported again by the review/upload path and must never
        // be interpreted as equality.
        pendingFiles.push(path);
      }
    }
    if (unchangedPaths.length) {
      const unchanged = new Set(unchangedPaths);
      useFlowStore.setState({ xmlFiles: (current.xmlFiles || []).map(file => unchanged.has(file.path) ? { ...file, dirty: false } : file) });
      onSaveComplete?.(unchangedPaths);
    }
    const mainDirty = pendingFiles.includes(mainPath);
    const changedFiles = childCandidates.filter(file => pendingFiles.includes(file.path));
    if (!pendingFiles.length) {
      const cleanProject = {
        ...project,
        xmlFiles: (project.xmlFiles || []).map(file => unchangedPaths.includes(file.path) ? { ...file, dirty: false } : file),
      };
      localStorage.setItem(remoteBaselineKey(model), projectFingerprint(cleanProject));
      onLog?.(`[${new Date().toLocaleTimeString()}] 本机 XML 与仿真机一致，跳过上传`);
      return false;
    }
    if (pendingFiles.length > 0) {
      const isZh = !/^en(?:-|$)/i.test(navigator.language || '');
      const fileList = pendingFiles.map(file => `  • ${file}`).join('\n');
      const reviewMessage = isZh
        ? `检测到本次将上传的 XML 文件：\n\n${fileList}\n\n是否先打开 XML 源码浏览器进行审查？\n确定=打开审查，取消=直接进入覆盖确认。`
        : `The following XML files will be uploaded:\n\n${fileList}\n\nOpen the XML Source Browser for review first?\nOK = review, Cancel = go directly to overwrite confirmation.`;
      if (window.confirm(reviewMessage)) {
        const documents = pendingFiles.map(path => {
          const tracked = (current.xmlFiles || []).find(file => file.path === path);
          return {
            path,
            content: path === mainPath
              ? candidateMainXml
              : path === serialPath ? serialXml || ''
                : path === pwmPath ? pwmXml || '' : childContent.get(path) || '',
            category: tracked?.category,
            dirty: tracked?.dirty,
          };
        }).filter(file => file.content.trim());
        if (documents.length) {
          await new Promise<void>(resolve => {
            setUploadReview({ documents, resolve });
            setShowXmlSourceBrowser(false);
          });
        }
      }
      const message = isZh
        ? `检测到本地修改，点击“确定”后将上传以下文件到仿真机：\n\n${fileList}\n\n上传后会覆盖仿真机对应文件，是否继续？`
        : `Local changes detected. The following files will be uploaded to the simulator:\n\n${fileList}\n\nExisting simulator files may be overwritten. Continue?`;
      if (!window.confirm(message)) {
        const error = new Error(`已取消上传，${model} 的本地修改尚未同步到仿真机。`);
        error.name = 'ModelSyncCancelledError';
        throw error;
      }
    }
    let uploadedMainXml = candidateMainXml;
    let uploaded = false;

    // Starting a simulation must not regenerate the aircraft merely because
    // layout/subfile state changed.  Regeneration expands file-backed top-level
    // sections (Metrics/Mass/Propulsion/Aero) and child thruster tables into the
    // main XML.  Only rebuild when the main file itself was edited.  A forced
    // sync of an unchanged model sends the original complete XML verbatim.
    if (mainDirty) {
      await ftpUploadModel(model, uploadedMainXml);
      uploaded = true;
    } else if (force && uploadedMainXml.trim()) {
      await ftpUploadModel(model, uploadedMainXml);
      uploaded = true;
    }
    for (const file of changedFiles) {
      const content = childContent.get(file.path);
      if (!content?.trim()) throw new Error(`子文件 ${file.path} 的安全补丁为空，已取消上传。`);
      await ftpUploadFile(file.path, content);
      uploaded = true;
    }
    if (serialXml !== null && pendingFiles.includes(serialPath)) {
      await ftpUploadFile(serialPath, serialXml);
      const remote = await ftpDownloadXml(serialPath);
      if (comparableXml(remote.content) !== comparableXml(serialXml)) {
        throw new Error(`串口传感器 XML 回读不一致：/mnt/sdcard/jsbsim/${serialPath}`);
      }
      uploaded = true;
    }
    if (pwmXml !== null && pendingFiles.includes(pwmPath)) {
      await ftpUploadFile(pwmPath, pwmXml);
      const remote = await ftpDownloadXml(pwmPath);
      if (comparableXml(remote.content) !== comparableXml(pwmXml)) {
        throw new Error(`PWM 捕获 XML 回读不一致：/mnt/sdcard/jsbsim/${pwmPath}`);
      }
      uploaded = true;
    }
    useFlowStore.setState({ xmlFiles: (current.xmlFiles || []).map(file =>
      file.category === 'main'
        ? {
            ...file,
            originalXml: mainDirty && uploadedMainXml ? uploadedMainXml : file.originalXml,
            currentXml: mainDirty && uploadedMainXml ? uploadedMainXml : file.currentXml,
            dirty: mainDirty ? false : file.dirty,
          }
        : childContent.has(file.path) && pendingFiles.includes(file.path)
          ? { ...file, originalXml: childContent.get(file.path)!, currentXml: childContent.get(file.path)!, dirty: false }
          : unchangedPaths.includes(file.path) ? { ...file, dirty: false } : file
    ) });
    if (uploadedMainXml.trim()) localStorage.setItem('jsbsim-raw-xml', uploadedMainXml);
    localStorage.setItem('jsbsim-remote-model', model);
    localStorage.setItem(remoteBaselineKey(model), fingerprint);
    onSaveComplete?.(pendingFiles);
    onLog?.(`[${new Date().toLocaleTimeString()}] ${uploaded ? '已同步模型变更到' : '主模型未修改，跳过写入'} NuttX: ${model}`);
    return uploaded;
  };

  const handleSyncRemoteModel = (model: string) => syncRemoteModel(model, false);
  const handleForceSyncRemoteModel = async (model: string) => {
    if (!isRemoteUploadEnabled()) {
      onLog?.(`[${new Date().toLocaleTimeString()}] 模型上传保护已启用，未修改 NuttX 文件: ${model}`);
      return;
    }
    await syncRemoteModel(model, true);
  };

  const handleDownloadXml = () => {
    const blob = new Blob([xmlContent], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${aircraft.name.replace(/\s+/g, '_')}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="toolbar" style={{ backgroundColor: toolbarBackground(toolbarAppearance) }} data-tauri-drag-region onPointerDown={event => { void startWindowDrag(event); }}>
        <div className="toolbar-left" data-tauri-drag-region>
        </div>
        <div className="toolbar-center" data-tauri-drag-region>
          <div className="file-menu-anchor" ref={workspaceMenuRef}>
            <button type="button" className={`file-menu-trigger workspace-menu-trigger ${showWorkspaceMenu ? 'active' : ''}`}
              title={isZh ? '工作区' : 'Workspace'} aria-label={isZh ? '工作区菜单' : 'Workspace menu'}
              aria-haspopup="menu" aria-expanded={showWorkspaceMenu}
              onClick={() => setShowWorkspaceMenu(value => !value)}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><rect x="11.5" y="11.5" width="6" height="6" rx="1"/></svg>
            </button>
            {showWorkspaceMenu && <div className="file-menu-dropdown workspace-menu-dropdown" role="menu">
              <button role="menuitem" onClick={() => { onSelectWorkspace?.('editor'); setShowWorkspaceMenu(false); }}>✎ {isZh ? '模型编辑' : 'Model Editor'}{workspace === 'editor' ? ' ✓' : ''}</button>
              <button role="menuitem" onClick={() => { onSelectWorkspace?.('multi'); setShowWorkspaceMenu(false); }}>◫ {isZh ? '多机仿真' : 'Multi-Aircraft'}{workspace === 'multi' ? ' ✓' : ''}</button>
              <button role="menuitem" onClick={() => { onShowLogCenter?.(); setShowWorkspaceMenu(false); }}>▤ {isZh ? '日志中心' : 'Log Center'}</button>
            </div>}
          </div>
          {workspace === 'editor' && <div className="file-menu-anchor" ref={instanceMenuRef}>
            <button type="button" className={`file-menu-trigger editor-instance-trigger ${showInstanceMenu ? 'active' : ''}`}
              aria-label={`${instanceSlots[activeInstance] || (isZh ? '未绑定模型' : 'No model assigned')}，编辑实例 ${activeInstance}`} aria-haspopup="menu" aria-expanded={showInstanceMenu}
              title={isZh ? '切换当前编辑的仿真实例' : 'Switch edited aircraft instance'}
              onClick={openInstanceMenu}>
              <span className="editor-instance-model">{instanceSlots[activeInstance] || (isZh ? '未绑定模型' : 'No model assigned')}</span>
              <span className="file-menu-caret" aria-hidden="true">▾</span>
            </button>
            {showInstanceMenu && <div className="file-menu-dropdown editor-instance-dropdown" role="menu">
              <div className="file-menu-section-title">{isZh ? '切换编辑实例' : 'Edit instance'}</div>
              {fleetSlotIds(instanceSlots).map(id =>
                <button key={id} type="button" role="menuitem" className={activeInstance === id ? 'editor-instance-selected' : ''}
                  disabled={loading} onClick={() => void handleSelectInstance(id)}>
                  <strong>{id}</strong><span>{instanceSlots[id] || (isZh ? '未绑定模型' : 'No model assigned')}</span>{activeInstance === id && <b>✓</b>}
                </button>)}
              <div className="file-menu-separator" />
              <label className="editor-instance-assign">
                <span>{isZh ? `实例 ${activeInstance} 绑定模型` : `Assign model to ${activeInstance}`}</span>
                <select aria-label={`实例 ${activeInstance} 绑定模型`} value={instanceSlots[activeInstance] || ''}
                  disabled={loading} onChange={event => { if (event.target.value) void handleSelectInstance(activeInstance, event.target.value); }}>
                  <option value="">{isZh ? '选择仿真机模型' : 'Select simulator model'}</option>
                  {instanceSlots[activeInstance] && !instanceModels.includes(instanceSlots[activeInstance]) &&
                    <option value={instanceSlots[activeInstance]}>{instanceSlots[activeInstance]}</option>}
                  {instanceModels.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              {instanceModelsError && <small className="editor-instance-error">{instanceModelsError}</small>}
              <button type="button" role="menuitem" onClick={() => { onSelectWorkspace?.('multi'); setShowInstanceMenu(false); }}>
                {isZh ? '打开多机仿真配置' : 'Open multi-aircraft setup'}
              </button>
            </div>}
          </div>}
          <div className="file-menu-anchor" ref={fileMenuRef}>
            <button
              className={`file-menu-trigger ${showFileMenu ? 'active' : ''}`}
              onClick={() => setShowFileMenu(value => !value)}
              disabled={loading}
              aria-haspopup="menu"
              aria-expanded={showFileMenu}
            >
              📁 {isZh ? '文件' : 'File'} <span className="file-menu-caret" aria-hidden="true">▾</span>
            </button>
            {showFileMenu && (
              <div className="file-menu-dropdown" role="menu">
                <button role="menuitem" onClick={() => {
                  clearAll();
                  localStorage.removeItem('jsbsim-project');
                  localStorage.removeItem('jsbsim-raw-xml');
                  Object.keys(localStorage).filter(k => k.startsWith('jsbsim-remote-baseline:')).forEach(k => localStorage.removeItem(k));
                  setShowFileMenu(false);
                }}>📄 {isZh ? '新建' : 'New'}</button>
                <button role="menuitem" onClick={() => { setShowWizard(true); setShowFileMenu(false); }}>🪄 {isZh ? '创建向导' : 'New Wizard'}</button>
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => { void handleSave(); setShowFileMenu(false); }}>💾 {isZh ? '保存' : 'Save'}</button>
                <button role="menuitem" onClick={() => { void handleSaveToSimulator(); setShowFileMenu(false); }}>🛰️ {isZh ? '保存到仿真机' : 'Save to Simulator'}</button>
                <button role="menuitem" onClick={() => { void handleLoad(); setShowFileMenu(false); }}>📂 {isZh ? '打开工程' : 'Open Project'}</button>
                {recentProjects.length > 0 && <>
                  <div className="file-menu-separator" />
                  <div className="file-menu-section-title">{isZh ? '最近打开的工程' : 'Recent Projects'}</div>
                  {recentProjects.map(project => <button key={project.filename} role="menuitem" className="recent-project-item" title={project.path} onClick={() => { void handleLoad(project.filename); setShowFileMenu(false); }}>
                    <span>↗ {project.filename}</span><small>{project.path}</small>
                  </button>)}
                </>}
                <div className="file-menu-separator" />
                <button role="menuitem" disabled={!hasLoadedModel} onClick={() => { handleCloseModel(); setShowFileMenu(false); }} title={isZh ? '关闭当前已加载的模型，回到空白工程（保留仿真机模型绑定）' : 'Close the loaded model (keeps the simulator binding)'}>✖️ {isZh ? '关闭模型' : 'Close Model'}</button>
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => void beginModelImport(false)} title={isZh ? '选择主模型，自动扫描同目录及子目录 XML' : 'Select main XML and scan sibling XML files'}>📥 {isZh ? '导入 XML（自动关联同目录）' : 'Import XML with siblings'}</button>
                <button role="menuitem" onClick={() => void beginModelImport(true)} title={isZh ? '扫描整个模型目录，自动保留目录结构' : 'Scan an XML directory'}>📂 {isZh ? '导入 XML 目录' : 'Import XML folder'}</button>
                <button role="menuitem" onClick={() => { void handleExportXml(); setShowFileMenu(false); }}>📤 {isZh ? '导出 XML' : 'Export XML'}</button>
                <button role="menuitem" disabled={!xmlSourceDocuments.length} onClick={() => { setShowXmlSourceBrowser(true); setShowFileMenu(false); }}>🧾 {isZh ? 'XML 源码浏览器' : 'XML Source Browser'}</button>
              </div>
            )}
          </div>
          <div className="file-menu-anchor" ref={editMenuRef}>
            <button className={`file-menu-trigger ${showEditMenu ? 'active' : ''}`}
              onClick={() => setShowEditMenu(value => !value)} aria-haspopup="menu" aria-expanded={showEditMenu}>
              ✏️ {isZh ? '编辑' : 'Edit'} <span className="file-menu-caret" aria-hidden="true">▾</span>
            </button>
            {showEditMenu && (
              <div className="file-menu-dropdown" role="menu">
                <button role="menuitem" onClick={() => { onUndo?.(); setShowEditMenu(false); }}>↶ {isZh ? '撤销' : 'Undo'} <kbd>Ctrl+Z</kbd></button>
                <button role="menuitem" onClick={() => { onRedo?.(); setShowEditMenu(false); }}>↷ {isZh ? '恢复' : 'Redo'} <kbd>Ctrl+Y</kbd></button>
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => { onCopy?.(); setShowEditMenu(false); }}>📋 {isZh ? '复制' : 'Copy'} <kbd>Ctrl+C</kbd></button>
                <button role="menuitem" onClick={() => { onPaste?.(); setShowEditMenu(false); }}>📄 {isZh ? '粘贴' : 'Paste'} <kbd>Ctrl+V</kbd></button>
              </div>
            )}
          </div>
          <div className="file-menu-anchor" ref={displayMenuRef}>
            <button className={`file-menu-trigger ${showDisplayMenu ? 'active' : ''}`} onClick={() => setShowDisplayMenu(value => !value)} aria-haspopup="menu" aria-expanded={showDisplayMenu}>
              👁️ {isZh ? '显示' : 'View'} <span className="file-menu-caret" aria-hidden="true">▾</span>
            </button>
            {showDisplayMenu && <div className="file-menu-dropdown" role="menu">
              <button role="menuitem" onClick={() => { onToggleHud?.(); setShowDisplayMenu(false); }}>🛩️ HUD {hudVisible ? (isZh ? '✓ 已显示' : '✓ Shown') : (isZh ? '已隐藏' : 'Hidden')}</button>
              <button role="menuitem" onClick={() => { onToggleJsbsimLog?.(); setShowDisplayMenu(false); }}>🖥️ {isZh ? 'JSBSim 信息' : 'JSBSim Console'}{jsbsimLogs.length ? ` (${jsbsimLogs.length})` : ''}</button>
              <button role="menuitem" onClick={() => { onShow3D?.(); setShowDisplayMenu(false); }}>🛩️ 3D</button>
            </div>}
          </div>
          <div className="file-menu-anchor" ref={toolsMenuRef}>
            <TelemetryRecorder open={showTelemetryRecorder} onClose={() => setShowTelemetryRecorder(false)} onRecordingChange={setTelemetryRecording} />
            <button className={`file-menu-trigger ${showToolsMenu ? 'active' : ''}`} onClick={() => setShowToolsMenu(value => !value)} aria-haspopup="menu" aria-expanded={showToolsMenu}>
              {telemetryRecording ? '🔴' : '🧰'} {isZh ? '工具' : 'Tools'} <span className="file-menu-caret" aria-hidden="true">▾</span>
            </button>
            {showToolsMenu && <div className="file-menu-dropdown" role="menu">
              <button role="menuitem" disabled={plotJugglerOpening} onClick={() => void openPlotJuggler()}>📈 PlotJuggler · {isZh ? '实时曲线' : 'Live'}</button>
              <button role="menuitem" className="telemetry-record-menuitem" onClick={() => { setShowTelemetryRecorder(true); setShowToolsMenu(false); }}>● {isZh ? '遥测记录' : 'Telemetry Recording'}{telemetryRecording ? (isZh ? ' · 记录中' : ' · Recording') : ''}</button>
              <button role="menuitem" onClick={() => { setShowUsbFiles(true); setShowToolsMenu(false); }}>🗂 {isZh ? '仿真机文件管理' : 'Simulator Files'}</button>
              <button role="menuitem" onClick={() => { setShowNshConsole(true); setShowToolsMenu(false); }}>⌨ {isZh ? 'NuttX NSH 控制台' : 'NuttX NSH Console'}</button>
              <button role="menuitem" onClick={() => { setShowSerialAssistant(true); setShowToolsMenu(false); }}>⌁ {isZh ? '串口助手（本机）' : 'Serial Assistant (Local)'}</button>
              <div className="file-menu-separator" />
              <button role="menuitem" onClick={() => { setShowJ23Guide(true); setShowToolsMenu(false); }}>📖 {isZh ? '使用说明' : 'User Guide'}</button>
            </div>}
          </div>
          <button onClick={() => setShowLibrary(true)} disabled={loading}>📚 {isZh ? '模型库' : 'Models'}</button>
          <button onClick={() => setShowSimulationConfig(true)} disabled={loading || !instanceSlots[activeInstance]} title={!instanceSlots[activeInstance] ? (isZh ? '先给当前实例绑定模型' : 'Assign a model to this instance first') : undefined}>⚙ {isZh ? '仿真配置' : 'Simulation'}</button>
          <button onClick={() => setShowLocalSettings(true)} title={isZh ? '本地配置' : 'Local Settings'} aria-label={isZh ? '本地配置' : 'Local Settings'}>🔧 {isZh ? '本地' : 'Settings'}</button>
          {workspace === 'editor' && activeInstance === '01' ? <SimMenu loading={loading} onLog={onLog}
            onOpenRemoteModel={handleOpenRemoteModel}
            onSyncRemoteModel={handleSyncRemoteModel}
            // aircraft.name is the XML's display name (for example
            // "OV10 Bronco"), while the simulator needs the model directory
            // ID ("OV10"). Keep the library selection as the authoritative
            // launch target when a model has been loaded.
            selectedModelFromLibrary={librarySimulationModel || remoteModelDirectory || loadedModelDirectory || (hasLoadedModel ? aircraft.name : '')} />
            : workspace === 'multi' ? <SimMenu statusOnly onLog={onLog} fleetControls={fleetControls} />
            : <button type="button" onClick={() => onSelectWorkspace?.('multi')}>{isZh ? '多机控制' : 'Fleet Controls'}</button>}
        </div>
        {showNshConsole && <NshConsoleDialog onClose={() => setShowNshConsole(false)} />}
        {showUsbFiles && <UsbFileManager onClose={() => setShowUsbFiles(false)} />}
        <div className="toolbar-right">
          {isTauri && <div className="window-controls" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
            <button onClick={() => void windowAction('min')} title={isZh ? '最小化' : 'Minimize'} aria-label={isZh ? '最小化' : 'Minimize'}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10" /></svg></button>
            <button onClick={() => void windowAction('max')} title={isZh ? '最大化/还原' : 'Maximize/Restore'} aria-label={isZh ? '最大化或还原' : 'Maximize or restore'}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1" /></svg></button>
            <button className="window-close" onClick={() => void windowAction('close')} title={isZh ? '关闭' : 'Close'} aria-label={isZh ? '关闭' : 'Close'}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
          </div>}
          <input ref={fileInputRef} type="file" accept=".xml" multiple onChange={handleImportXml} style={{ display: 'none' }} />
          <input ref={directoryInputRef} type="file" accept=".xml" multiple onChange={handleImportXml} style={{ display: 'none' }} {...({ webkitdirectory: '', directory: '' } as any)} />
        </div>
      </div>

      {showSerialAssistant && <SerialAssistantDialog onClose={() => setShowSerialAssistant(false)} />}
      {showSimulationConfig && <SimulationConfigDialog key={`${activeInstance}:${instanceSlots[activeInstance]}`}
        instanceId={activeInstance} model={instanceSlots[activeInstance]} slots={instanceSlots}
        onSelectInstance={id => workspace === 'multi' ? onSelectMultiInstance?.(id) : handleSelectInstance(id)}
        onClose={() => setShowSimulationConfig(false)} />}
      {showLocalSettings && <LocalSettingsDialog onClose={() => setShowLocalSettings(false)} toolbarAppearance={toolbarAppearance} onToolbarAppearanceChange={updateToolbarAppearance} />}
      {showJ23Guide && <J23GuideDialog onClose={() => setShowJ23Guide(false)} />}

      {showXmlSourceBrowser && <XmlSourceBrowser documents={xmlSourceDocuments} loadRemoteContent={loadRemoteXmlForReview} onClose={() => setShowXmlSourceBrowser(false)} />}
      {uploadReview && <XmlSourceBrowser documents={uploadReview.documents} initialPath={uploadReview.documents[0]?.path} loadRemoteContent={loadRemoteXmlForReview} onClose={() => {
        const resolve = uploadReview.resolve;
        setUploadReview(null);
        resolve();
      }} />}

      {showXml && (
        <div className="xml-modal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) setShowXml(false); }}>
          <div className="xml-modal" onClick={e => e.stopPropagation()}>
            <div className="xml-modal-header">
              <h3>生成的 JSBSim XML</h3>
              <div className="xml-modal-actions">
                <button onClick={handleCopyXml}>📋 复制</button>
                <button onClick={handleDownloadXml}>💾 下载</button>
                <button onClick={() => setShowXml(false)}>✖ 关闭</button>
              </div>
            </div>
            <textarea className="xml-content" readOnly value={xmlContent} />
          </div>
        </div>
      )}

      {pendingImport && (
        <div className="model-import-overlay" role="dialog" aria-labelledby="model-import-title">
          <div className="model-import-dialog">
            <header>
              <div>
                <strong id="model-import-title">{isZh ? '导入模型确认' : 'Confirm model import'}</strong>
                <small>{isZh ? `主模型：${pendingImport.mainFileName}` : `Main model: ${pendingImport.mainFileName}`}</small>
              </div>
              <button aria-label={isZh ? '取消导入' : 'Cancel import'} onClick={() => setPendingImport(null)}>×</button>
            </header>
            <div className="model-import-body">
              {pendingImport.sourceDirectory && <p className="model-import-selection-note">已扫描目录：{pendingImport.sourceDirectory}（含子目录，仅 XML）</p>}
              <p>{isZh
                ? '模型目录名将用于仿真机路径，并可同步写回主 XML 的 <fdm_config name>。'
                : 'The model directory name is used for simulator paths and can be written back to <fdm_config name>.'}</p>
              <p>{isZh
                ? '此步骤只把模型导入上位机；要写入 SD 卡，还需在文件菜单选择「保存到仿真机」，并等待回读确认。'
                : 'This step imports the model into the editor. Use “Save to Simulator” afterward and wait for readback verification to write the SD card.'}</p>
              <label className="model-import-name">
                <span>{isZh ? '模型目录名 / fdm_config 名称' : 'Model directory / fdm_config name'}</span>
                <input autoFocus value={pendingImport.modelName} maxLength={80} spellCheck={false}
                  onChange={event => setPendingImport(current => current ? { ...current, modelName: event.target.value } : current)} />
                <small>{isZh ? '允许：字母、数字、点、下划线、连字符。保存到仿真机时将使用此名称。' : 'Letters, digits, dots, underscores and hyphens only. This name is used when saving to the simulator.'}</small>
              </label>
              <label className="model-import-check">
                <input type="checkbox" checked={pendingImport.renameFdmConfig}
                  onChange={event => setPendingImport(current => current ? { ...current, renameFdmConfig: event.target.checked } : current)} />
                <span>{isZh ? '重命名主 XML 的 fdm_config name 属性' : 'Rename the main XML fdm_config name attribute'}</span>
              </label>
              {pendingImport.originalModelName && pendingImport.originalModelName !== pendingImport.modelName && (
                <div className="model-import-rename-note">
                  {isZh ? `检测到原名称 “${pendingImport.originalModelName}”。确认后将${pendingImport.renameFdmConfig ? `改为 “${pendingImport.modelName || '…'}”` : '保留原名称'}。` :
                    `Detected original name “${pendingImport.originalModelName}”. It will ${pendingImport.renameFdmConfig ? `be changed to “${pendingImport.modelName || '…'}”` : 'be retained'}.`}
                </div>
              )}
              <section className="model-import-associated">
                <div>
                  <strong>{isZh ? `确认 ${pendingImport.referenceFiles.length + 1} 个 XML 的文件类型` : `Confirm types for ${pendingImport.referenceFiles.length + 1} XML file(s)`}</strong>
                  <small>{isZh ? '初始化文件会与模型一并保留；可在导入前逐项核对或调整关联文件类型。' : 'Initialization files are retained with the model; review or adjust every associated XML type before importing.'}</small>
                  <small>检测到 {pendingImport.referenceFiles.filter(file => file.category === 'initialization').length} 个初始化/重置 XML，确认后与模型关联保存。</small>
                  {pendingImport.assets.length > 0 && <small>另有 {pendingImport.assets.length} 个模型资源文件（例如 .ac、图片），保存到仿真机时会一并上传。</small>}
                </div>
                {!pendingImport.fromDirectory && <p className="model-import-selection-note">{isZh
                  ? '当前是文件选择：上位机只能读取你选中的 XML。若要同时导入同目录的 initfile.xml、reset.xml，请取消后选择「导入 XML 目录」。'
                  : 'Only selected XML files are available. To include initfile.xml and reset.xml from the same folder, cancel and choose “Import XML folder”.'}</p>}
                <ul>
                  <li className="main-file">🛩️ <span>{pendingImport.mainFileName}</span><em>{importCategoryLabel('main', isZh)}</em></li>
                  {pendingImport.referenceFiles.map((file, index) => <li key={file.name}>
                    <span className="model-import-file-icon">{file.category === 'initialization' ? '🎯' : file.category === 'model-config' ? '⚙️' : file.category === 'system' ? '🔗' : file.category === 'engine' ? '⚙️' : '📄'}</span>
                    <span>{file.name}</span>
                    <select aria-label={`${file.name} 文件类型`} value={file.category} onChange={event => setPendingImport(current => current ? {
                      ...current,
                      referenceFiles: current.referenceFiles.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, category: event.target.value as ImportFileCategory } : candidate),
                    } : current)}>
                      <option value="initialization">{importCategoryLabel('initialization', isZh)}</option>
                      <option value="model-config">{importCategoryLabel('model-config', isZh)}</option>
                      <option value="system">{importCategoryLabel('system', isZh)}</option>
                      <option value="engine">{importCategoryLabel('engine', isZh)}</option>
                      <option value="companion">{importCategoryLabel('companion', isZh)}</option>
                    </select>
                  </li>)}
                </ul>
              </section>
            </div>
            <footer>
              <button className="secondary" onClick={() => setPendingImport(null)}>{isZh ? '取消' : 'Cancel'}</button>
              <button disabled={!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pendingImport.modelName.trim()) || loading}
                onClick={() => void commitModelImport(pendingImport)}>{isZh ? '确认并导入' : 'Confirm and import'}</button>
            </footer>
          </div>
        </div>
      )}

      {importedSubFiles.length > 0 && (
        <div className="xml-import-files-overlay" role="dialog" aria-label="影响的 XML 子文件" onClick={event => event.stopPropagation()}>
          <div className="xml-import-files-dialog" onClick={event => event.stopPropagation()}>
            <header><strong>📂 影响的 XML 子文件</strong><button onClick={event => { event.preventDefault(); event.stopPropagation(); clearImportedSubFiles(); }}>×</button></header>
            <small>共 {importedSubFiles.length} 个关联/引用文件；已关联 {importedSubFiles.filter(file => file.category === 'initialization').length} 个初始化/重置 XML</small>
            {!importedSubFiles.some(file => file.category === 'initialization') && <p className="model-import-selection-note">本次未关联任何初始化/重置 XML。请检查所选目录是否包含以 &lt;initialize&gt; 为根标签的文件。</p>}
            <ul>{importedSubFiles.map(file => <li key={file.name}>{file.category === 'initialization' ? '🎯' : file.category === 'model-config' ? '⚙️' : file.category === 'system' ? '🔗' : file.category === 'engine' ? '⚙️' : '📄'} {file.name} <em>{file.category === 'initialization' ? '初始化/重置' : file.category === 'model-config' ? '模型配置' : file.category === 'system' ? '系统' : file.category === 'engine' ? '发动机/螺旋桨' : file.referenced ? '已引用' : '关联文件'}</em></li>)}</ul>
            <footer><button onClick={event => { event.preventDefault(); event.stopPropagation(); clearImportedSubFiles(); }}>确认关闭</button></footer>
          </div>
        </div>
      )}

      {showWizard && (
        <AircraftWizard
          onClose={() => setShowWizard(false)}
          onGenerate={async (xml) => {
            try {
              const data = await parseXml(xml);
              loadProject(data);
              setShowWizard(false);
            } catch (err: any) {
              showXmlDiagnostic(err, 'XML 导入失败');
            }
          }}
        />
      )}

      {showLibrary && (
        <AircraftLibrary
          onClose={() => setShowLibrary(false)}
          initialTab={workspace === 'multi' ? 'fleet' : 'models'}
          currentFleetSlots={instanceSlots}
          currentFleetInitialOverrides={initialOverrides}
          currentFleetNetworkOverrides={networkOverrides}
          onLoadFleetGroup={(group) => {
            if (onLoadFleetGroup?.(group) === false) return false;
            onSelectWorkspace?.('multi');
            onLog?.(`[${new Date().toLocaleTimeString()}] 已从模型库载入多机模型组：${Object.values(group.slots).filter(Boolean).length} 架`);
            return true;
          }}
          onLoad={async (loaded, signal) => {
            const modelName = String(loaded?.model || loaded?.aircraft?.name || '').trim();
            const data = modelName ? await withPwmCaptures(await withSerialSensors(loaded, modelName), modelName) : loaded;
            if (signal.aborted) return;
            loadProject(data);
            if (data.sourceXml) localStorage.setItem('jsbsim-raw-xml', data.sourceXml);
            if (data.referenceFiles) localStorage.setItem('jsbsim-reference-files', JSON.stringify(data.referenceFiles));
            localStorage.removeItem('jsbsim-import-assets');
            localStorage.removeItem('jsbsim-import-directory');
            const loadedModel = String(data?.model || data?.aircraft?.name || '').trim();
            if (loadedModel) {
              setLibrarySimulationModel(loadedModel);
              localStorage.setItem('jsbsim-remote-model', loadedModel);
              onAssignInstanceModel?.(activeInstance, loadedModel);
              if (data.sourceXml) localStorage.setItem(remoteBaselineKey(loadedModel), projectFingerprint(useFlowStore.getState()));
            }
            // Persist to localStorage
            try {
              localStorage.setItem('jsbsim-project', projectFingerprint(useFlowStore.getState()));
              localStorage.setItem('jsbsim-cache-version', '2');
            } catch (e) { /* ignore */ }
          }}
          onSelectForSimulation={(model) => {
            setLibrarySimulationModel(model);
            onLog?.(`[${new Date().toLocaleTimeString()}] 已从模型库选择待运行模型: ${model}`);
          }}
          onSelectScriptForSimulation={(script) => {
            window.dispatchEvent(new CustomEvent('jsbsim-library-script-selected', { detail: { path: script, openEditor: true } }));
            onLog?.(`[${new Date().toLocaleTimeString()}] 已从脚本库选择待运行脚本: ${script}`);
          }}
        />
      )}
    </>
  );
}
