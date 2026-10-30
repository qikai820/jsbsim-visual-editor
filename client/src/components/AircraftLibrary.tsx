import { useState, useEffect } from 'react';
import { getAircraftLibrary, loadAircraft, simListTests, ftpDownloadScript, ftpListEngineCatalog } from '../utils/tauriApi';
import { fleetSlotIds, normalizeFleetSlots, normalizeFleetInitialOverrides, normalizeFleetNetworkOverrides, readFleetModelGroups, saveFleetModelGroups, type FleetInitialOverrides, type FleetNetworkOverrides, type FleetModelGroup } from '../utils/fleetModelGroups';

interface AircraftEntry {
  id: string;
  name: string;
  directory: string;
  mainFile: string;
  filePath: string;
  version: string;
  release: string;
  description: string;
  author: string;
  type: string;
  size: number;
  subFileCount: number;
  subFiles: string[];
  sourceId?: string;
}

const TYPE_INFO: Record<string, { icon: string; label: string; color: string }> = {
  fixed_wing: { icon: '🛩️', label: '固定翼', color: '#3b82f6' },
  multirotor: { icon: '🚁', label: '多旋翼', color: '#10b981' },
  helicopter: { icon: '🚀', label: '直升机', color: '#f59e0b' },
  rocket: { icon: '🚀', label: '火箭', color: '#ef4444' },
};

interface Props {
  onClose: () => void;
  onLoad: (data: any, signal: AbortSignal) => void | Promise<void>;
  onSelectForSimulation?: (aircraftId: string) => void;
  onSelectScriptForSimulation?: (scriptPath: string) => void;
  currentFleetSlots?: Record<string, string>;
  currentFleetInitialOverrides?: FleetInitialOverrides;
  currentFleetNetworkOverrides?: FleetNetworkOverrides;
  onLoadFleetGroup?: (group: FleetModelGroup) => boolean | void;
  initialTab?: 'models' | 'fleet';
}

interface ScriptEntry { name: string; file: string; path: string; aircraft?: string; initialize?: string; start?: string; end?: string; dt?: string; events?: number; error?: string; sourcePath?: string }

