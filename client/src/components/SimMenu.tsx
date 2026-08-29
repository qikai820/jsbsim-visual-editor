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
  ftpDownloadScript,
} from '../utils/tauriApi';

interface SimMenuProps {
  loading?: boolean;
  onLog?: (message: string) => void;
  onOpenRemoteModel?: (model: string) => Promise<void>;
  onSyncRemoteModel?: (model: string) => Promise<boolean>;
  onForceSyncRemoteModel?: (model: string) => Promise<void>;
  selectedModelFromLibrary?: string;
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
type SimPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'restarting' | 'pausing' | 'paused' | 'resuming' | 'loading';

export default function SimMenu({ loading: parentLoading = false, onLog, onOpenRemoteModel, onSyncRemoteModel, onForceSyncRemoteModel, selectedModelFromLibrary = '' }: SimMenuProps) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [running, setRunning] = useState(false);
  const [external, setExternal] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [tests, setTests] = useState<TestScript[]>([]);
  const [models, setModels] = useState<AircraftModel[]>([]);
  const [selectedTest, setSelectedTest] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  /* The bridge clears status.model/status.script after STOP.  Keep the
   * user's last valid launch target independently so STOP never forces an
   * unnecessary second model selection before START can be used again. */
  const [preparedTarget, setPreparedTarget] = useState({ script: '', model: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<SimPhase>('idle');
  const [scriptEditor, setScriptEditor] = useState<{ name: string; aircraft: string; initialize: string; start: string; end: string; dt: string; events: { name: string; condition: string; actions: number; notify: number }[] }>({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
  const [scriptEditorExpanded, setScriptEditorExpanded] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  /* Once this UI has issued a lifecycle command, its successful result is
   * authoritative.  The NuttX bridge reports asynchronously over UDP and a
   * status poll must never alternate the Start/Stop button with stale frames. */
  const localLifecycleControlRef = useRef(false);

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
      const message = err?.message || String(err) || '无法读取 NuttX 模型目录';
      setError(`模型/脚本列表加载失败: ${message}`);
      onLog?.(`[${new Date().toLocaleTimeString()}] FTP 列表加载失败: ${message}`);
    }
  }, [onLog]);

  const checkStatus = useCallback(async () => {
    try {
      const status = await simGetStatus();
      setExternal(!!status.external);
      setConnected(!!status.connected);
      if (!localLifecycleControlRef.current) {
        setRunning(status.running);
        setPaused(!!status.paused);
        setPhase(status.state === 'paused' ? 'paused' :
          status.state === 'running' ? 'running' : 'idle');
      }
      setCurrentScript(status.script || null);
      setCurrentModel(status.model || null);
    } catch {
      // ignore
    }
  }, []);

  // Refresh the remote lists only when the menu is opened.
  useEffect(() => {
    if (open) {
      void loadLists();
    }
    // The toolbar log callback is recreated by the parent on render.  Do not
    // use that callback identity as a reason to reconnect to FTP repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the primary start/stop control correct even while the dropdown is
  // closed or the bridge state is changed by another client.
  useEffect(() => {
    checkStatus();
    const id = setInterval(checkStatus, 1000);
    return () => clearInterval(id);
  }, [checkStatus]);

  // The model library is also a simulation source.  Selecting an item there
  // prepares it for the primary "开始" action without forcing an XML upload.
  useEffect(() => {
    if (!selectedModelFromLibrary) return;
    setSelectedModel(selectedModelFromLibrary);
    setSelectedTest('');
    setPreparedTarget({ script: '', model: selectedModelFromLibrary });
    setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
    setScriptEditorExpanded(false);
    setPhase('idle');
  }, [selectedModelFromLibrary]);

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
  const appendLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString();
    onLog?.(`[${stamp}] ${message}`);
  }, []);
  const phaseText: Record<SimPhase, string> = {
    idle: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止',
    restarting: '正在重新运行', pausing: '正在暂停', paused: '已暂停', resuming: '正在继续', loading: '正在加载模型',
  };
  // Prefer the user's current selection. The bridge status can still report
  // the previously running aircraft while a new script/model is selected.
  const activeName = selectedTest || selectedModel || preparedTarget.script ||
    preparedTarget.model || currentScript || currentModel || '';
  const displayName = activeName.split('/').pop()?.replace(/\.xml$/i, '') || '';

  const handleRunSelected = useCallback(async () => {
    const script = selectedTest || preparedTarget.script || undefined;
    const model = !script ? (selectedModel || preparedTarget.model || undefined) : undefined;
    const modelToSync = selectedModel || preparedTarget.model || undefined;
    if (!script && !model) return;
    setLoading(true);
    setPhase('starting');
    appendLog(`启动请求: ${selectedModel || selectedTest || '当前选择'}`);
    setError('');
    try {
      if (modelToSync && onSyncRemoteModel) {
        setPhase('loading');
        const synced = await onSyncRemoteModel(modelToSync);
        if (synced) appendLog(`检测到本地修改，已同步模型到 NuttX: ${modelToSync}`);
        else appendLog(`未检测到本地修改，直接运行 NuttX 模型: ${modelToSync}`);
      }
      const res = await simStart({ script, model: script ? modelToSync : model });
      localLifecycleControlRef.current = true;
      setPreparedTarget({ script: script || '', model: modelToSync || '' });
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(res.model || null);
      setPhase('running');
    } catch (err: any) {
      setError(err.message || '启动失败');
    }
    setLoading(false);
  }, [selectedTest, selectedModel, preparedTarget, onSyncRemoteModel]);

  const handleRunScript = useCallback(async (path: string) => {
    setSubmenu(null);
    setLoading(true);
    setPhase('loading');
    appendLog(`正在读取 NuttX 脚本: ${path.split('/').pop()}`);
    setError('');
    try {
      if (running) {
        appendLog('切换脚本，先停止当前仿真');
        setPhase('stopping');
        await simStop();
        setRunning(false);
        setPaused(false);
        setCurrentScript(null);
        setCurrentModel(null);
        setPhase('loading');
      }
      setSelectedTest(path);
      const file = path.split('/').pop() || path;
      const script = await ftpDownloadScript(file);
      const documentXml = new DOMParser().parseFromString(script.xml, 'application/xml');
      if (documentXml.querySelector('parsererror')) throw new Error(`脚本 XML 解析失败: ${file}`);
      const aircraft = documentXml.querySelector('use')?.getAttribute('aircraft')?.trim();
      if (!aircraft) throw new Error(`脚本 ${file} 未声明 <use aircraft="...">`);
      if (!models.some(model => model.path === aircraft)) {
        throw new Error(`脚本关联模型 ${aircraft} 不在 NuttX 模型库中`);
      }
      setScriptEditor({
        name: file,
        aircraft,
        initialize: documentXml.querySelector('use')?.getAttribute('initialize') || '默认初始化',
        start: documentXml.querySelector('run')?.getAttribute('start') || '0',
        end: documentXml.querySelector('run')?.getAttribute('end') || '未设置',
        dt: documentXml.querySelector('run')?.getAttribute('dt') || '未设置',
        events: Array.from(documentXml.querySelectorAll('event')).map(event => ({
          name: event.getAttribute('name') || '未命名事件',
          condition: event.querySelector('condition')?.textContent?.trim().replace(/\s+/g, ' ') || '无条件',
          actions: event.querySelectorAll('set').length,
          notify: event.querySelectorAll('notify').length,
        })),
      });
      setScriptEditorExpanded(false);
      setSelectedModel(aircraft);
      setPreparedTarget({ script: path, model: aircraft });
      if (!onOpenRemoteModel) throw new Error('编辑器模型加载接口不可用');
      appendLog(`脚本关联模型: ${aircraft}，正在加载到编辑器`);
      await onOpenRemoteModel(aircraft);
      appendLog(`脚本 ${file} 及模型 ${aircraft} 已选择，点击“运行”启动脚本`);
      setPhase('idle');
    } catch (err: any) {
      setSelectedModel('');
      setError(err.message || '脚本加载失败');
      appendLog(`脚本加载失败: ${err.message || '未知错误'}`);
      setPhase('idle');
    }
      setLoading(false);
  }, [models, onOpenRemoteModel, running, paused, appendLog]);

  const handleSelectModel = useCallback(async (path: string) => {
    setSubmenu(null);
    setLoading(true);
    setPhase('loading');
    appendLog(`正在打开 NuttX 模型: ${path.split('/').pop()?.replace(/\.xml$/i, '')}`);
    setError('');
    try {
      // A direct model selection replaces the script context; do not leave
      // the previous script mini-flow floating over the canvas.
      setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
      setScriptEditorExpanded(false);
      if (running) {
        appendLog('切换模型，先停止当前仿真');
        setPhase('stopping');
        await simStop();
        setRunning(false);
        setPaused(false);
        setCurrentScript(null);
        setCurrentModel(null);
        setPhase('loading');
      }
      setSelectedModel(path);
      setSelectedTest('');
      setPreparedTarget({ script: '', model: path });
      if (!onOpenRemoteModel) throw new Error('编辑器模型加载接口不可用');
      await onOpenRemoteModel(path);
      appendLog(`模型已加载到编辑器: ${path}`);
      setPhase('idle');
    } catch (err: any) {
      setError(err.message || '模型加载失败');
      appendLog(`模型加载失败: ${err.message || '未知错误'}`);
      setPhase('idle');
    }
    setLoading(false);
  }, [onOpenRemoteModel, running, paused, appendLog]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    setPhase('stopping');
    appendLog('发送停止请求');
    setError('');
    try {
      await simStop();
      localLifecycleControlRef.current = true;
      setRunning(false);
      setPaused(false);
      /* Restore a target only if another state change cleared the visible
       * selection while the simulation was running. */
      setSelectedTest(current => current || preparedTarget.script);
      setSelectedModel(current => current || preparedTarget.model);
      setPhase('idle');
    } catch (err: any) {
      setError(err.message || '停止失败');
    }
    setLoading(false);
  }, [preparedTarget]);

