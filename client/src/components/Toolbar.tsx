import { useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { generateXml, parseXml, saveProject, loadProject as loadProjectApi, ftpDownloadModel, ftpUploadModel } from '../utils/tauriApi';

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
}

function projectFingerprint(project: { aircraft: any; nodes: any[]; edges: any[]; subFiles?: any[] }): string {
  return JSON.stringify({
    aircraft: project.aircraft,
    nodes: project.nodes,
    edges: project.edges,
    subFiles: project.subFiles || [],
  });
}

function remoteBaselineKey(model: string): string {
  return `jsbsim-remote-baseline:${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export default function Toolbar({ onShow3D, onShowLive, jsbsimLogs = [], onLog, onToggleJsbsimLog, onUndo, onRedo, onCopy, onPaste }: ToolbarProps) {
  const { aircraft, setAircraft, nodes, edges, loadProject, clearAll } = useFlowStore();
  const [showXml, setShowXml] = useState(false);
  const [xmlContent, setXmlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [showDisplayMenu, setShowDisplayMenu] = useState(false);
  const [librarySimulationModel, setLibrarySimulationModel] = useState('');
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
    const filename = prompt('保存文件名:', 'project.json');
    if (!filename) return;
    try {
      await saveProject(filename, { aircraft, nodes, edges });
      alert('保存成功!');
    } catch (err: any) {
      alert('保存失败: ' + err.message);
    }
  };

  const handleLoad = async () => {
    const filename = prompt('加载文件名:', 'project.json');
    if (!filename) return;
    try {
      const data = await loadProjectApi(filename);
      loadProject(data);
    } catch (err: any) {
      alert('加载失败: ' + err.message);
    }
  };

  const handleCopyXml = () => {
    navigator.clipboard.writeText(xmlContent);
  };

  const handleOpenRemoteModel = async (model: string) => {
    const remote = await ftpDownloadModel(model);
    const data = await parseXml(remote.xml);
    loadProject(data);
    // Keep a separate baseline for every aircraft. A single global baseline
    // makes switching c172x -> 737 look like a local edit and can upload the
    // previous aircraft into the newly selected aircraft directory.
    localStorage.setItem(remoteBaselineKey(model), projectFingerprint(data));
    localStorage.setItem('jsbsim-project', JSON.stringify(data));
    localStorage.setItem('jsbsim-raw-xml', remote.xml);
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
                <button role="menuitem" onClick={() => { void handleLoad(); setShowFileMenu(false); }}>📂 加载</button>
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
            <button onClick={() => void windowAction('min')} title="最小化">−</button>
            <button onClick={() => void windowAction('max')} title="最大化/还原">□</button>
            <button className="window-close" onClick={() => void windowAction('close')} title="关闭">×</button>
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
