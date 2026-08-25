import { useState, useEffect, useRef, useCallback } from 'react';
import {
  simStart,
  simStop,
  simPause,
  simResume,
  simRestart,
  simGetStatus,
  simListTests,
  simListModels,
} from '../utils/tauriApi';

interface SimMenuProps {
  loading?: boolean;
}

interface TestScript {
  name: string;
  file: string;
  path: string;
}

interface AircraftModel {
  name: string;
  file: string;
  path: string;
}

type Submenu = 'model' | 'script' | null;

export default function SimMenu({ loading: parentLoading = false }: SimMenuProps) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [running, setRunning] = useState(false);
  const [external, setExternal] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [tests, setTests] = useState<TestScript[]>([]);
  const [models, setModels] = useState<AircraftModel[]>([]);
  const [selectedTest, setSelectedTest] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const wrapRef = useRef<HTMLDivElement>(null);

  const loadLists = useCallback(async () => {
    try {
      const [testList, modelList] = await Promise.all([
        simListTests(),
        simListModels(),
      ]);
      setTests(testList);
      setModels(modelList);
    } catch (err: any) {
      console.error('[SimMenu] Failed to load lists:', err);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const status = await simGetStatus();
      setExternal(!!status.external);
      setRunning(status.running);
      setPaused(!!status.paused);
      setCurrentScript(status.script || null);
      setCurrentModel(status.model || null);
    } catch {
      // ignore
    }
  }, []);

  // Open/close side-effects
  useEffect(() => {
    if (open) {
      loadLists();
      checkStatus();
      const id = setInterval(checkStatus, 1000);
      return () => clearInterval(id);
    }
  }, [open, loadLists, checkStatus]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenu(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const runBusy = parentLoading || loading;

  const handleRunSelected = useCallback(async () => {
    const script = selectedTest || undefined;
    const model = selectedModel || undefined;
    if (!script && !model) return;
    setLoading(true);
    setError('');
    try {
      const res = await simStart({ script, model });
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(res.model || null);
    } catch (err: any) {
      setError(err.message || '启动失败');
    }
    setLoading(false);
  }, [selectedTest, selectedModel]);

  const handleRunScript = useCallback(async (path: string) => {
    setSelectedTest(path);
    setSubmenu(null);
    setLoading(true);
    setError('');
    try {
      const res = await simStart({ script: path });
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(null);
    } catch (err: any) {
      setError(err.message || '启动失败');
    }
    setLoading(false);
  }, []);

  const handleRunModel = useCallback(async (path: string) => {
    setSelectedModel(path);
    setSubmenu(null);
    setLoading(true);
    setError('');
    try {
      const res = await simStart({ model: path });
      setRunning(true);
      setPaused(false);
      setCurrentModel(res.model || null);
      setCurrentScript(null);
    } catch (err: any) {
      setError(err.message || '启动失败');
    }
    setLoading(false);
  }, []);

  // 方案1：脚本本身已通过 <use aircraft> 指定模型，故“全部”= 运行选中的脚本
  //（若未选脚本但选了模型，则退而运行该模型）。脚本优先，不再同时传模型。
  const handleRunAll = useCallback(async () => {
    const script = selectedTest || undefined;
    const model = !selectedTest && selectedModel ? selectedModel : undefined;
    if (!script && !model) return;
    setLoading(true);
    setError('');
    try {
      const res = await simStart({ script, model });
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(res.model || null);
    } catch (err: any) {
      setError(err.message || '启动失败');
    }
    setLoading(false);
  }, [selectedTest, selectedModel]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await simStop();
      setRunning(false);
      setPaused(false);
      setCurrentScript(null);
      setCurrentModel(null);
    } catch (err: any) {
      setError(err.message || '停止失败');
    }
    setLoading(false);
  }, []);

  const handleRestart = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await simRestart();
      setRunning(true);
      setPaused(false);
    } catch (err: any) {
      setError(err.message || '重新运行失败');
    }
    setLoading(false);
  }, []);

  const handlePauseToggle = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (paused) {
        await simResume();
        setPaused(false);
      } else {
        await simPause();
        setPaused(true);
      }
    } catch (err: any) {
      setError(err.message || '操作失败');
    }
    setLoading(false);
  }, [paused]);

  const toggleSubmenu = (key: Submenu) => {
    setSubmenu(prev => (prev === key ? null : key));
  };

  const statusText = external
    ? (running ? '外部 HIL 仿真已连接' : '等待外部 HIL 仿真')
    : !running
    ? '已停止'
    : paused
      ? currentScript
        ? `已暂停: ${currentScript}`
        : currentModel
          ? `已暂停: ${currentModel}`
          : '已暂停'
      : currentScript
        ? `运行中: ${currentScript}`
        : currentModel
          ? `运行中: ${currentModel}`
          : '运行中';

  return (
    <div className="sim-menu-wrap" ref={wrapRef}>
      <button
        className={`sim-menu-trigger ${running ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        disabled={parentLoading}
        title="仿真控制"
      >
        🎮 仿真
      </button>

      {open && (
        <div className="sim-dropdown">
          <div className="sim-dropdown-header">
            <span className={`sim-status-dot ${running ? (paused ? 'paused' : 'running') : 'stopped'}`} />
            <span className="sim-status-text">{statusText}</span>
          </div>

          {external && (
            <div className="sim-menu-external-hint">
              JSBSim 由 px4-jsbsim-bridge 管理
            </div>
          )}

          <div className="sim-menu-list">
            <button
              className="sim-menu-item"
              onClick={handleRunSelected}
              disabled={runBusy || (!running && !selectedTest && !selectedModel)}
            >
              ▶ 运行
            </button>
            <button
              className="sim-menu-item"
              onClick={handleStop}
              disabled={runBusy || !running}
            >
              ⏹ 停止
            </button>
            <button
              className="sim-menu-item"
              onClick={handleRestart}
              disabled={runBusy || !running}
            >
              🔄 重新运行
            </button>
            <button
              className="sim-menu-item"
              onClick={handlePauseToggle}
              disabled={runBusy || !running}
            >
              {paused ? '▶ 继续' : '⏸ 暂停'}
            </button>

            <div className="sim-menu-divider" />

            <div className="sim-submenu">
              <button
                className={`sim-menu-item sim-menu-parent ${submenu === 'script' ? 'open' : ''}`}
                onClick={() => toggleSubmenu('script')}
              >
                📋 脚本选择 <span className="sim-caret">▸</span>
              </button>
              {submenu === 'script' && (
                <div className="sim-submenu-list">
                  {tests.length === 0 && <div className="sim-submenu-empty">无可用脚本</div>}
                  {tests.map(t => (
                    <button
                      key={t.path}
                      className={`sim-submenu-item ${selectedTest === t.path ? 'selected' : ''}`}
                      onClick={() => handleRunScript(t.path)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="sim-submenu">
              <button
                className={`sim-menu-item sim-menu-parent ${submenu === 'model' ? 'open' : ''}`}
                onClick={() => toggleSubmenu('model')}
              >
                🛩️ 模型 <span className="sim-caret">▸</span>
              </button>
              {submenu === 'model' && (
                <div className="sim-submenu-list">
                  {models.length === 0 && <div className="sim-submenu-empty">无可用模型</div>}
                  {models.map(m => (
                    <button
                      key={m.path}
                      className={`sim-submenu-item ${selectedModel === m.path ? 'selected' : ''}`}
                      onClick={() => handleRunModel(m.path)}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              className="sim-menu-item sim-menu-all"
              onClick={handleRunAll}
              disabled={runBusy || (!selectedTest && !selectedModel)}
              title="运行选中的脚本（脚本已包含模型）；未选脚本时运行选中的模型"
            >
              ✓ 全部
            </button>
          </div>

          {error && <div className="sim-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
