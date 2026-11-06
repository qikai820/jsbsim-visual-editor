import { useEffect, useRef, useState } from 'react';
import { cachedEditBaseline, changedModelPaths, compactModelBaseline, mainXmlPath, readRemoteBaseline, remoteBaselineKey, restoreModelBaseline, type ModelProject } from '../utils/modelChanges';
import { environmentFromProject, environmentFields } from '../sim/runtimeParameters';
import { getComponentDef } from '../utils/componentDefs';
import { ftpDownloadSimConfig, ftpUploadSimConfig } from '../utils/tauriApi';
import { prepareModelXml, compareModelXml, type RemoteXmlChange } from '../utils/modelXmlSync';
import { useFlowStore } from '../store/flowStore';
import { generateXml, generateSubfile, parseXml, saveProject, getProjectPath, loadProject as loadProjectApi, loadAircraft, simListModels, ftpDownloadXml, ftpUploadFile, ftpUploadModelAssets, checkModelAssets, listRemoteXmlParent, isRemoteUploadEnabled } from '../utils/tauriApi';
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
import ModelSyncBar from './ModelSyncBar';
import ModelPullDialog from './ModelPullDialog';
import { comparePulledModel } from '../utils/modelPull';
import { useSignalMonitorStore } from '../store/signalMonitorStore';
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
  workspace?: 'editor' | 'multi' | 'scene';
  onSelectWorkspace?: (workspace: 'editor' | 'multi' | 'scene') => void;
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

function modelSyncFingerprint(project: ModelProject): string {
  return JSON.stringify({ model: compactModelBaseline(project), sources: project.xmlFiles?.map(file => [file.path, file.originalXml, file.currentXml]) });
}

function setRemoteBaseline(model: string, value: string) {
  localStorage.setItem(remoteBaselineKey(model), JSON.stringify(compactModelBaseline(JSON.parse(value))));
  window.dispatchEvent(new Event('jsbsim-remote-baseline-changed'));
}

function serialSensorPath(model: string): string {
  return `config/models/${model}.serial.xml`;
}

function pwmCapturePath(model: string): string {
  return `config/models/${model}.pwm.xml`;
}

async function readEnvironmentConfig(path: string): Promise<string | null> {
  try { return (await ftpDownloadSimConfig(path)).content; }
  catch (error) {
    const parent = await listRemoteXmlParent('config/models');
    if (!parent.exists || !parent.files.includes(path.split('/').pop()!)) return null;
    throw error;
  }
}
async function withEnvironment(data: any, model: string) {
  const content = await readEnvironmentConfig(`config/models/${model}.json`);
  if (!content) return data;
  const environment = JSON.parse(content).environment;
  if (!environment || typeof environment !== 'object') return data;
  const def = getComponentDef('environment')!;
  const params = Object.fromEntries(Object.entries(def.params).map(([key, value]) => [key, value.default]));
  for (const [field, configKey] of environmentFields) if (Number.isFinite(environment[configKey])) params[field] = environment[configKey];
  return { ...data, nodes: [...data.nodes.filter((node: any) => node.data.componentType !== 'environment'), {
    id: 'runtime-environment', type: 'aircraftComponent', position: { x: 40, y: 40 },
    data: { label: def.label, componentType: 'environment', params },
  }] };
}