function waitForModelLoad<T>(request: Promise<T>, stage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${stage}超过 90 秒，请检查仿真机连接后重试`)), 90_000);
    request.then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export default function AircraftLibrary({ onClose, onLoad, onSelectForSimulation, onSelectScriptForSimulation, currentFleetSlots, currentFleetInitialOverrides, currentFleetNetworkOverrides, onLoadFleetGroup, initialTab = 'models' }: Props) {
  const [tab, setTab] = useState<'models' | 'scripts' | 'engines' | 'propellers' | 'fleet'>(initialTab);
  const [library, setLibrary] = useState<AircraftEntry[]>([]);
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selected, setSelected] = useState<AircraftEntry | null>(null);
  const [loadingAircraft, setLoadingAircraft] = useState(false);
  const [loadStage, setLoadStage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [selectedScript, setSelectedScript] = useState<ScriptEntry | null>(null);
  const [fleetGroups, setFleetGroups] = useState(readFleetModelGroups);
  const [selectedFleetGroup, setSelectedFleetGroup] = useState<FleetModelGroup | null>(null);
  const [userModels, setUserModels] = useState<AircraftEntry[]>(() => JSON.parse(localStorage.getItem('jsbsim-user-models') || '[]'));
  const [userScripts, setUserScripts] = useState<ScriptEntry[]>(() => JSON.parse(localStorage.getItem('jsbsim-user-scripts') || '[]'));
  const [group, setGroup] = useState<'nuttx' | 'user'>('nuttx');
  const [engineFiles, setEngineFiles] = useState<string[]>([]);
  const [propellerFiles, setPropellerFiles] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    /* Both lists use the board's same USB vendor interface.  Load them in
     * sequence so opening this dialog never creates competing file requests
     * that could delay the real-time EP2 telemetry reader. */
    (async () => {
      try {
        const data = await getAircraftLibrary();
        if (!active) return;
        setLibrary(data); setLoadError(''); setLoading(false);
      } catch (err: any) {
        if (!active) return;
        console.error(err);
        const message = err?.message || String(err) || '无法读取 NuttX 模型库';
        setLoadError(message.includes('USB file response timed out')
          ? `${message}。可在“本地配置 → 仿真机通讯”切换到“网络”，然后重新打开模型库。`
          : message);
        setLoading(false);
        return;
      }
      try {
        const tests = await simListTests();
        if (active) setScripts(tests);
      } catch (error) {
        console.warn('NuttX 脚本库暂不可用：', error);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if ((tab !== 'engines' && tab !== 'propellers') || catalogLoaded || catalogLoading) return;
    setCatalogLoading(true);
    ftpListEngineCatalog()
      .then(catalog => {
        setEngineFiles(catalog.engines);
        setPropellerFiles(catalog.propellers);
        setCatalogLoaded(true);
      })
      .catch(err => console.warn('发动机/螺旋桨库暂不可用：', err))
      .finally(() => setCatalogLoading(false));
  }, [tab, catalogLoaded, catalogLoading]);

  const inspectScript = async (entry: ScriptEntry) => {
    setSelectedScript(entry);
    if (entry.aircraft || entry.error) return;
    try {
      const result = await ftpDownloadScript(entry.file || entry.name);
      const documentXml = new DOMParser().parseFromString(result.xml, 'application/xml');
      if (documentXml.querySelector('parsererror')) throw new Error('XML 解析失败');
      const use = documentXml.querySelector('use'); const run = documentXml.querySelector('run');
      const detail = { ...entry, aircraft: use?.getAttribute('aircraft') || '未声明', initialize: use?.getAttribute('initialize') || '默认', start: run?.getAttribute('start') || '0', end: run?.getAttribute('end') || '未设置', dt: run?.getAttribute('dt') || '未设置', events: documentXml.querySelectorAll('event').length };
      setScripts(current => current.map(item => item.path === entry.path ? detail : item)); setSelectedScript(detail);
    } catch (error: any) {
      const detail = { ...entry, error: error?.message || String(error) }; setScripts(current => current.map(item => item.path === entry.path ? detail : item)); setSelectedScript(detail);
    }
  };

  const filtered = library.filter(a => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase()) && !a.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const visibleModels = group === 'user' ? userModels : filtered;
  const visibleFleetGroups = fleetGroups.filter(item => !search ||
    `${item.name} ${Object.values(item.slots).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const visibleScripts = group === 'user' ? userScripts : scripts;
  const visibleComponents = tab === 'engines' ? engineFiles : propellerFiles;
  const activeModel = selected && (group === 'user' ? userModels : library).some(item => item.id === selected.id) ? selected : null;
  const activeScript = selectedScript && (group === 'user' ? userScripts : scripts).some(item => item.path === selectedScript.path) ? selectedScript : null;
  const activeFleetGroup = fleetGroups.find(item => item.id === selectedFleetGroup?.id) || null;
  const selectResource = (nextTab: typeof tab, nextGroup: typeof group) => {
    setTab(nextTab);
    setGroup(nextGroup);
    setSelected(null);
    setSelectedScript(null);
    setSelectedFleetGroup(null);
    setSearch('');
  };
  const persistFleetGroups = (next: FleetModelGroup[]) => {
    saveFleetModelGroups(next);
    setFleetGroups(next);
  };
  const createFleetGroup = () => {
    const slots = normalizeFleetSlots(currentFleetSlots);
    if (!fleetSlotIds(slots).some(id => slots[id])) {
      alert('请先在多机仿真页面为至少一个实例选择模型');
      return;
    }
    const input = window.prompt('模型组名称', `模型组 ${fleetGroups.length + 1}`);
    if (input === null) return;
    const name = input.trim();
    if (!name) { alert('模型组名称不能为空'); return; }
    if (fleetGroups.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      alert('模型组名称已存在'); return;
    }
    const created = { id: `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, slots,
      initialOverrides: normalizeFleetInitialOverrides(currentFleetInitialOverrides),
      networkOverrides: normalizeFleetNetworkOverrides(currentFleetNetworkOverrides) };
    persistFleetGroups([...fleetGroups, created]);
    setSelectedFleetGroup(created);
  };
  const renameFleetGroup = (entry: FleetModelGroup) => {
    const input = window.prompt('重命名模型组', entry.name);
    if (input === null) return;
    const name = input.trim();
    if (!name) { alert('模型组名称不能为空'); return; }
    if (fleetGroups.some(item => item.id !== entry.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      alert('模型组名称已存在'); return;
    }
    persistFleetGroups(fleetGroups.map(item => item.id === entry.id ? { ...item, name } : item));
  };
  const updateFleetGroup = (entry: FleetModelGroup) => {
    const slots = normalizeFleetSlots(currentFleetSlots);
    if (!fleetSlotIds(slots).some(id => slots[id])) {
      alert('当前编组没有已绑定模型的实例');
      return;
    }
    const updated = { ...entry, slots,
      initialOverrides: normalizeFleetInitialOverrides(currentFleetInitialOverrides),
      networkOverrides: normalizeFleetNetworkOverrides(currentFleetNetworkOverrides) };
    persistFleetGroups(fleetGroups.map(item => item.id === entry.id ? updated : item));
    setSelectedFleetGroup(updated);
  };
  const deleteFleetGroup = (entry: FleetModelGroup) => {
    if (!window.confirm(`从本机模型库删除「${entry.name}」？`)) return;
    persistFleetGroups(fleetGroups.filter(item => item.id !== entry.id));
    setSelectedFleetGroup(null);
  };
  const saveUserModels = (next: AircraftEntry[]) => {
    localStorage.setItem('jsbsim-user-models', JSON.stringify(next));
    setUserModels(next);
  };
  const saveUserScripts = (next: ScriptEntry[]) => {
    localStorage.setItem('jsbsim-user-scripts', JSON.stringify(next));
    setUserScripts(next);
  };
  const renameUserModel = (aircraft: AircraftEntry) => {
    const input = window.prompt('重命名用户模型', aircraft.name);
    if (input === null) return;
    const name = input.trim();
    if (!name) { alert('用户模型名称不能为空'); return; }
    if (userModels.some(item => item.id !== aircraft.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      alert('用户模型名称已存在'); return;
    }
    const renamed = { ...aircraft, name };
    saveUserModels(userModels.map(item => item.id === aircraft.id ? renamed : item));
    setSelected(renamed);
  };
  const deleteUserModel = (aircraft: AircraftEntry) => {
    if (!window.confirm(`从用户模型库删除「${aircraft.name}」？\n\n仅删除本机库中的条目，不会删除 NuttX 上的原始模型。`)) return;
    saveUserModels(userModels.filter(item => item.id !== aircraft.id));
    setSelected(null);
  };
  const renameUserScript = (script: ScriptEntry) => {
    const input = window.prompt('重命名用户脚本', (script.name || script.file).replace(/\.xml$/i, ''));
    if (input === null) return;
    const name = input.trim().replace(/\.xml$/i, '').trim();
    if (!name) { alert('用户脚本名称不能为空'); return; }
    const filename = `${name}.xml`;
    if (userScripts.some(item => item.path !== script.path && item.name.toLocaleLowerCase() === filename.toLocaleLowerCase())) {
      alert('用户脚本名称已存在'); return;
    }
    const renamed = { ...script, name: filename };
    saveUserScripts(userScripts.map(item => item.path === script.path ? renamed : item));
    setSelectedScript(renamed);
  };
  const deleteUserScript = (script: ScriptEntry) => {
    const name = (script.name || script.file).replace(/\.xml$/i, '');
    if (!window.confirm(`从用户脚本库删除「${name}」？\n\n仅删除本机库中的条目，不会删除 NuttX 上的原始脚本。`)) return;
    saveUserScripts(userScripts.filter(item => item.path !== script.path));
    setSelectedScript(null);
  };
  const copyModel = (aircraft: AircraftEntry) => {
    const name = window.prompt('请输入用户模型名称', `${aircraft.name} 副本`);
    if (!name?.trim()) return;
    const copy = { ...aircraft, id: `user-${Date.now()}`, name: name.trim(), sourceId: aircraft.sourceId || aircraft.id };
    saveUserModels([...userModels, copy]);
    setGroup('user'); setSelected(copy);
  };
  const copyScript = (script: ScriptEntry) => {
    const name = window.prompt('请输入用户脚本名称', `${(script.name || script.file).replace(/\.xml$/i, '')} 副本`);
    if (!name?.trim()) return;
    const copy = { ...script, name: `${name.trim()}.xml`, path: `user-script-${Date.now()}`, sourcePath: script.sourcePath || script.path };
    saveUserScripts([...userScripts, copy]);
    setGroup('user'); setSelectedScript(copy);
  };

  const handleLoad = async (aircraft: AircraftEntry) => {
    const controller = new AbortController();
    setLoadingAircraft(true);
    setLoadStage('读取模型文件');
    try {
      const data = await waitForModelLoad(loadAircraft(aircraft.sourceId || aircraft.id), '读取模型文件');
      setLoadStage('导入编辑画布');
      await waitForModelLoad(Promise.resolve().then(() => onLoad(data, controller.signal)), '导入编辑画布');
      // Loading a model into the editor also makes it the launch target.
      // Keeping these as separate actions left simStart() without a model
      // parameter even though the canvas already showed that aircraft.
      onSelectForSimulation?.(aircraft.sourceId || aircraft.id);
      onClose();
    } catch (err: any) {
      controller.abort();
      const msg = typeof err === 'string' ? err : (err?.message || err?.toString() || '未知错误');
      alert('加载失败：' + msg);
    }
    setLoadingAircraft(false);
    setLoadStage('');
  };

  const typeCounts = {
    all: library.length,
    fixed_wing: library.filter(a => a.type === 'fixed_wing').length,
    multirotor: library.filter(a => a.type === 'multirotor').length,
    helicopter: library.filter(a => a.type === 'helicopter').length,
    rocket: library.filter(a => a.type === 'rocket').length,
  };

  return (
    <div className="wizard-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="library-modal" onClick={e => e.stopPropagation()}>
        <div className="library-header">
          <h2>📚 模型与脚本库</h2>
          <span className="library-count">{library.length} 个模型 · {fleetGroups.length} 个多机模型组 · {scripts.length} 个脚本 · {engineFiles.length} 个发动机 · {propellerFiles.length} 个螺旋桨</span>
          <button className="wizard-close" onClick={onClose}>✕</button>
        </div>

        <div className="library-resource-tabs"><button className={tab === 'models' && group === 'nuttx' ? 'active' : ''} onClick={() => selectResource('models', 'nuttx')}>🛩️ NuttX 模型库 <b>{library.length}</b></button><button className={tab === 'fleet' ? 'active' : ''} onClick={() => selectResource('fleet', 'user')}>🛩️ 多机模型组 <b>{fleetGroups.length}</b></button><button className={tab === 'scripts' && group === 'nuttx' ? 'active' : ''} onClick={() => selectResource('scripts', 'nuttx')}>📋 NuttX 脚本库 <b>{scripts.length}</b></button><button className={tab === 'engines' ? 'active' : ''} onClick={() => selectResource('engines', 'nuttx')}>⚙️ 发动机/电机库 <b>{engineFiles.length}</b></button><button className={tab === 'propellers' ? 'active' : ''} onClick={() => selectResource('propellers', 'nuttx')}>🌀 螺旋桨库 <b>{propellerFiles.length}</b></button><button className={tab === 'models' && group === 'user' ? 'active' : ''} onClick={() => selectResource('models', 'user')}>👤 用户模型 <b>{userModels.length}</b></button><button className={tab === 'scripts' && group === 'user' ? 'active' : ''} onClick={() => selectResource('scripts', 'user')}>👤 用户脚本 <b>{userScripts.length}</b></button></div>
        <div className="library-toolbar">
          <input
            type="text"
            className="library-search"
            placeholder={tab === 'fleet' ? '🔍 搜索模型组名称...' : tab === 'models' ? '🔍 搜索模型名称...' : tab === 'scripts' ? '🔍 搜索脚本名称...' : '🔍 搜索文件名称...'}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {tab === 'models' && group === 'nuttx' && <div className="library-filters">
            {Object.entries(typeCounts).map(([type, count]) => (
              <button
                key={type}
                className={`library-filter-btn ${typeFilter === type ? 'active' : ''}`}
                onClick={() => setTypeFilter(type)}
              >
                {type === 'all' ? '📋' : TYPE_INFO[type]?.icon} {type === 'all' ? '全部' : TYPE_INFO[type]?.label} ({count})
              </button>
            ))}
          </div>}
          {tab === 'fleet' && <button className="library-fleet-create" onClick={createFleetGroup}>＋ 保存当前编组为模型组</button>}
        </div>

        <div className="library-body">
          <div className="library-list">
            {tab === 'fleet' ? (
              visibleFleetGroups.length ?
                visibleFleetGroups.map(item =>
                  <div key={item.id} className={`library-item ${activeFleetGroup?.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedFleetGroup(item)}>
                    <span className="library-item-icon">🛩️</span><div className="library-item-info"><div className="library-item-name">{item.name}</div><div className="library-item-meta"><span>{fleetSlotIds(item.slots).filter(id => item.slots[id]).length} 架模型</span><span>· 本机保存</span></div></div>
                  </div>) : <div className="library-loading">{search ? '没有找到匹配的模型组' : '暂无模型组，请先在多机仿真页配置槽位，再保存为模型组'}</div>
            ) : loading ? (
              <div className="library-loading">加载中...</div>
            ) : tab === 'models' && visibleModels.length === 0 ? (
              <div className="library-loading">
                {loadError ? `NuttX 模型库加载失败：${loadError}` : '没有找到匹配的飞机'}
              </div>
            ) : tab === 'models' ? (
              visibleModels.map(a => {
                const typeInfo = TYPE_INFO[a.type] || TYPE_INFO.fixed_wing;
                return (
                  <div
                    key={a.id}
                    className={`library-item ${selected?.id === a.id ? 'selected' : ''}`}
                    onClick={() => setSelected(a)}
                  >
                    <span className="library-item-icon">{typeInfo.icon}</span>
                    <div className="library-item-info">
                      <div className="library-item-name">{a.name}</div>
                      <div className="library-item-meta">
                        <span style={{ color: typeInfo.color }}>{typeInfo.label}</span>
                        {a.author && <span>· {a.author}</span>}
                        {a.subFileCount > 0 && <span>· {a.subFileCount} 个子文件</span>}
                      </div>
                    </div>
                    <span className="library-item-size">{group === 'user' ? '用户' : `${(a.size / 1024).toFixed(0)}K`}</span>
                  </div>
                );
              })
            ) : tab === 'scripts' ? visibleScripts.filter(script => !search || `${script.name} ${script.file} ${script.aircraft || ''}`.toLowerCase().includes(search.toLowerCase())).map(script => <div key={script.path} className={`library-item ${selectedScript?.path === script.path ? 'selected' : ''}`} onClick={() => void inspectScript(script)}><span className="library-item-icon">📋</span><div className="library-item-info"><div className="library-item-name">{(script.name || script.file).replace(/\.xml$/i, '')}</div><div className="library-item-meta"><span>{group === 'user' ? '用户脚本' : '测试脚本'}</span>{script.aircraft && <span>· 模型 {script.aircraft}</span>}</div></div><span className="library-item-size">XML</span></div>) : catalogLoading ? <div className="library-loading">发动机/螺旋桨库加载中...</div> : visibleComponents.filter(file => !search || file.toLowerCase().includes(search.toLowerCase())).map(file => <div key={file} className="library-item"><span className="library-item-icon">{tab === 'engines' ? '⚙️' : '🌀'}</span><div className="library-item-info"><div className="library-item-name">{file.replace(/\.xml$/i, '')}</div><div className="library-item-meta"><span>{tab === 'engines' ? '发动机 / 电机' : '螺旋桨'}</span><span>· ROMFS → SD</span></div></div><span className="library-item-size">XML</span></div>)}
          </div>

          {tab === 'fleet' && activeFleetGroup && <div className="library-detail">
            <div className="library-detail-header"><span className="library-detail-icon">🛩️</span><div><h3>{activeFleetGroup.name}</h3><span className="library-detail-id">多机模型组 · 本机保存</span></div></div>
            <p className="library-detail-desc">载入后将替换当前槽位的模型绑定、初始状态和网络覆盖；请在多机仿真页面启动实例。组参数不修改单模型配置。</p>
            <div className="library-fleet-slots">{fleetSlotIds(activeFleetGroup.slots).map(id => <div key={id}><strong>{id}</strong><span>{activeFleetGroup.slots[id] || '未配置'}{activeFleetGroup.initialOverrides[id] ? ' · 初始状态覆盖' : ''}{activeFleetGroup.networkOverrides[id] ? ' · 网口覆盖' : ''}</span></div>)}</div>
            <button className="library-load-btn" onClick={() => { if (onLoadFleetGroup?.(activeFleetGroup) !== false) onClose(); }} disabled={!onLoadFleetGroup}>📥 加载此模型组</button>
            <div className="library-user-actions"><button onClick={() => updateFleetGroup(activeFleetGroup)}>↻ 用当前编组更新</button><button onClick={() => renameFleetGroup(activeFleetGroup)}>✎ 重命名</button><button className="library-delete-btn" onClick={() => deleteFleetGroup(activeFleetGroup)}>删除</button></div>
          </div>}
          {tab === 'models' && activeModel && (
            <div className="library-detail">
              <div className="library-detail-header">
                <span className="library-detail-icon">{TYPE_INFO[activeModel.type]?.icon || '🛩️'}</span>
                <div>
                  <h3>{activeModel.name}</h3>
                  <span className="library-detail-id">{activeModel.id}</span>
                </div>
              </div>
              {activeModel.description && <p className="library-detail-desc">{activeModel.description}</p>}
              <div className="library-detail-grid">
                <div><span>类型</span><strong>{TYPE_INFO[activeModel.type]?.label || activeModel.type}</strong></div>
                <div><span>版本</span><strong>{activeModel.version || '-'}</strong></div>
                <div><span>阶段</span><strong>{activeModel.release || '-'}</strong></div>
                <div><span>作者</span><strong>{activeModel.author || '-'}</strong></div>
                <div><span>主文件</span><strong>{activeModel.mainFile}</strong></div>
                <div><span>文件大小</span><strong>{(activeModel.size / 1024).toFixed(1)} KB</strong></div>
              </div>
              {activeModel.subFiles.length > 0 && (
                <div className="library-detail-files">
                  <strong>子文件 ({activeModel.subFileCount}):</strong>
                  <div className="library-file-list">
                    {activeModel.subFiles.map(f => <span key={f} className="library-file-tag">{f}</span>)}
                  </div>
                </div>
              )}
              <button
                className="library-load-btn"
                onClick={() => handleLoad(activeModel)}
                disabled={loadingAircraft}
              >
                {loadingAircraft ? `⏳ ${loadStage}...` : '📥 加载此模型'}
              </button>
              {group === 'nuttx' && <button className="library-select-sim-btn" onClick={() => copyModel(activeModel)}>📄 复制到用户模型并重命名</button>}
              {group === 'user' && <div className="library-user-actions"><button onClick={() => renameUserModel(activeModel)}>✎ 重命名</button><button className="library-delete-btn" onClick={() => deleteUserModel(activeModel)}>删除</button></div>}
              {onSelectForSimulation && (
                <button
                  className="library-select-sim-btn"
                  onClick={() => { onSelectForSimulation(activeModel.sourceId || activeModel.id); onClose(); }}
                  disabled={loadingAircraft}
                  title="选择后回到工具栏，点击“开始”运行该 NuttX 模型"
                >
                  ▶ 选择为待运行模型
                </button>
              )}
            </div>
          )}
          {tab === 'scripts' && activeScript && <div className="library-detail"><div className="library-detail-header"><span className="library-detail-icon">📋</span><div><h3>{(activeScript.name || activeScript.file).replace(/\.xml$/i, '')}</h3><span className="library-detail-id">{activeScript.path}</span></div></div>{activeScript.error ? <p className="library-detail-desc">读取失败：{activeScript.error}</p> : <><div className="library-detail-grid"><div><span>关联模型</span><strong>{activeScript.aircraft || '读取中…'}</strong></div><div><span>初始化</span><strong>{activeScript.initialize || '默认'}</strong></div><div><span>开始时间</span><strong>{activeScript.start || '—'}</strong></div><div><span>结束时间</span><strong>{activeScript.end || '—'}</strong></div><div><span>仿真间隔</span><strong>{activeScript.dt || '—'}</strong></div><div><span>事件数量</span><strong>{activeScript.events ?? '—'}</strong></div></div>{group === 'nuttx' && <button className="library-select-sim-btn" onClick={() => copyScript(activeScript)}>📄 复制到用户脚本并重命名</button>}<button className="library-load-btn" disabled={!activeScript.aircraft || activeScript.aircraft === '未声明'} onClick={() => { onSelectScriptForSimulation?.(activeScript.sourcePath || activeScript.path); onClose(); }}>✎ 打开脚本编辑器</button></>}{group === 'user' && <div className="library-user-actions"><button onClick={() => renameUserScript(activeScript)}>✎ 重命名</button><button className="library-delete-btn" onClick={() => deleteUserScript(activeScript)}>删除</button></div>}</div>}
        </div>
      </div>
    </div>
  );
}
