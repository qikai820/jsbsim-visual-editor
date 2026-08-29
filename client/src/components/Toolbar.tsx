import { useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { generateXml, generateSubfile, parseXml, saveProject, getProjectPath, loadProject as loadProjectApi, ftpDownloadModel, ftpUploadModel, ftpUploadFile } from '../utils/tauriApi';

// Safety lock: while validating NuttX reload behavior, never write model XML
// back to the SD card. Downloads remain enabled so the editor can inspect the
// current NuttX model, but uploads require an explicit code change later.
const REMOTE_MODEL_UPLOAD_ENABLED = false;
import AircraftWizard from './AircraftWizard';
import AircraftLibrary from './AircraftLibrary';
import SimMenu from './SimMenu';
import { isTauri } from '../utils/tauriApi';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface ToolbarProps {
  onShow3D?: () => void;
  onShowLive?: () => void;
  jsbsimLogs?: string[];
  onLog?: (message: string) => void;
  onToggleJsbsimLog?: () => void;
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

export default function Toolbar({ onShow3D, onShowLive, jsbsimLogs = [], onLog, onToggleJsbsimLog, onUndo, onRedo, onCopy, onPaste, modifiedXmlFiles = [], onSaveComplete }: ToolbarProps) {
  const { aircraft, setAircraft, nodes, edges, subFiles, xmlFiles, loadProject, clearAll } = useFlowStore();
  const [showXml, setShowXml] = useState(false);
  const [xmlContent, setXmlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [librarySimulationModel, setLibrarySimulationModel] = useState('');
  const [recentProjects, setRecentProjects] = useState<Array<{ filename: string; path: string; openedAt: string }>>(() => JSON.parse(localStorage.getItem('jsbsim-recent-projects') || '[]'));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const editMenuRef = useRef<HTMLDivElement>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);
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
        allFiles.push({ name: f.name, xml: text });
      }

      // First file is the main XML, rest are referenced files
      const mainXml = allFiles[0].xml;
      const refFiles = allFiles.slice(1);

      const data = await parseXml(mainXml, refFiles);
      loadProject(data);

      // Persist to localStorage so data survives refresh
      try {
        localStorage.setItem('jsbsim-project', JSON.stringify(data));
        localStorage.setItem('jsbsim-raw-xml', mainXml);
        localStorage.setItem('jsbsim-reference-files', JSON.stringify(refFiles));
        localStorage.removeItem('jsbsim-remote-baseline');
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
    if (fileInputRef.current) fileInputRef.current.value = '';
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
    const dirtyRecords = (stateBeforeSave.xmlFiles || []).filter(file => file.dirty);
    const trackedFiles = dirtyRecords.map(file => file.path);
    const changesList = Array.from(new Set([...modifiedXmlFiles, ...trackedFiles]));
    const changes = changesList.length ? changesList.map(file => `  • ${file}`).join('\n') : '  • 当前未记录到 XML 修改';
    const mainDirty = dirtyRecords.some(file => file.category === 'main') ||
      modifiedXmlFiles.some(file => file === `${model}.xml` || file.endsWith(`/${model}.xml`));
    const externalPaths = new Set(dirtyRecords.filter(file => file.category !== 'main').map(file => {
      const path = file.path.toLowerCase().endsWith('.xml') ? file.path : `${file.path}.xml`;
      if (path.includes('/')) return path;
      return file.category === 'system' ? `systems/${path}` : `engine/${path}`;
    }));
    for (const file of modifiedXmlFiles) {
      if (file.startsWith('systems/') || file.startsWith('engine/')) externalPaths.add(file);
    }
    const writes = [...(mainDirty ? [target] : []), ...Array.from(externalPaths).map(path => `/mnt/sdcard/jsbsim/${path}`)];
    if (!writes.length) {
      alert('当前没有需要写入仿真机的 XML 修改。');
      return;
    }
    if (!confirm(`即将保存到仿真机。\n\n检测到的变更：\n${changes}\n\n本次实际写入：\n${writes.map(path => `  • ${path}`).join('\n')}\n\n远端旧文件会保留为 .bak。确认继续吗？`)) return;
    setLoading(true);
    try {
      const current = useFlowStore.getState();
      let xml = localStorage.getItem('jsbsim-raw-xml') || '';
      if (mainDirty) {
        xml = await generateXml({ aircraft: current.aircraft, nodes: current.nodes, edges: current.edges });
        await ftpUploadModel(model, xml);
      }
      for (const node of current.nodes || []) {
        const type = node.data?.componentType;
        const params = node.data?.params || {};
        const path = nodeOwnedPath(node);
        if (!path || !externalPaths.has(path) || !['engine', 'propeller', 'system', 'flight_control'].includes(type)) continue;
        const fileType = type === 'system' || type === 'flight_control' ? 'system' : type === 'propeller' ? 'thruster' : 'engine';
        const fileName = path.replace(/^.*\//, '').replace(/\.xml$/i, '');
        await ftpUploadFile(path, await generateSubfile(fileType, fileName, params));
      }
      useFlowStore.setState({ xmlFiles: (current.xmlFiles || []).map(file =>
        file.category === 'main' ? { ...file, currentXml: xml, dirty: false } : { ...file, dirty: false }
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
    if (!REMOTE_MODEL_UPLOAD_ENABLED) {
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
    // Uploading is deliberately locked while the reload path is being
    // validated. In particular, do not regenerate an unchanged legacy XML:
    // generation is lossy for fields not represented by the editor graph.
    const xml = await generateXml({
      aircraft: current.aircraft,
      nodes: current.nodes,
      edges: current.edges,
    });
    await ftpUploadModel(model, xml);
    for (const file of current.subFiles || []) {
      const fileXml = await generateSubfile(file.fileType, file.fileName, file.data);
      await ftpUploadFile(subFileRemotePath(file), fileXml);
    }
    for (const node of current.nodes || []) {
      const type = node.data?.componentType;
      const params = node.data?.params || {};
      const file = String(params.file || '').trim();
      if (!file || !['engine', 'propeller', 'system', 'flight_control'].includes(type)) continue;
      const fileType = type === 'system' || type === 'flight_control' ? 'system' : type === 'propeller' ? 'thruster' : 'engine';
      const fileName = file.replace(/^.*\//, '').replace(/\.xml$/i, '');
      const path = file.includes('/') ? `${file.replace(/\.xml$/i, '')}.xml` : `${fileType === 'system' ? 'systems' : 'engine'}/${fileName}.xml`;
      await ftpUploadFile(path, await generateSubfile(fileType, fileName, params));
    }
    const changedFiles = (current.xmlFiles || []).filter(file => file.dirty && file.category !== 'main');
    for (const file of changedFiles) {
      await ftpUploadFile(file.path, file.currentXml);
    }
    useFlowStore.setState({ xmlFiles: (current.xmlFiles || []).map(file =>
      file.category === 'main' ? { ...file, currentXml: xml, dirty: false } : { ...file, dirty: false }
    ) });
    localStorage.setItem('jsbsim-raw-xml', xml);
    localStorage.setItem('jsbsim-remote-model', model);
    localStorage.setItem(remoteBaselineKey(model), fingerprint);
    onLog?.(`[${new Date().toLocaleTimeString()}] 已同步模型到 NuttX: ${model}`);
    return true;
  };

  const handleSyncRemoteModel = (model: string) => syncRemoteModel(model, false);
  const handleForceSyncRemoteModel = async (model: string) => {
    if (!REMOTE_MODEL_UPLOAD_ENABLED) {
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
              📁 文件 <span className="file-menu-caret">▾</span>
            </button>
            {showFileMenu && (
              <div className="file-menu-dropdown" role="menu">
                <button role="menuitem" onClick={() => {
                  clearAll();
                  localStorage.removeItem('jsbsim-project');
                  localStorage.removeItem('jsbsim-raw-xml');
                  Object.keys(localStorage).filter(k => k.startsWith('jsbsim-remote-baseline:')).forEach(k => localStorage.removeItem(k));
                  setShowFileMenu(false);
                }}>📄 新建</button>
                <button role="menuitem" onClick={() => { setShowWizard(true); setShowFileMenu(false); }}>🪄 创建向导</button>
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => { void handleSave(); setShowFileMenu(false); }}>💾 保存</button>
                <button role="menuitem" onClick={() => { void handleSaveToSimulator(); setShowFileMenu(false); }}>🛰️ 保存到仿真机</button>
                <button role="menuitem" onClick={() => { void handleLoad(); setShowFileMenu(false); }}>📂 打开工程</button>
                {recentProjects.length > 0 && <>
                  <div className="file-menu-separator" />
                  <div className="file-menu-section-title">最近打开的工程</div>
                  {recentProjects.map(project => <button key={project.filename} role="menuitem" className="recent-project-item" title={project.path} onClick={() => { void handleLoad(project.filename); setShowFileMenu(false); }}>
                    <span>↗ {project.filename}</span><small>{project.path}</small>
                  </button>)}
                </>}
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => { fileInputRef.current?.click(); setShowFileMenu(false); }} title="导入 XML 文件（自动解析引用文件）">📥 导入 XML</button>
                <button role="menuitem" onClick={() => { void handleExportXml(); setShowFileMenu(false); }}>📤 导出 XML</button>
              </div>
            )}
          </div>
          <div className="file-menu-anchor" ref={editMenuRef}>
            <button className={`file-menu-trigger ${showEditMenu ? 'active' : ''}`}
              onClick={() => setShowEditMenu(value => !value)} aria-haspopup="menu" aria-expanded={showEditMenu}>
              ✏️ 编辑 <span className="file-menu-caret">▾</span>
            </button>
            {showEditMenu && (
              <div className="file-menu-dropdown" role="menu">
                <button role="menuitem" onClick={() => { onUndo?.(); setShowEditMenu(false); }}>↶ 撤销 <kbd>Ctrl+Z</kbd></button>
                <button role="menuitem" onClick={() => { onRedo?.(); setShowEditMenu(false); }}>↷ 恢复 <kbd>Ctrl+Y</kbd></button>
                <div className="file-menu-separator" />
                <button role="menuitem" onClick={() => { onCopy?.(); setShowEditMenu(false); }}>📋 复制 <kbd>Ctrl+C</kbd></button>
                <button role="menuitem" onClick={() => { onPaste?.(); setShowEditMenu(false); }}>📄 粘贴 <kbd>Ctrl+V</kbd></button>
              </div>
            )}
          </div>
          <div className="file-menu-anchor" ref={displayMenuRef}>
            <button className={`file-menu-trigger ${showDisplayMenu ? 'active' : ''}`} onClick={() => setShowDisplayMenu(value => !value)} aria-haspopup="menu" aria-expanded={showDisplayMenu}>
              👁️ 显示 <span className="file-menu-caret">▾</span>
            </button>
            {showDisplayMenu && <div className="file-menu-dropdown" role="menu">
              <button role="menuitem" onClick={() => { onToggleJsbsimLog(); setShowDisplayMenu(false); }}>🖥️ JSBSim 信息{jsbsimLogs.length ? ` (${jsbsimLogs.length})` : ''}</button>
              <button role="menuitem" onClick={() => { onShowLive(); setShowDisplayMenu(false); }}>🔴 实时</button>
              <button role="menuitem" onClick={() => { onShow3D(); setShowDisplayMenu(false); }}>🛩️ 3D</button>
            </div>}
          </div>
          <button onClick={() => setShowLibrary(true)} disabled={loading}>📚 模型库</button>
          <SimMenu loading={loading} onLog={onLog}
            onOpenRemoteModel={handleOpenRemoteModel}
            onSyncRemoteModel={handleSyncRemoteModel}
            onForceSyncRemoteModel={handleForceSyncRemoteModel}
            selectedModelFromLibrary={librarySimulationModel} />
        </div>
        <div className="toolbar-right">
          {isTauri && <div className="window-controls" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
            <button onClick={() => void windowAction('min')} title="最小化" aria-label="最小化"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10" /></svg></button>
            <button onClick={() => void windowAction('max')} title="最大化/还原" aria-label="最大化或还原"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1" /></svg></button>
            <button className="window-close" onClick={() => void windowAction('close')} title="关闭" aria-label="关闭"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
          </div>}
          <input ref={fileInputRef} type="file" accept=".xml" multiple onChange={handleImportXml} style={{ display: 'none' }} />
        </div>
      </div>

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
        />
      )}
    </>
  );
}