async function loadRemoteXmlForReview(path: string): Promise<string | null> {
  if (path.endsWith('.json')) return readEnvironmentConfig(path);
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

async function withPwmCaptures(data: any, model: string, onSource?: (path: string, content: string) => void): Promise<any> {
  let source: string;
  try {
    source = (await ftpDownloadXml(pwmCapturePath(model))).content;
  } catch (error) {
    const parent = await listRemoteXmlParent('config/models');
    if (parent.files.some(file => file.toLowerCase() === `${model}.pwm.xml`.toLowerCase())) throw error;
    return data;
  }
  onSource?.(pwmCapturePath(model), source);
  const captures = parsePwmCaptures(source);
  const existing = Array.isArray(data.nodes) ? data.nodes : [];
  const right = existing.reduce((x: number, node: any) => Math.max(x, Number(node.position?.x) || 0), 0) + 320;
  const pwmNodes = captures.map((capture, index) => ({
    id: `pwm-capture-${index}`, type: 'aircraftComponent', data: capture,
    position: { x: right, y: index * 170 },
  }));
  return { ...data, nodes: [...existing, ...pwmNodes] };
}

async function withSerialSensors(data: any, model: string, onSource?: (path: string, content: string) => void): Promise<any> {
  let source = '';
  try {
    const remote = await ftpDownloadXml(serialSensorPath(model));
    source = remote.content;
    onSource?.(serialSensorPath(model), source);
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

export default function Toolbar({ onShow3D, jsbsimLogs = [], onLog, onToggleJsbsimLog, onToggleHud, hudVisible = true, onShowLogCenter, fleetControls, workspace = 'editor', onSelectWorkspace, activeInstance = '01', instanceSlots = {}, editorSwitchRequest,
  onEditorSwitchHandled, onSelectInstance, onSelectMultiInstance, onAssignInstanceModel, initialOverrides, networkOverrides, onLoadFleetGroup, onModelContextChange, onUndo, onRedo, onCopy, onPaste }: ToolbarProps) {
  const { isZh } = useLanguage();
  const { aircraft, setAircraft, nodes, edges, subFiles, xmlFiles, xmlEditBaseline, loadProject, clearAll } = useFlowStore();
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
  const [showModelPull, setShowModelPull] = useState(false);
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
  const [, refreshSyncBaseline] = useState(0);
  useEffect(() => {
    const refresh = () => refreshSyncBaseline(value => value + 1);
    window.addEventListener('jsbsim-remote-baseline-changed', refresh);
    return () => window.removeEventListener('jsbsim-remote-baseline-changed', refresh);
  }, []);
  const syncModel = loadedModelDirectory || remoteModelDirectory || aircraft.name;
  const remoteBaseline = readRemoteBaseline(syncModel);
  const editBaseline = remoteBaseline || xmlEditBaseline;
  const currentProject = { aircraft, nodes, edges, subFiles, xmlFiles };
  const modifiedXmlFiles = hasLoadedModel && editBaseline ? changedModelPaths(currentProject, editBaseline, syncModel) : [];
  const environmentPending = hasLoadedModel && environmentFromProject(currentProject) && JSON.stringify(environmentFromProject(currentProject)) !== JSON.stringify(editBaseline && environmentFromProject(editBaseline))
    ? [`config/models/${syncModel}.json`] : [];
  const needsInitialUpload = hasLoadedModel && !remoteBaseline;
  const pendingPaths = needsInitialUpload
    ? [...new Set([mainXmlPath(currentProject, syncModel), ...modifiedXmlFiles])]
    : [...modifiedXmlFiles, ...environmentPending];
  const pendingRevision = pendingPaths.length ? JSON.stringify([syncModel, compactModelBaseline(currentProject),
    editBaseline ? compactModelBaseline(editBaseline) : null,
    xmlFiles.filter(file => file.currentXml !== file.originalXml).map(file => [file.path, file.currentXml])]) : '';
  const [pendingPreparation, setPendingPreparation] = useState<{ revision: string; paths: string[]; error?: string }>({ revision: '', paths: [] });
  useEffect(() => {
    if (!pendingRevision || !editBaseline) return;
    let canceled = false;
    const timer = setTimeout(() => {
      void prepareModelXml(currentProject, editBaseline, syncModel, { generateXml, generateSubfile,
        originalMainSource: localStorage.getItem('jsbsim-raw-xml') || '' }).then(documents => {
        if (canceled) return;
        const paths = [...documents.filter(file => file.dirty).map(file => file.path), ...environmentPending];
        if (needsInitialUpload) paths.push(mainXmlPath(currentProject, syncModel));
        setPendingPreparation({ revision: pendingRevision, paths: [...new Set(paths)] });
      }).catch(error => {
        if (!canceled) setPendingPreparation({ revision: pendingRevision, paths: pendingPaths, error: error.message || String(error) });
      });
    }, 160);
    return () => { canceled = true; clearTimeout(timer); };
  }, [pendingRevision]);
  // A completed empty result is authoritative. While preparing a new revision,
  // candidate graph/string changes must not flash a false unsaved-model notice.
  const visiblePendingPaths = pendingPreparation.revision === pendingRevision
    ? pendingPreparation.paths : needsInitialUpload ? pendingPaths : [];
  const resolvePendingModelPaths = async (): Promise<string[]> => {
    if (!pendingRevision) return [];
    if (pendingPreparation.revision === pendingRevision && !pendingPreparation.error) return pendingPreparation.paths;
    if (!editBaseline) return pendingPaths;
    const documents = await prepareModelXml(currentProject, editBaseline, syncModel, { generateXml, generateSubfile,
      originalMainSource: localStorage.getItem('jsbsim-raw-xml') || '' });
    if (modelSyncFingerprint(useFlowStore.getState()) !== modelSyncFingerprint(currentProject)) {
      throw new Error('核对期间模型已变化，请重新操作。');
    }
    return [...new Set([...documents.filter(file => file.dirty).map(file => file.path), ...environmentPending,
      ...(needsInitialUpload ? [mainXmlPath(currentProject, syncModel)] : [])])];
  };
  const [xmlSourceDocuments, setXmlSourceDocuments] = useState<XmlSourceDocument[]>([]);
  const [syncError, setSyncError] = useState('');
  useEffect(() => setSyncError(''), [syncModel, hasLoadedModel]);
  const syncInFlight = useRef(false);
  const pullContext = useRef('');
  pullContext.current = JSON.stringify([activeInstance, syncModel, workspace]);
  const [pullReview, setPullReview] = useState<(ReturnType<typeof comparePulledModel> & {
    model: string; resolve: (accepted: boolean) => void;
  }) | null>(null);
  const [syncReview, setSyncReview] = useState<{
    changes: RemoteXmlChange[]; assets: Array<{ name: string; size: number }>;
    resolve: (accepted: boolean) => void;
  } | null>(null);

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
    let changes: string[];
    try { changes = await resolvePendingModelPaths(); }
    catch (error: any) { setSyncError(error.message || String(error)); return; }
    const fileList = changes.length ? changes.map(file => `  • ${file}`).join('\n') : '  • 无 XML 内容变更';
    if (!confirm(`即将保存模型工程：${filename}\n\n保存路径：\n${targetPath}\n\n变更的 XML 文件：\n${fileList}\n\n工程将包含模型数据、XML 内容、布局和用户设置。确认继续吗？`)) return;
    try {
      const project = {
        format: 'jsbsim-model-project', version: 3, model, savedAt: new Date().toISOString(),
        project: { aircraft, nodes, edges, subFiles, xmlFiles, xmlEditBaseline: editBaseline ? compactModelBaseline(editBaseline) : undefined, monitoring: useSignalMonitorStore.getState().project },
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
      alert(`工程已保存：\n${savedPath}`);
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    }
  };

  const prepareSync = async (model: string, force = false) => {
    const state = useFlowStore.getState();
    const snapshot: ModelProject = { aircraft: state.aircraft, nodes: state.nodes, edges: state.edges,
      subFiles: state.subFiles, xmlFiles: state.xmlFiles };
    const main = snapshot.xmlFiles?.find(file => file.category === 'main');
    const directory = main?.path.match(/^aircraft\/([^/]+)\//)?.[1];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model) || directory && directory !== model ||
        !main && snapshot.aircraft.name !== model && localStorage.getItem('jsbsim-remote-model') !== model) {
      throw new Error(`当前模型与目标目录 ${model} 不匹配，请先加载对应模型。`);
    }
    const saved = readRemoteBaseline(model);
    const baseline = saved || state.xmlEditBaseline || snapshot;
    const documents = await prepareModelXml(snapshot, baseline, model, { generateXml, generateSubfile,
      originalMainSource: localStorage.getItem('jsbsim-raw-xml') || '' });
    const candidates = new Map(documents.filter(file => force || !saved && ['main', 'hardware'].includes(file.category || '') || file.dirty)
      .map(file => [file.path, file]));
    let assets: Array<{ name: string; size: number }> = [];
    let assetSource = '';
    if (!saved) {
      const references: ImportFile[] = JSON.parse(localStorage.getItem('jsbsim-reference-files') || '[]');
      if (!Array.isArray(references)) throw new Error('关联文件清单格式无效');
      for (const reference of references) {
        const name = String(reference.name || '').replace(/\\/g, '/');
        if (!name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && part !== '..') ||
            !/\.xml$/i.test(name) || !reference.xml?.trim()) throw new Error(`关联 XML 无效：${name}`);
        const path = name.startsWith(`aircraft/${model}/`) || name.startsWith('systems/') || name.startsWith('engine/')
          ? name : `aircraft/${model}/${name}`;
        const prepared = documents.find(file => file.path === path) || documents.find(file => file.path === name);
        candidates.set(path, { path, content: prepared?.content || reference.xml, dirty: true, category: prepared?.category });
      }
      assets = JSON.parse(localStorage.getItem('jsbsim-import-assets') || '[]');
      assetSource = localStorage.getItem('jsbsim-import-directory') || '';
      if (!Array.isArray(assets) || assets.some(file => !file.name ||
          !file.name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) && part !== '..') ||
          !Number.isSafeInteger(file.size) || file.size < 0) || assets.length && !assetSource.startsWith('/')) {
        throw new Error('模型资源清单或源目录无效，请重新导入');
      }
      if (assets.length) await checkModelAssets(assetSource, assets.map(file => file.name));
    }
    // Resolve every local source and read every remote candidate before showing
    // approval. A failed read is never treated as a missing or unchanged file.
    const changes = await compareModelXml([...candidates.values()], loadRemoteXmlForReview);
    const environment = environmentFromProject(snapshot);
    if (environment && (force || JSON.stringify(environment) !== JSON.stringify(environmentFromProject(baseline)))) {
      const path = `config/models/${model}.json`, remote = await readEnvironmentConfig(path);
      const previous = remote ? JSON.parse(remote) : { version: 1 };
      const content = JSON.stringify({ ...previous, environment: { ...previous.environment, ...environment } }, null, 2);
      if (content !== remote) changes.push({ path, content, remote, dirty: true, category: 'environment' });
    }
    return { model, snapshot, documents, changes, assets, assetSource };
  };

  const runModelSync = async (model: string, force = false): Promise<boolean> => {
    if (syncInFlight.current) throw new Error('模型 XML 对比或保存正在进行，请先完成当前操作。');
    syncInFlight.current = true;
    setSyncError('');
    setLoading(true);
    try {
      const plan = await prepareSync(model, force);
      if (plan.changes.length || plan.assets.length) {
        setLoading(false);
        const accepted = await new Promise<boolean>(resolve => setSyncReview({ changes: plan.changes, assets: plan.assets, resolve }));
        setSyncReview(null);
        if (!accepted) throw Object.assign(new Error('已取消保存，本地修改尚未同步到仿真机。'), { name: 'ModelSyncCancelledError' });
        setLoading(true);
        if (!isRemoteUploadEnabled()) throw Object.assign(new Error('请在本地配置中开启“允许写入仿真机模型”。'), { name: 'ModelSyncRequiredError' });
        if (modelSyncFingerprint(useFlowStore.getState()) !== modelSyncFingerprint(plan.snapshot)) {
          throw new Error('对比期间模型已变化，请重新对比后保存。');
        }
        // Recheck all reviewed files before the first write so another writer
        // cannot silently invalidate the comparison the user approved.
        for (const file of plan.changes) {
          if (await loadRemoteXmlForReview(file.path) !== file.remote) throw new Error(`${file.path} 在对比后已变化，请重新对比。`);
        }
      }
      const verified = new Map<string, string>();
      let uploaded = false;
      for (const file of plan.changes) {
        const result = file.path.endsWith('.json')
          ? { uploaded: (await ftpUploadSimConfig(file.path, file.content)).saved }
          : await ftpUploadFile(file.path, file.content, { batchConfirmed: true });
        const remote = file.path.endsWith('.json') ? await ftpDownloadSimConfig(file.path) : await ftpDownloadXml(file.path);
        if (file.path.endsWith('.json') ? remote.content !== file.content : comparableXml(remote.content) !== comparableXml(file.content)) throw new Error(`${file.path} 回读不一致，仍保留待保存状态。`);
        verified.set(file.path, file.content);
        uploaded ||= result.uploaded;
      }
      if (plan.assets.length) {
        const result = await ftpUploadModelAssets(plan.assetSource, model, plan.assets.map(file => file.name));
        const expected = plan.assets.map(file => `/mnt/sdcard/jsbsim/aircraft/${model}/${file.name}`);
        if (JSON.stringify(result.files) !== JSON.stringify(expected)) throw new Error('模型资源上传结果与源目录不一致');
        uploaded = true;
      }
      const directories = new Map<string, string[]>();
      for (const path of [...verified.keys(), ...plan.assets.map(file => `aircraft/${model}/${file.name}`)]) {
        const split = path.lastIndexOf('/'), parent = path.slice(0, split), name = path.slice(split + 1);
        if (!directories.has(parent)) {
          const listing = await listRemoteXmlParent(parent);
          if (!listing.exists) throw new Error(`仿真机目录不存在：${parent}`);
          directories.set(parent, listing.files);
        }
        if (!directories.get(parent)!.includes(name)) throw new Error(`回读成功但目录中找不到 ${path}，请检查 SD 文件系统。`);
      }
      // Only a fully verified batch advances the baseline. Edits made while
      // uploading remain in live nodes and are compared with this snapshot.
      const prepared = new Map(plan.documents.map(file => [file.path, file.content]));
      for (const file of plan.changes) prepared.set(file.path, file.content);
      const cleanFiles = (plan.snapshot.xmlFiles || []).map(file => prepared.has(file.path)
        ? { ...file, originalXml: prepared.get(file.path)!, currentXml: prepared.get(file.path)!, dirty: false } : file);
      for (const document of plan.documents) {
        if (document.category === 'hardware' || cleanFiles.some(file => file.path === document.path)) continue;
        const category = document.category === 'main' ? 'main' : document.path.startsWith('engine/') ? 'engine' : 'system';
        cleanFiles.push({ id: `${category}:${document.path}`, path: document.path, category,
          originalXml: document.content, currentXml: document.content, dirty: false });
      }
      const baseline = { ...plan.snapshot, xmlFiles: cleanFiles };
      const live = useFlowStore.getState();
      const liveFiles = live.xmlFiles.map(file => {
        const clean = cleanFiles.find(item => item.path === file.path);
        if (!clean) return file;
        const atStart = plan.snapshot.xmlFiles?.find(item => item.path === file.path);
        return { ...clean, currentXml: file.currentXml !== atStart?.currentXml ? file.currentXml : clean.currentXml };
      });
      for (const file of cleanFiles) if (!liveFiles.some(item => item.path === file.path)) liveFiles.push(file);
      useFlowStore.setState({ xmlEditBaseline: baseline, xmlFiles: liveFiles });
      const main = cleanFiles.find(file => file.category === 'main');
      if (main) localStorage.setItem('jsbsim-raw-xml', main.currentXml);
      localStorage.setItem('jsbsim-remote-model', model);
      onAssignInstanceModel?.(activeInstance, model);
      setRemoteBaseline(model, projectFingerprint(baseline));
      onLog?.(`[${new Date().toLocaleTimeString()}] ${uploaded ? `已写入并回读确认 ${verified.size} 个 XML` : '本机 XML 与仿真机一致'}：${model}`);
      return uploaded;
    } catch (error: any) {
      setSyncError(error?.name === 'ModelSyncCancelledError' ? '' : error?.message || String(error));
      throw error;
    } finally {
      setLoading(false);
      syncInFlight.current = false;
    }
  };

  const handleSaveToSimulator = async () => {
    try { await runModelSync(syncModel); }
    catch (error: any) { if (error.name !== 'ModelSyncCancelledError') alert(`保存到仿真机失败：${error.message || error}`); }
  };

  const handlePullModel = async (model: string) => {
    if (syncInFlight.current) throw new Error('模型对比或保存正在进行，请先完成当前操作。');
    syncInFlight.current = true;
    setLoading(true);
    setSyncError('');
    try {
      const state = useFlowStore.getState();
      const snapshot: ModelProject = { aircraft: state.aircraft, nodes: state.nodes, edges: state.edges,
        subFiles: state.subFiles, xmlFiles: state.xmlFiles };
      const fingerprint = modelSyncFingerprint(snapshot), context = pullContext.current;
      const checkCurrent = () => {
        if (pullContext.current !== context || modelSyncFingerprint(useFlowStore.getState()) !== fingerprint) {
          throw new Error('拉取或对比期间上位机模型已变化，请重新拉取并对比。');
        }
      };
      // Prepare actual local edits, including graph-only changes, before any
      // replacement. Never load the incoming graph merely to preview it.
      const local = snapshot.nodes.length || snapshot.xmlFiles?.length
        ? await prepareModelXml(snapshot, readRemoteBaseline(syncModel) || state.xmlEditBaseline || snapshot, syncModel,
          { generateXml, generateSubfile, originalMainSource: localStorage.getItem('jsbsim-raw-xml') || '' }) : [];
      const hardware = new Map<string, string>();
      const onSource = (path: string, content: string) => { hardware.set(path, content); };
      const data = await withEnvironment(await withPwmCaptures(await withSerialSensors(await loadAircraft(model), model, onSource), model, onSource), model);
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.sourceXml ||
          !data.xmlFiles?.some((file: any) => file.category === 'main')) {
        throw new Error('仿真机返回的模型不完整，无法覆盖上位机模型。');
      }
      const incoming = await prepareModelXml(data, data, model, { generateXml, generateSubfile });
      for (const [path, content] of hardware) {
        const file = incoming.find(file => file.path === path);
        if (file) file.content = content;
        else incoming.push({ path, content, category: 'hardware', dirty: false });
      }
      // Only the environment group is represented by the editor; other runtime
      // settings in the simulator's JSON are not part of this replacement.
      for (const [project, documents, directory] of [[snapshot, local, syncModel], [data, incoming, model]] as const) {
        const environment = environmentFromProject(project);
        if (environment) documents.push({ path: `config/models/${directory}.json`, category: 'environment',
          content: JSON.stringify({ environment }, null, 2), dirty: false });
      }
      checkCurrent();
      const comparison = comparePulledModel(local, incoming);
      setShowModelPull(false);
      setLoading(false);
      const accepted = await new Promise<boolean>(resolve => setPullReview({ ...comparison, model, resolve }));
      setPullReview(null);
      if (!accepted) return;
      checkCurrent();
      setLoading(true);
      // Roll back both the editor and its caches if persistence fails. The
      // baseline advances only after the user accepts this downloaded snapshot.
      const previous = useFlowStore.getState(), monitoring = useSignalMonitorStore.getState().project;
      const keys = ['jsbsim-project', 'jsbsim-raw-xml', 'jsbsim-reference-files', 'jsbsim-remote-model',
        'jsbsim-import-assets', 'jsbsim-import-directory', 'jsbsim-cache-version', remoteBaselineKey(model)];
      const cache = keys.map(key => [key, localStorage.getItem(key)] as const);
      try {
        loadProject(data);
        const saved = projectFingerprint(useFlowStore.getState());
        localStorage.setItem('jsbsim-project', saved);
        localStorage.setItem('jsbsim-raw-xml', data.sourceXml);
        localStorage.setItem('jsbsim-reference-files', JSON.stringify(data.referenceFiles || []));
        localStorage.setItem('jsbsim-remote-model', model);
        localStorage.setItem('jsbsim-cache-version', '2');
        localStorage.removeItem('jsbsim-import-assets');
        localStorage.removeItem('jsbsim-import-directory');
        setRemoteBaseline(model, saved);
      } catch (error) {
        useFlowStore.setState(previous);
        useSignalMonitorStore.getState().load(monitoring);
        for (const [key, value] of cache) {
          try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* best effort after a storage failure */ }
        }
        throw error;
      }
      clearImportedSubFiles();
      setLibrarySimulationModel(model);
      onAssignInstanceModel?.(activeInstance, model);
      onModelContextChange?.();
      onLog?.(`[${new Date().toLocaleTimeString()}] 已确认使用仿真机模型覆盖上位机：${model}`);
    } catch (error: any) {
      setSyncError(`拉取模型失败：${error.message || error}`);
      throw error;
    } finally {
      setLoading(false);
      syncInFlight.current = false;
    }
  };

  const handleDiscardLocalChanges = (): string | null => {
    if (loading || syncInFlight.current || !editBaseline) return '当前无法恢复模型，请先完成正在进行的操作。';
    try {
      const state = useFlowStore.getState();
      const restored = restoreModelBaseline(state, editBaseline);
      // Persist before replacing the canvas so a storage failure leaves the
      // editable model intact. Keep monitor settings with the cached project.
      localStorage.setItem('jsbsim-project', JSON.stringify({ ...restored,
        xmlEditBaseline: cachedEditBaseline(restored, editBaseline), monitoring: useSignalMonitorStore.getState().project }));
      const main = restored.xmlFiles?.find(file => file.category === 'main');
      if (main) localStorage.setItem('jsbsim-raw-xml', main.originalXml);
      state.restoreModelContent(restored);
      setSyncError('');
      onLog?.(`[${new Date().toLocaleTimeString()}] 已取消本地模型更改：${syncModel}`);
      return null;
    } catch (error: any) {
      setSyncError(error.message || String(error));
      return error.message || String(error);
    }
  };

  const openXmlSource = async () => {
    setLoading(true);
    try {
      const state = useFlowStore.getState();
      const baseline = readRemoteBaseline(syncModel) || state.xmlEditBaseline || state;
      setXmlSourceDocuments(await prepareModelXml(state, baseline, syncModel, { generateXml, generateSubfile,
        originalMainSource: localStorage.getItem('jsbsim-raw-xml') || '' }));
      setShowXmlSourceBrowser(true);
      setSyncError('');
    } catch (error: any) { setSyncError(error.message || String(error)); }
    finally { setLoading(false); }
  };

  // Unload the model currently held by the editor and return to a blank
  // project. The simulator binding (jsbsim-remote-model) is deliberately kept
  // so the same model can be re-downloaded afterwards.
  const handleCloseModel = async () => {
    const current = useFlowStore.getState();
    let changes: string[];
    try { changes = await resolvePendingModelPaths(); }
    catch (error: any) { setSyncError(error.message || String(error)); return; }
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
    const data = await withEnvironment(await withPwmCaptures(await withSerialSensors(await loadAircraft(model), model), model), model);
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
    setRemoteBaseline(model, snapshot);
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
      let changes: string[];
      try { changes = await resolvePendingModelPaths(); }
      catch (error: any) { setSyncError(error.message || String(error)); return; }
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

  const handleSyncRemoteModel = (model: string) => runModelSync(model);
  const handleForceSyncRemoteModel = (model: string) => runModelSync(model, true);

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
              <button role="menuitem" onClick={() => { onSelectWorkspace?.('scene'); setShowWorkspaceMenu(false); }}>◈ {isZh ? '飞行视景' : 'Flight Scene'}{workspace === 'scene' ? ' ✓' : ''}</button>
              <button role="menuitem" onClick={() => { onSelectWorkspace?.('multi'); setShowWorkspaceMenu(false); }}>◫ {isZh ? '多机仿真' : 'Multi-Aircraft'}{workspace === 'multi' ? ' ✓' : ''}</button>
              <button role="menuitem" onClick={() => { onShowLogCenter?.(); setShowWorkspaceMenu(false); }}>▤ {isZh ? '日志中心' : 'Log Center'}</button>
              <div className="file-menu-separator" />
              <button role="menuitem" onClick={() => { setShowLibrary(true); setShowWorkspaceMenu(false); }} disabled={loading}>📚 {isZh ? '模型库' : 'Models'}</button>
              <button role="menuitem" onClick={() => { setShowSimulationConfig(true); setShowWorkspaceMenu(false); }} disabled={loading || !instanceSlots[activeInstance]} title={!instanceSlots[activeInstance] ? (isZh ? '先给当前实例绑定模型' : 'Assign a model to this instance first') : undefined}>⚙ {isZh ? '仿真配置' : 'Simulation'}</button>
              <button role="menuitem" onClick={() => { setShowLocalSettings(true); setShowWorkspaceMenu(false); }} title={isZh ? '本地配置' : 'Local Settings'} aria-label={isZh ? '本地配置' : 'Local Settings'}>🔧 {isZh ? '本地' : 'Settings'}</button>
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
                <button role="menuitem" disabled={loading || !!syncReview || !!pullReview} onClick={() => { setShowModelPull(true); setShowFileMenu(false); }}>📡 {isZh ? '从仿真机拉取模型' : 'Pull Model from Simulator'}</button>
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
                <button role="menuitem" disabled={!hasLoadedModel || loading} onClick={() => { void openXmlSource(); setShowFileMenu(false); }}>🧾 {isZh ? 'XML 源码浏览器' : 'XML Source Browser'}</button>
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
              <button role="menuitem" onClick={() => { setShowSerialAssistant(true); setShowToolsMenu(false); }}>⌁ {isZh ? '串口与网口助手（本机）' : 'Serial & Network Assistant (Local)'}</button>
              <div className="file-menu-separator" />
              <button role="menuitem" onClick={() => { setShowJ23Guide(true); setShowToolsMenu(false); }}>📖 {isZh ? '使用说明' : 'User Guide'}</button>
            </div>}
          </div>
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
      {showModelPull && <ModelPullDialog initialModel={hasLoadedModel ? syncModel : instanceSlots[activeInstance] || remoteModelDirectory}
        onPull={handlePullModel} onClose={() => setShowModelPull(false)} />}

      {visiblePendingPaths.length > 0 && <ModelSyncBar key={syncModel} paths={visiblePendingPaths}
        initialUpload={needsInitialUpload} busy={loading || !!syncReview || !!pullReview}
        canDiscard={!!editBaseline && (modifiedXmlFiles.length > 0 || environmentPending.length > 0)}
        onSave={() => void handleSaveToSimulator()} onDiscard={handleDiscardLocalChanges} />}
      {(syncError || pendingPreparation.revision === pendingRevision && pendingPreparation.error) &&
        <div className="model-sync-error" role="alert">{syncError || pendingPreparation.error}</div>}
      {pullReview && <XmlSourceBrowser documents={pullReview.documents} comparisonDirection="pull"
        initialPath={pullReview.documents.find(file => file.dirty)?.path}
        title={`从仿真机拉取模型 · ${pullReview.model}`}
        subtitle={`新增 ${pullReview.counts.added} · 修改 ${pullReview.counts.modified} · 移除 ${pullReview.counts.removed} · 文本变化 ${pullReview.counts.text} · 一致 ${pullReview.counts.same}；左侧上位机当前版本 → 右侧本次拉取版本`}
        remoteContents={pullReview.localContents} onClose={() => pullReview.resolve(false)}
        footer={<footer className="model-sync-review-footer model-pull-review-footer">
          <div>确认后将用本次拉取的模型替换上位机当前模型及本地缓存，当前未保存的修改会被覆盖。已另存的工程文件需通过“保存”更新。</div>
          <button onClick={() => pullReview.resolve(false)}>取消，保留上位机模型</button>
          <button className="primary" onClick={() => pullReview.resolve(true)}>确认覆盖上位机模型</button>
        </footer>} />}
      {syncReview && <XmlSourceBrowser documents={syncReview.changes}
        title="对比并保存到仿真机" subtitle={`${syncReview.changes.length} 个 XML 将写入；请逐项查看本机编辑结果与仿真机版本的差异`}
        remoteContents={Object.fromEntries(syncReview.changes.map(file => [file.path, file.remote]))}
        onClose={() => syncReview.resolve(false)}
        footer={<footer className="model-sync-review-footer">
          <div>{syncReview.assets.length > 0 && <span>另将上传 {syncReview.assets.length} 个资源：{syncReview.assets.map(file => file.name).join('、')}。 </span>}
            <span>{isRemoteUploadEnabled() ? '保存后将回读确认，成功后清除待保存提示。' : '写入已关闭，请先在本地配置中开启“允许写入仿真机模型”。'}</span></div>
          <button onClick={() => syncReview.resolve(false)}>取消</button>
          <button className="primary" disabled={!isRemoteUploadEnabled()} onClick={() => syncReview.resolve(true)}>确认保存到仿真机</button>
        </footer>} />}
      {showXmlSourceBrowser && <XmlSourceBrowser documents={xmlSourceDocuments} loadRemoteContent={loadRemoteXmlForReview} onClose={() => setShowXmlSourceBrowser(false)} />}


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
            const data = modelName ? await withEnvironment(await withPwmCaptures(await withSerialSensors(loaded, modelName), modelName), modelName) : loaded;
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
              if (data.sourceXml) setRemoteBaseline(loadedModel, projectFingerprint(useFlowStore.getState()));
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
