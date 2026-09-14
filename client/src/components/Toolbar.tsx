import { useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { generateXml, generateSubfile, parseXml, saveProject, getProjectPath, loadProject as loadProjectApi, ftpDownloadModel, ftpDownloadXml, ftpUploadModel, ftpUploadFile, ftpListSystems, ftpListEngines, isRemoteUploadEnabled } from '../utils/tauriApi';
import AircraftWizard from './AircraftWizard';
import AircraftLibrary from './AircraftLibrary';
import SimMenu from './SimMenu';
import SimulationConfigDialog from './SimulationConfigDialog';
import LocalSettingsDialog from './LocalSettingsDialog';
import NshConsoleDialog from './NshConsoleDialog';
import XmlSourceBrowser, { type XmlSourceDocument } from './XmlSourceBrowser';
import { patchExistingSubfileXml } from '../utils/sourcePreservingXml';
import { isTauri } from '../utils/tauriApi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLanguage } from '../i18n';

interface ToolbarProps {
  onShow3D?: () => void;
  onShowLive?: () => void;
  jsbsimLogs?: string[];
  onLog?: (message: string) => void;
  onToggleJsbsimLog?: () => void;
  onToggleHud?: () => void;
  hudVisible?: boolean;
  onShowLogCenter?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  modifiedXmlFiles?: string[];
  onSaveComplete?: (savedFiles?: string[]) => void;
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

function remoteBaselineKey(model: string): string {
  return `jsbsim-remote-baseline:${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
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

/**
 * Apply editor changes to the original top-level I/O tags without rebuilding
 * the aircraft document. generateXml() operates on the expanded visual graph,
 * so using it for an imported model serializes referenced engine/system files
 * into the main aircraft XML.
 */
function patchMainIoAttributes(sourceXml: string, nodes: any[]): string {
  const ioNodes = nodes.filter(node => ['input', 'output', 'uavcan'].includes(node?.data?.componentType));
  const used = new Set<number>();

  // Top-level JSBSim transport declarations have both name and type
  // attributes. Nested FCS expression tags such as <input>property</input>
  // do not; excluding them prevents an I/O edit from touching control logic.
  return sourceXml.replace(/<(input|output)\b(?=[^>]*\bname\s*=)(?=[^>]*\btype\s*=)[^>]*>/gi, (tag, tagName: string) => {
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
    return patched;
  });
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
      const systemPatch = fileType === 'system'
        ? await generateSubfile('system', fileName, params)
        : undefined;
      content = patchExistingSubfileXml(content, fileType, params, systemPatch);
    }
    return content;
  }

  // Full generation is permitted only for an explicitly-created subfile. An
  // imported reference with missing source is unsafe because unknown fields,
  // comments and lookup tables cannot be reconstructed from node parameters.
  if (!subFile) {
    throw new Error(`子文件 ${path} 缺少原始 XML。为防止丢失未建模字段、查表或注释，本次上传已取消；请重新导入完整目录。`);
  }
  return generateSubfile(subFile.fileType, subFile.fileName, subFile.data);
}

export default function Toolbar({ onShow3D, onShowLive, jsbsimLogs = [], onLog, onToggleJsbsimLog, onToggleHud, hudVisible = true, onShowLogCenter, onUndo, onRedo, onCopy, onPaste, modifiedXmlFiles = [], onSaveComplete }: ToolbarProps) {
  const { isZh } = useLanguage();
  const { aircraft, setAircraft, nodes, edges, subFiles, xmlFiles, loadProject, clearAll } = useFlowStore();
  const hasLoadedModel = nodes.length > 0 || xmlFiles.length > 0;
  const [showXml, setShowXml] = useState(false);
  const [showXmlSourceBrowser, setShowXmlSourceBrowser] = useState(false);
  const [uploadReview, setUploadReview] = useState<{ documents: XmlSourceDocument[]; resolve: () => void } | null>(null);
  const [xmlContent, setXmlContent] = useState('');
  const [importedSubFiles, setImportedSubFiles] = useState<Array<{ name: string; referenced: boolean; category?: string }>>(() => {
    try { return JSON.parse(localStorage.getItem('jsbsim-imported-subfiles') || '[]'); } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showNshConsole, setShowNshConsole] = useState(false);
  const [showSimulationConfig, setShowSimulationConfig] = useState(false);
  const [showLocalSettings, setShowLocalSettings] = useState(false);
  const [librarySimulationModel, setLibrarySimulationModel] = useState('');
  const [recentProjects, setRecentProjects] = useState<Array<{ filename: string; path: string; openedAt: string }>>(() => JSON.parse(localStorage.getItem('jsbsim-recent-projects') || '[]'));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
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
  const startWindowDrag = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isTauri || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, select, [role="menu"]')) return;
    void getCurrentWindow().startDragging();
  };
  // The import summary describes one import action. Anything that replaces the
  // model in the editor invalidates it, and it is restored from localStorage on
  // mount, so it has to be dropped explicitly or it keeps resurfacing.
  const clearImportedSubFiles = () => {
    setImportedSubFiles([]);
    localStorage.removeItem('jsbsim-imported-subfiles');
  };

  const rememberProject = (filename: string, path: string) => {
    setRecentProjects(current => {
      const next = [{ filename, path, openedAt: new Date().toISOString() }, ...current.filter(item => item.filename !== filename)].slice(0, 6);
      localStorage.setItem('jsbsim-recent-projects', JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const closeFileMenu = (event: MouseEvent) => {
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

  const handleImportXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setLoading(true);
    try {
      // Read all files
      const allFiles: { name: string; xml: string }[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
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
      const commonRoot = firstSegments.length > 1 && firstSegments.every(segment => segment === firstSegments[0]) ? `${firstSegments[0]}/` : '';
      if (commonRoot) normalizedFiles.forEach(file => { file.name = file.name.slice(commonRoot.length); });

      // Directory enumeration order is not a stable way to identify the
      // aircraft configuration. Prefer the fdm_config document as main XML.
      const mainIndex = normalizedFiles.findIndex(file => /<\s*fdm_config\b/i.test(file.xml));
      const orderedFiles = mainIndex > 0
        ? [normalizedFiles[mainIndex], ...normalizedFiles.filter((_, index) => index !== mainIndex)]
        : normalizedFiles;

      // First file is the main XML, rest are referenced files.  Selecting a
      // directory is supported as well; the complete relative tree is passed
      // to the parser and retained in the project.
      const mainXml = orderedFiles[0].xml;
      const refFiles = orderedFiles.slice(1);
      const allXml = orderedFiles.map(file => file.xml).join('\n').toLowerCase();
      const classifyPackageFile = (name: string) => {
        const lower = name.toLowerCase();
        if (lower.endsWith('reset.xml') || lower.endsWith('initfile.xml')) return 'initialization';
        if (lower.endsWith('-set.xml')) return 'model-config';
        if (lower.includes('/systems/') || lower.startsWith('systems/')) return 'system';
        if (lower.includes('/engine/') || lower.startsWith('engine/')) return 'engine';
        return 'companion';
      };
      const provisionalFiles = refFiles.map(file => ({ name: file.name, referenced: false, category: classifyPackageFile(file.name) }));
      setImportedSubFiles(provisionalFiles);
      localStorage.setItem('jsbsim-imported-subfiles', JSON.stringify(provisionalFiles));
      const data = await parseXml(mainXml, refFiles);
      loadProject(data);
      const selectedFiles = refFiles.map(file => file.name);
      const parsedFiles = (data.xmlFiles || []).filter((file: any) => file.category !== 'main').map((file: any) => String(file.path || ''));
      const packageCategories = new Map<string, string>((data.packageFiles || []).map((file: any) => [String(file.path || ''), String(file.category || 'companion')]));
      const packagePaths = Array.from(packageCategories.keys()).filter(Boolean);
      const importedFiles = Array.from(new Set([...selectedFiles, ...parsedFiles, ...packagePaths].filter(Boolean))).map(name => {
        const normalized = name.replace(/\\/g, '/').toLowerCase();
        const basename = normalized.split('/').pop() || normalized;
        return { name, referenced: parsedFiles.includes(name) || allXml.includes(normalized) || allXml.includes(basename), category: packageCategories.get(name) };
      }).sort((a, b) => Number(b.referenced) - Number(a.referenced) || a.name.localeCompare(b.name));
      setImportedSubFiles(importedFiles);
      localStorage.setItem('jsbsim-imported-subfiles', JSON.stringify(importedFiles));

      // Persist to localStorage so data survives refresh
      try {
        localStorage.setItem('jsbsim-project', JSON.stringify(data));
        localStorage.setItem('jsbsim-raw-xml', mainXml);
          localStorage.setItem('jsbsim-reference-files', JSON.stringify(refFiles));
        // An imported model defines its own identity. Without rebinding, a
        // previously loaded simulator model would keep winning at
        // handleSaveToSimulator() and the import would be uploaded into the
        // wrong aircraft directory.
        const importedModel = String(data?.aircraft?.name || '').trim();
        if (importedModel) {
          localStorage.setItem('jsbsim-remote-model', importedModel);
          // Whatever the simulator currently holds was never verified against
          // this import, so drop the baseline and force a full push.
          localStorage.removeItem(remoteBaselineKey(importedModel));
        }
      } catch (e) {
        console.warn('[Import] Failed to save to localStorage:', e);
      }

      if (refFiles.length > 0) {
        console.log(`[Import] Merged ${refFiles.length} referenced file(s): ${refFiles.map(f => f.name).join(', ')}`);
      }
    } catch (err: any) {
      alert('导入失败: ' + err.message);
    }
    setLoading(false);
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
    if (!model) {
      alert('无法确定仿真机模型名称，请先从仿真机加载模型。');
      return;
    }
    const target = `/mnt/sdcard/jsbsim/aircraft/${model}/${model}.xml`;
    const stateBeforeSave = useFlowStore.getState();
    // A model without a remote baseline has never been exchanged with the
    // simulator, so there is nothing to diff against: the whole model counts
    // as pending instead of just the local edits. This is what makes
    // "import a folder -> save to simulator" work at all.
    const hasBaseline = !!localStorage.getItem(remoteBaselineKey(model));
    const dirtyRecords = hasBaseline
      ? (stateBeforeSave.xmlFiles || []).filter(file => file.dirty)
      : (stateBeforeSave.xmlFiles || []).filter(file => file.category !== 'main');
    const trackedFiles = dirtyRecords.map(file => file.path);
    const changesList = Array.from(new Set([...modifiedXmlFiles, ...trackedFiles]));
    const changes = changesList.length
      ? changesList.map(file => `  • ${file}`).join('\n')
      : hasBaseline ? '  • 当前未记录到 XML 修改' : `  • 全量上传：${model} 尚无同步基线`;
    const mainDirty = hasBaseline
      ? dirtyRecords.some(file => file.category === 'main') ||
        modifiedXmlFiles.some(file => file === `${model}.xml` || file.endsWith(`/${model}.xml`))
      : true;
    const externalPaths = new Set(dirtyRecords.filter(file => ['engine', 'thruster', 'system'].includes(file.category)).map(file => {
      const path = file.path.toLowerCase().endsWith('.xml') ? file.path : `${file.path}.xml`;
      if (path.includes('/')) return path;
      return file.category === 'system' ? `systems/${path}` : `engine/${path}`;
    }));
    if (!hasBaseline) {
      // The upload loop below only writes paths present in this set, so a full
      // push has to seed it from the component nodes as well.
      for (const node of stateBeforeSave.nodes || []) {
        if (!['engine', 'propeller', 'system', 'flight_control'].includes(node.data?.componentType)) continue;
        const path = nodeOwnedPath(node);
        if (path) externalPaths.add(path);
      }
    }
    for (const file of modifiedXmlFiles) {
      if (file.startsWith('systems/') || file.startsWith('engine/')) externalPaths.add(file);
    }
    const writes = [...(mainDirty ? [target] : []), ...Array.from(externalPaths).map(path => `/mnt/sdcard/jsbsim/${path}`)];
    if (!writes.length) {
      alert('当前没有需要写入仿真机的 XML 修改。');
      return;
    }
    if (!isRemoteUploadEnabled()) {
      alert(isZh ? '仿真机模型上传当前已关闭。请在「本地配置」中开启后再试。' : 'Model upload is disabled. Enable it in Local Settings first.');
      return;
    }
    try {
      const [systems, engines] = await Promise.all([ftpListSystems(), ftpListEngines()]);
      const existing = new Set([
        ...systems.map(file => `systems/${String(file).replace(/^systems\//, '').replace(/^\/+/, '')}`),
        ...engines.map(file => `engine/${String(file).replace(/^engine\//, '').replace(/^\/+/, '')}`),
      ].map(path => path.toLowerCase()));
      const conflicts = Array.from(externalPaths).filter(path => existing.has(path.replace(/^\/+/, '').toLowerCase()));
      if (conflicts.length && !confirm(`检测到同名子文件：\n\n${conflicts.map(path => `  • /mnt/sdcard/jsbsim/${path}`).join('\n')}\n\n继续将覆盖这些文件（旧文件会保留为 .bak）。是否确认覆盖？`)) return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || '未知错误');
      // Do not continue when the preflight listing failed.  Continuing here
      // made a network outage look like a harmless name conflict and could
      // leave the upload half-completed on NuttX.
      alert(`无法读取仿真机现有子文件列表，已取消上传。\n\n请确认仿真机已连接且 FTP 服务正常。\n${detail}`);
      return;
    }
    if (!confirm(`即将保存到仿真机。\n\n检测到的变更：\n${changes}\n\n本次实际写入：\n${writes.map(path => `  • ${path}`).join('\n')}\n\n远端旧文件会保留为 .bak。确认继续吗？`)) return;
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
        xml = patchMainIoAttributes(mainSource, current.nodes);
        await ftpUploadModel(model, xml);
      }
      const uploadedChildren = new Map<string, string>();
      for (const path of externalPaths) {
        const content = await buildChildUploadXml(current, path);
        await ftpUploadFile(path, content);
        uploadedChildren.set(path, content);
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
      localStorage.setItem(remoteBaselineKey(model), projectFingerprint({ aircraft: current.aircraft, nodes: current.nodes, edges: current.edges, subFiles: current.subFiles }));
      onSaveComplete?.(changesList);
      onLog?.(`[${new Date().toLocaleTimeString()}] 已保存 XML 到仿真机: ${writes.join(', ')}`);
      alert(`已保存到仿真机：\n${writes.join('\n')}`);
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

  const handleOpenRemoteModel = async (model: string) => {
    clearAll();
    const remote = await ftpDownloadModel(model);
    const data = await parseXml(remote.xml);
    // The file name and JSBSim's internal <fileheader> name are allowed to
    // differ (for example c172r.xml may contain the internal name c172).
    // The requested remote path is therefore the model identity; do not
    // reject a valid model just because those two names differ.
    loadProject(data);
    clearImportedSubFiles();
    // Keep a separate baseline for every aircraft. A single global baseline
    // makes switching c172x -> 737 look like a local edit and can upload the
    // previous aircraft into the newly selected aircraft directory.
    localStorage.setItem(remoteBaselineKey(model), projectFingerprint(data));
    localStorage.setItem('jsbsim-project', JSON.stringify(data));
    localStorage.setItem('jsbsim-raw-xml', remote.xml);
    localStorage.setItem('jsbsim-reference-files', '[]');
    localStorage.setItem('jsbsim-remote-model', model);
    onLog?.(`[${new Date().toLocaleTimeString()}] 已从 NuttX 加载模型: ${model}`);
  };

  const syncRemoteModel = async (model: string, force: boolean): Promise<boolean> => {
    if (!isRemoteUploadEnabled()) {
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
    const fingerprint = projectFingerprint(project);
    if (!force && localStorage.getItem(remoteBaselineKey(model)) === fingerprint) {
      onLog?.(`[${new Date().toLocaleTimeString()}] 未检测到本地修改，跳过 NuttX 模型同步`);
      return false;
    }
    const mainFile = (current.xmlFiles || []).find(file => file.category === 'main');
    const mainPath = mainFile?.path || `aircraft/${model}/${model}.xml`;
    const mainCandidate = !!mainFile?.dirty || modifiedXmlFiles.some(file =>
      file === `${model}.xml` || file.endsWith(`/${model}.xml`)
    );
    const mainSource = originalMainXml(mainFile);
    if (mainCandidate && !mainSource.trim()) {
      throw new Error('主 XML 原始源码缺失。为防止把子文件展开进主文件，本次同步已取消。请重新从仿真机加载模型。');
    }
    const candidateMainXml = mainCandidate
      ? patchMainIoAttributes(mainSource, current.nodes)
      : mainSource;
    const childCandidates = (current.xmlFiles || []).filter(file => file.dirty && file.category !== 'main');
    const childContent = new Map<string, string>();
    for (const file of childCandidates) {
      childContent.set(file.path, await buildChildUploadXml(current, file.path));
    }
    const candidatePaths = Array.from(new Set([
      ...(mainCandidate ? [mainPath] : []),
      ...childCandidates.map(file => file.path),
    ]));
    const unchangedPaths: string[] = [];
    const pendingFiles: string[] = [];
    for (const path of candidatePaths) {
      const localContent = path === mainPath
        ? candidateMainXml
        : childContent.get(path) || '';
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
              : childContent.get(path) || '',
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
        onLog?.(`[${new Date().toLocaleTimeString()}] 用户取消上传，保留仿真机文件: ${model}`);
        return false;
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
      <div className="toolbar" data-tauri-drag-region onPointerDown={event => { void startWindowDrag(event); }}>
        <div className="toolbar-left" data-tauri-drag-region>
        </div>
        <div className="toolbar-center" data-tauri-drag-region>
          <div className="file-menu-anchor" ref={fileMenuRef}>
            <button
              className={`file-menu-trigger ${showFileMenu ? 'active' : ''}`}
              onClick={() => setShowFileMenu(value => !value)}
              disabled={loading}
              aria-haspopup="menu"
              aria-expanded={showFileMenu}
            >
              📁 {isZh ? '文件' : 'File'} <span className="file-menu-caret">▾</span>
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
                <button role="menuitem" onClick={() => { fileInputRef.current?.click(); setShowFileMenu(false); }} title={isZh ? '导入 XML 文件（可多选依赖文件）' : 'Import XML files'}>📥 {isZh ? '导入 XML' : 'Import XML'}</button>
                <button role="menuitem" onClick={() => { directoryInputRef.current?.click(); setShowFileMenu(false); }} title={isZh ? '导入整个 XML 目录，自动保留目录结构' : 'Import an XML directory'}>📂 {isZh ? '导入 XML 目录' : 'Import XML folder'}</button>
                <button role="menuitem" onClick={() => { void handleExportXml(); setShowFileMenu(false); }}>📤 {isZh ? '导出 XML' : 'Export XML'}</button>
                <button role="menuitem" disabled={!xmlSourceDocuments.length} onClick={() => { setShowXmlSourceBrowser(true); setShowFileMenu(false); }}>🧾 {isZh ? 'XML 源码浏览器' : 'XML Source Browser'}</button>
              </div>
            )}
          </div>
          <div className="file-menu-anchor" ref={editMenuRef}>
            <button className={`file-menu-trigger ${showEditMenu ? 'active' : ''}`}
              onClick={() => setShowEditMenu(value => !value)} aria-haspopup="menu" aria-expanded={showEditMenu}>
              ✏️ {isZh ? '编辑' : 'Edit'} <span className="file-menu-caret">▾</span>
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
              👁️ {isZh ? '显示' : 'View'} <span className="file-menu-caret">▾</span>
            </button>
            {showDisplayMenu && <div className="file-menu-dropdown" role="menu">
              <button role="menuitem" onClick={() => { onToggleHud?.(); setShowDisplayMenu(false); }}>🛩️ HUD {hudVisible ? (isZh ? '✓ 已显示' : '✓ Shown') : (isZh ? '已隐藏' : 'Hidden')}</button>
              <button role="menuitem" onClick={() => { onToggleJsbsimLog(); setShowDisplayMenu(false); }}>🖥️ {isZh ? 'JSBSim 信息' : 'JSBSim Console'}{jsbsimLogs.length ? ` (${jsbsimLogs.length})` : ''}</button>
              <button role="menuitem" onClick={() => { onShowLive(); setShowDisplayMenu(false); }}>🔴 {isZh ? '实时' : 'Live'}</button>
              <button role="menuitem" onClick={() => { onShow3D(); setShowDisplayMenu(false); }}>🛩️ 3D</button>
            </div>}
          </div>
          <div className="file-menu-anchor" ref={toolsMenuRef}>
            <button className={`file-menu-trigger ${showToolsMenu ? 'active' : ''}`} onClick={() => setShowToolsMenu(value => !value)} aria-haspopup="menu" aria-expanded={showToolsMenu}>
              🧰 {isZh ? '工具' : 'Tools'} <span className="file-menu-caret">▾</span>
            </button>
            {showToolsMenu && <div className="file-menu-dropdown" role="menu">
              <button role="menuitem" onClick={() => { onShowLogCenter?.(); setShowToolsMenu(false); }}>📊 {isZh ? '日志中心' : 'Log Center'}</button>
              <button role="menuitem" onClick={() => { setShowNshConsole(true); setShowToolsMenu(false); }}>⌨ {isZh ? 'NuttX NSH 控制台' : 'NuttX NSH Console'}</button>
            </div>}
          </div>
          <button onClick={() => setShowLibrary(true)} disabled={loading}>📚 {isZh ? '模型库' : 'Models'}</button>
          <button onClick={() => setShowSimulationConfig(true)} disabled={loading}>⚙ {isZh ? '仿真配置' : 'Simulation'}</button>
          <button onClick={() => setShowLocalSettings(true)}>🔧 {isZh ? '本地配置' : 'Local Settings'}</button>
          <SimMenu loading={loading} onLog={onLog}
            onOpenRemoteModel={handleOpenRemoteModel}
            onSyncRemoteModel={handleSyncRemoteModel}
            selectedModelFromLibrary={hasLoadedModel ? aircraft.name : librarySimulationModel} />
        </div>
        {showNshConsole && <NshConsoleDialog onClose={() => setShowNshConsole(false)} />}
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

      {showSimulationConfig && <SimulationConfigDialog model={aircraft.name || librarySimulationModel || 'default'} onClose={() => setShowSimulationConfig(false)} />}
      {showLocalSettings && <LocalSettingsDialog onClose={() => setShowLocalSettings(false)} />}

      {showXmlSourceBrowser && <XmlSourceBrowser documents={xmlSourceDocuments} loadRemoteContent={async path => (await ftpDownloadXml(path)).content} onClose={() => setShowXmlSourceBrowser(false)} />}
      {uploadReview && <XmlSourceBrowser documents={uploadReview.documents} initialPath={uploadReview.documents[0]?.path} loadRemoteContent={async path => (await ftpDownloadXml(path)).content} onClose={() => {
        const resolve = uploadReview.resolve;
        setUploadReview(null);
        resolve();
      }} />}

      {showXml && (
        <div className="xml-modal-overlay" onClick={() => setShowXml(false)}>
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

      {importedSubFiles.length > 0 && (
        <div className="xml-import-files-overlay" role="dialog" aria-modal="true" aria-label="影响的 XML 子文件" onClick={event => event.stopPropagation()}>
          <div className="xml-import-files-dialog" onClick={event => event.stopPropagation()}>
            <header><strong>📂 影响的 XML 子文件</strong><button onClick={event => { event.preventDefault(); event.stopPropagation(); clearImportedSubFiles(); }}>×</button></header>
            <small>已保留原目录结构，共 {importedSubFiles.length} 个文件</small>
            <ul>{importedSubFiles.map(file => <li key={file.name}>{file.category === 'initialization' ? '🎯' : file.category === 'model-config' ? '⚙️' : file.referenced ? '🔗' : '📄'} {file.name} <em>{file.category === 'initialization' ? '初始化/重置' : file.category === 'model-config' ? '模型配置' : file.referenced ? '已引用' : '随目录导入'}</em></li>)}</ul>
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
              alert('导入失败: ' + err.message);
            }
          }}
        />
      )}

      {showLibrary && (
        <AircraftLibrary
          onClose={() => setShowLibrary(false)}
          onLoad={(data) => {
            loadProject(data);
            const loadedModel = String(data?.model || data?.aircraft?.name || '').trim();
            if (loadedModel) setLibrarySimulationModel(loadedModel);
            // Persist to localStorage
            try {
              localStorage.setItem('jsbsim-project', JSON.stringify(data));
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
