import { useState, useEffect } from 'react';
import { getAircraftLibrary, loadAircraft, simListTests, ftpDownloadScript, ftpListEngineCatalog } from '../utils/tauriApi';

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
  onLoad: (data: any) => void;
  onSelectForSimulation?: (aircraftId: string) => void;
  onSelectScriptForSimulation?: (scriptPath: string) => void;
}

interface ScriptEntry { name: string; file: string; path: string; aircraft?: string; initialize?: string; start?: string; end?: string; dt?: string; events?: number; error?: string; sourcePath?: string }

export default function AircraftLibrary({ onClose, onLoad, onSelectForSimulation, onSelectScriptForSimulation }: Props) {
  const [tab, setTab] = useState<'models' | 'scripts' | 'engines' | 'propellers'>('models');
  const [library, setLibrary] = useState<AircraftEntry[]>([]);
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selected, setSelected] = useState<AircraftEntry | null>(null);
  const [loadingAircraft, setLoadingAircraft] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectedScript, setSelectedScript] = useState<ScriptEntry | null>(null);
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
        const tests = await simListTests();
        if (!active) return;
        setLibrary(data); setScripts(tests); setLoadError(''); setLoading(false);
      } catch (err: any) {
        if (!active) return;
        console.error(err);
        setLoadError(err?.message || String(err) || '无法读取 NuttX 模型库');
        setLoading(false);
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
  const visibleScripts = group === 'user' ? userScripts : scripts;
  const visibleComponents = tab === 'engines' ? engineFiles : propellerFiles;
  const copyModel = (aircraft: AircraftEntry) => {
    const name = window.prompt('请输入用户模型名称', `${aircraft.name} 副本`);
    if (!name?.trim()) return;
    const copy = { ...aircraft, id: `user-${Date.now()}`, name: name.trim(), sourceId: aircraft.sourceId || aircraft.id };
    setUserModels(current => { const next = [...current, copy]; localStorage.setItem('jsbsim-user-models', JSON.stringify(next)); return next; });
    setGroup('user'); setSelected(copy);
  };
  const copyScript = (script: ScriptEntry) => {
    const name = window.prompt('请输入用户脚本名称', `${(script.name || script.file).replace(/\.xml$/i, '')} 副本`);
    if (!name?.trim()) return;
    const copy = { ...script, name: `${name.trim()}.xml`, path: `user-script-${Date.now()}`, sourcePath: script.sourcePath || script.path };
    setUserScripts(current => { const next = [...current, copy]; localStorage.setItem('jsbsim-user-scripts', JSON.stringify(next)); return next; });
    setGroup('user'); setSelectedScript(copy);
  };

  const handleLoad = async (aircraft: AircraftEntry) => {
    setLoadingAircraft(true);
    try {
      const data = await loadAircraft(aircraft.sourceId || aircraft.id);
      onLoad(data);
      // Loading a model into the editor also makes it the launch target.
      // Keeping these as separate actions left simStart() without a model
      // parameter even though the canvas already showed that aircraft.
      onSelectForSimulation?.(aircraft.id);
      onClose();
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : (err?.message || err?.toString() || '未知错误');
      alert('加载失败：' + msg);
    }
    setLoadingAircraft(false);
  };

  const typeCounts = {
    all: library.length,
    fixed_wing: library.filter(a => a.type === 'fixed_wing').length,
    multirotor: library.filter(a => a.type === 'multirotor').length,
    helicopter: library.filter(a => a.type === 'helicopter').length,
    rocket: library.filter(a => a.type === 'rocket').length,
  };

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="library-modal" onClick={e => e.stopPropagation()}>
        <div className="library-header">
          <h2>📚 模型与脚本库</h2>
          <span className="library-count">{library.length} 个模型 · {scripts.length} 个脚本 · {engineFiles.length} 个发动机 · {propellerFiles.length} 个螺旋桨</span>
          <button className="wizard-close" onClick={onClose}>✕</button>
        </div>

        <div className="library-resource-tabs"><button className={tab === 'models' && group === 'nuttx' ? 'active' : ''} onClick={() => { setTab('models'); setGroup('nuttx'); }}>🛩️ NuttX 模型库 <b>{library.length}</b></button><button className={tab === 'scripts' && group === 'nuttx' ? 'active' : ''} onClick={() => { setTab('scripts'); setGroup('nuttx'); }}>📋 NuttX 脚本库 <b>{scripts.length}</b></button><button className={tab === 'engines' ? 'active' : ''} onClick={() => { setTab('engines'); setGroup('nuttx'); }}>⚙️ 发动机/电机库 <b>{engineFiles.length}</b></button><button className={tab === 'propellers' ? 'active' : ''} onClick={() => { setTab('propellers'); setGroup('nuttx'); }}>🌀 螺旋桨库 <b>{propellerFiles.length}</b></button><button className={tab === 'models' && group === 'user' ? 'active' : ''} onClick={() => { setTab('models'); setGroup('user'); }}>👤 用户模型 <b>{userModels.length}</b></button><button className={tab === 'scripts' && group === 'user' ? 'active' : ''} onClick={() => { setTab('scripts'); setGroup('user'); }}>👤 用户脚本 <b>{userScripts.length}</b></button></div>
        <div className="library-toolbar">
          <input
            type="text"
            className="library-search"
            placeholder={tab === 'models' ? '🔍 搜索模型名称...' : tab === 'scripts' ? '🔍 搜索脚本名称...' : '🔍 搜索文件名称...'}
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
        </div>

        <div className="library-body">
          <div className="library-list">
            {loading ? (
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

          {tab === 'models' && selected && (
            <div className="library-detail">
              <div className="library-detail-header">
                <span className="library-detail-icon">{TYPE_INFO[selected.type]?.icon || '🛩️'}</span>
                <div>
                  <h3>{selected.name}</h3>
                  <span className="library-detail-id">{selected.id}</span>
                </div>
              </div>
              {selected.description && <p className="library-detail-desc">{selected.description}</p>}
              <div className="library-detail-grid">
                <div><span>类型</span><strong>{TYPE_INFO[selected.type]?.label || selected.type}</strong></div>
                <div><span>版本</span><strong>{selected.version || '-'}</strong></div>
                <div><span>阶段</span><strong>{selected.release || '-'}</strong></div>
                <div><span>作者</span><strong>{selected.author || '-'}</strong></div>
                <div><span>主文件</span><strong>{selected.mainFile}</strong></div>
                <div><span>文件大小</span><strong>{(selected.size / 1024).toFixed(1)} KB</strong></div>
              </div>
              {selected.subFiles.length > 0 && (
                <div className="library-detail-files">
                  <strong>子文件 ({selected.subFileCount}):</strong>
                  <div className="library-file-list">
                    {selected.subFiles.map(f => <span key={f} className="library-file-tag">{f}</span>)}
                  </div>
                </div>
              )}
              <button
                className="library-load-btn"
                onClick={() => handleLoad(selected)}
                disabled={loadingAircraft}
              >
                {loadingAircraft ? '⏳ 加载中...' : '📥 加载此模型'}
              </button>
              {group === 'nuttx' && <button className="library-select-sim-btn" onClick={() => copyModel(selected)}>📄 复制到用户模型并重命名</button>}
              {onSelectForSimulation && (
                <button
                  className="library-select-sim-btn"
                  onClick={() => { onSelectForSimulation(selected.id); onClose(); }}
                  disabled={loadingAircraft}
                  title="选择后回到工具栏，点击“开始”运行该 NuttX 模型"
                >
                  ▶ 选择为待运行模型
                </button>
              )}
            </div>
          )}
          {tab === 'scripts' && selectedScript && <div className="library-detail"><div className="library-detail-header"><span className="library-detail-icon">📋</span><div><h3>{(selectedScript.name || selectedScript.file).replace(/\.xml$/i, '')}</h3><span className="library-detail-id">{selectedScript.path}</span></div></div>{selectedScript.error ? <p className="library-detail-desc">读取失败：{selectedScript.error}</p> : <><div className="library-detail-grid"><div><span>关联模型</span><strong>{selectedScript.aircraft || '读取中…'}</strong></div><div><span>初始化</span><strong>{selectedScript.initialize || '默认'}</strong></div><div><span>开始时间</span><strong>{selectedScript.start || '—'}</strong></div><div><span>结束时间</span><strong>{selectedScript.end || '—'}</strong></div><div><span>仿真间隔</span><strong>{selectedScript.dt || '—'}</strong></div><div><span>事件数量</span><strong>{selectedScript.events ?? '—'}</strong></div></div>{group === 'nuttx' && <button className="library-select-sim-btn" onClick={() => copyScript(selectedScript)}>📄 复制到用户脚本并重命名</button>}<button className="library-load-btn" disabled={!selectedScript.aircraft || selectedScript.aircraft === '未声明'} onClick={() => { onSelectScriptForSimulation?.(selectedScript.sourcePath || selectedScript.path); onClose(); }}>✎ 打开脚本编辑器</button></>}</div>}
        </div>
      </div>
    </div>
  );
}
