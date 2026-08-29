import { useState, useEffect } from 'react';
import { getAircraftLibrary, loadAircraft } from '../utils/tauriApi';

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
}

export default function AircraftLibrary({ onClose, onLoad, onSelectForSimulation }: Props) {
  const [library, setLibrary] = useState<AircraftEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selected, setSelected] = useState<AircraftEntry | null>(null);
  const [loadingAircraft, setLoadingAircraft] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    getAircraftLibrary()
      .then(data => { setLibrary(data); setLoadError(''); setLoading(false); })
      .catch(err => {
        console.error(err);
        setLoadError(err?.message || String(err) || '无法读取 NuttX 模型库');
        setLoading(false);
      });
  }, []);

  const filtered = library.filter(a => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase()) && !a.id.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleLoad = async (aircraft: AircraftEntry) => {
    setLoadingAircraft(true);
    try {
      const data = await loadAircraft(aircraft.id);
      onLoad(data);
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
          <h2>📚 飞机模型库</h2>
          <span className="library-count">{library.length} 个模型</span>
          <button className="wizard-close" onClick={onClose}>✕</button>
        </div>

        <div className="library-toolbar">
          <input
            type="text"
            className="library-search"
            placeholder="🔍 搜索飞机名称..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="library-filters">
            {Object.entries(typeCounts).map(([type, count]) => (
              <button
                key={type}
                className={`library-filter-btn ${typeFilter === type ? 'active' : ''}`}
                onClick={() => setTypeFilter(type)}
              >
                {type === 'all' ? '📋' : TYPE_INFO[type]?.icon} {type === 'all' ? '全部' : TYPE_INFO[type]?.label} ({count})
              </button>
            ))}
          </div>
        </div>

        <div className="library-body">
          <div className="library-list">
            {loading ? (
              <div className="library-loading">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="library-loading">
                {loadError ? `NuttX 模型库加载失败：${loadError}` : '没有找到匹配的飞机'}
              </div>
            ) : (
              filtered.map(a => {
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
                    <span className="library-item-size">{(a.size / 1024).toFixed(0)}K</span>
                  </div>
                );
              })
            )}
          </div>

          {selected && (
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
        </div>
      </div>
    </div>
  );
}