  const handleForceSync = useCallback(async () => {
    if (!selectedModel || !onForceSyncRemoteModel) return;
    setLoading(true);
    setPhase('loading');
    setError('');
    try {
      appendLog(`强制上传模型到 NuttX: ${selectedModel}`);
      await onForceSyncRemoteModel(selectedModel);
      appendLog(`模型已强制更新到 NuttX: ${selectedModel}`);
    } catch (err: any) {
      setError(err.message || '模型上传失败');
      appendLog(`模型上传失败: ${err.message || '未知错误'}`);
    }
    setPhase(running ? (paused ? 'paused' : 'running') : 'idle');
    setLoading(false);
  }, [selectedModel, onForceSyncRemoteModel, appendLog, running, paused]);

  const handleRestart = useCallback(async () => {
    setLoading(true);
    setPhase('restarting');
    appendLog('发送重新运行请求');
    setError('');
    try {
      await simRestart();
      localLifecycleControlRef.current = true;
      setRunning(true);
      setPaused(false);
      setPhase('running');
    } catch (err: any) {
      setError(err.message || '重新运行失败');
    }
    setLoading(false);
  }, []);

  const handlePauseToggle = useCallback(async () => {
    setLoading(true);
    setPhase(paused ? 'resuming' : 'pausing');
    appendLog(paused ? '发送继续请求' : '发送暂停请求');
    setError('');
    try {
      if (paused) {
        await simResume();
        localLifecycleControlRef.current = true;
        setPaused(false);
        setPhase('running');
      } else {
        await simPause();
        localLifecycleControlRef.current = true;
        setPaused(true);
        setPhase('paused');
      }
    } catch (err: any) {
      setError(err.message || '操作失败');
      appendLog(`错误: ${err.message || '操作失败'}`);
    }
    setLoading(false);
  }, [paused]);

  const toggleSubmenu = (key: Submenu) => {
    setSubmenu(prev => (prev === key ? null : key));
  };

  const statusText = external
    ? (!connected ? '外部 HIL 未连接' : phaseText[phase])
    : phaseText[phase];

  const handlePrimaryAction = () => {
    if (running) {
      void handleStop();
    } else if (selectedTest || selectedModel || preparedTarget.script || preparedTarget.model) {
      void handleRunSelected();
    } else {
      setOpen(true);
    }
  };

  return (
    <div className="sim-menu-wrap" ref={wrapRef}>
      <div className={`sim-split-trigger ${running ? 'active' : ''}`}>
        <button
          className="sim-primary-action"
          onClick={handlePrimaryAction}
          disabled={runBusy}
          title={running ? '停止当前仿真' : (selectedTest || selectedModel || preparedTarget.script || preparedTarget.model ? '启动当前选择' : '选择脚本或模型')}
        >
          {phase === 'starting' || phase === 'loading' ? '⏳ 加载中' :
           phase === 'stopping' ? '⏳ 停止中' :
           running ? '⏹ 停止' : '▶ 开始'}
        </button>
        <button
          className="sim-dropdown-toggle"
          onClick={() => setOpen(o => !o)}
          disabled={runBusy}
          title="仿真菜单"
          aria-label="打开仿真菜单"
        >▾</button>
      </div>
      {(selectedTest || selectedModel || preparedTarget.script || preparedTarget.model) && (
        <span className="sim-selected-target" title={activeName}>
          {selectedTest ? '📋' : '🛩️'} {displayName}
        </span>
      )}

      {open && (
        <div className="sim-dropdown">
          <div className="sim-dropdown-header">
            <span className={`sim-status-dot ${phase === 'paused' ? 'paused' : phase === 'idle' ? 'stopped' : 'running'}`} />
            <div className="sim-status-info">
              <span className="sim-status-text">{statusText}</span>
              {displayName && <span className="sim-status-target" title={activeName}>{displayName}</span>}
            </div>
          </div>

          {external && (
            <div className="sim-menu-external-hint">
              JSBSim 由 px4-jsbsim-bridge 管理
            </div>
          )}

          <div className="sim-menu-list">
            <div className="sim-menu-section-title">🎮 仿真</div>
            {selectedModel && onForceSyncRemoteModel && (
              <button className="sim-menu-item" onClick={() => void handleForceSync()} disabled={runBusy}>
                ⬆️ 强制更新模型到 NuttX
              </button>
            )}
            {running && (
              <>
                <button className="sim-menu-item" onClick={handleRestart} disabled={runBusy || (external ? !connected : !running)}>
                  {phase === 'restarting' ? '⏳ 重新运行中…' : '🔄 重新运行'}
                </button>
                <button className="sim-menu-item" onClick={handlePauseToggle} disabled={runBusy}>
                  {phase === 'pausing' ? '⏳ 暂停中…' : phase === 'resuming' ? '⏳ 继续中…' : paused ? '▶ 继续' : '⏸ 暂停'}
                </button>
              </>
            )}

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
                      className={`sim-submenu-item sim-script-card ${selectedTest === t.path ? 'selected' : ''}`}
                      onClick={() => handleRunScript(t.path)}
                      disabled={runBusy}
                      title={`选择脚本 ${t.file}`}
                    >
                      <span className="sim-script-icon">▶</span>
                      <span className="sim-script-info">
                        <span className="sim-script-name">{t.name}</span>
                        <span className="sim-script-file">{t.file}</span>
                      </span>
                      <span className="sim-script-state">{selectedTest === t.path ? '已选' : '可运行'}</span>
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
                      onClick={() => handleSelectModel(m.path)}
                      disabled={runBusy}
                      title="从 NuttX 下载并在编辑器中打开；点击“运行”后启动仿真"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

          </div>

          {error && <div className="sim-error">{error}</div>}
        </div>
      )}
      {scriptEditor.name && !scriptEditorExpanded && (
        <button className="script-flow-mini" onClick={() => setScriptEditorExpanded(true)} title="点击查看完整脚本逻辑">
          <span className="script-flow-mini-head">📋 {scriptEditor.name}</span>
          <span className="script-flow-mini-meta">✈️ {scriptEditor.aircraft}　⏱ {scriptEditor.dt}s</span>
          <span className="script-flow-mini-track"><i>▶</i>{scriptEditor.events.slice(0, 4).map((event, index) => <i key={`${event.name}-${index}`}>{index + 1}</i>)}<i>■</i></span>
          <span className="script-flow-mini-hint">点击展开完整逻辑</span>
        </button>
      )}
      {scriptEditor.name && scriptEditorExpanded && (
        <div className="script-editor-overlay" onClick={() => setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] })}>
          <div className="script-editor-modal" onClick={e => e.stopPropagation()}>
            <div className="script-editor-head">
              <div><span className="script-editor-icon">📋</span><span>测试脚本逻辑</span><small>{scriptEditor.name}</small></div>
              <button onClick={() => setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] })}>×</button>
            </div>
            <div className="script-editor-summary">
              <span>✈️ 模型：<b>{scriptEditor.aircraft}</b></span>
              <span>⚙️ 初始化：<b>{scriptEditor.initialize}</b></span>
              <span>⏱️ 起止：<b>{scriptEditor.start} → {scriptEditor.end} s</b></span>
              <span>Δt：<b>{scriptEditor.dt} s</b></span>
            </div>
            <div className="script-flow-board">
              <div className="script-flow-start">▶ 开始仿真 <small>t = {scriptEditor.start}s</small></div>
              {scriptEditor.events.length === 0 && <div className="script-flow-empty">脚本没有事件配置</div>}
              {scriptEditor.events.map((event, index) => <div className="script-flow-event" key={`${event.name}-${index}`}><div className="script-flow-node-title"><span>{index + 1}</span>{event.name}</div><div className="script-flow-condition">◇ 条件：{event.condition}</div><div className="script-flow-actions">⚙ {event.actions} 个设置　📣 {event.notify} 个通知</div></div>)}
              <div className="script-flow-end">■ 结束仿真 <small>t = {scriptEditor.end}s</small></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
