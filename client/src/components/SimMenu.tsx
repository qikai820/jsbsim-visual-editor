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
  ftpUploadFile,
} from '../utils/tauriApi';
import ScriptEditorDialog, { type ScriptEditorValue } from './ScriptEditorDialog';

interface SimMenuProps {
  loading?: boolean;
  onLog?: (message: string) => void;
  onOpenRemoteModel?: (model: string) => Promise<void>;
  onSyncRemoteModel?: (model: string) => Promise<boolean>;
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

function readVariableCache(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function directChildren(element: Element, tagName: string): Element[] {
  return Array.from(element.children).filter(child => child.tagName.toLowerCase() === tagName);
}

function setOptionalAttribute(element: Element, name: string, value: string) {
  const normalized = value.trim();
  if (normalized) element.setAttribute(name, normalized);
  else element.removeAttribute(name);
}

/** Patch the downloaded runscript DOM so comments and unsupported attributes survive. */
function serializeRunScript(sourceXml: string, value: ScriptEditorValue): string {
  const documentXml = new DOMParser().parseFromString(sourceXml, 'application/xml');
  if (documentXml.querySelector('parsererror')) throw new Error('原始脚本 XML 无法解析');
  const use = documentXml.querySelector('runscript > use, use');
  const run = documentXml.querySelector('runscript > run, run');
  if (!use || !run) throw new Error('脚本缺少 <use> 或 <run> 节点');

  setOptionalAttribute(use, 'aircraft', value.aircraft);
  setOptionalAttribute(use, 'initialize', value.initialize);
  setOptionalAttribute(run, 'start', value.start);
  setOptionalAttribute(run, 'end', value.end);
  setOptionalAttribute(run, 'dt', value.dt);

  const existingEvents = directChildren(run, 'event');
  value.events.forEach((editedEvent, eventIndex) => {
    const eventElement = existingEvents[eventIndex] || documentXml.createElement('event');
    if (!existingEvents[eventIndex]) run.appendChild(eventElement);
    setOptionalAttribute(eventElement, 'name', editedEvent.name);

    let condition = directChildren(eventElement, 'condition')[0];
    if (!condition) {
      condition = documentXml.createElement('condition');
      eventElement.insertBefore(condition, eventElement.firstChild);
    }
    condition.textContent = editedEvent.condition.trim() ? ` ${editedEvent.condition.trim()} ` : '';

    const existingSets = directChildren(eventElement, 'set');
    editedEvent.sets.forEach((editedSet, setIndex) => {
      const setElement = existingSets[setIndex] || documentXml.createElement('set');
      if (!existingSets[setIndex]) {
        const notify = directChildren(eventElement, 'notify')[0];
        eventElement.insertBefore(setElement, notify || null);
      }
      setOptionalAttribute(setElement, 'name', editedSet.name);
      setOptionalAttribute(setElement, 'value', editedSet.value);
    });
    existingSets.slice(editedEvent.sets.length).forEach(element => element.remove());

    const existingNotifies = directChildren(eventElement, 'notify');
    editedEvent.notifies.forEach((editedNotify, notifyIndex) => {
      const notifyElement = existingNotifies[notifyIndex] || documentXml.createElement('notify');
      if (!existingNotifies[notifyIndex]) eventElement.appendChild(notifyElement);
      const text = editedNotify.trim();
      if (notifyElement.hasAttribute('name')) setOptionalAttribute(notifyElement, 'name', text);
      else notifyElement.textContent = text;
    });
    existingNotifies.slice(editedEvent.notifies.length).forEach(element => element.remove());
  });
  existingEvents.slice(value.events.length).forEach(element => element.remove());

  return new XMLSerializer().serializeToString(documentXml);
}

function formatCondition(condition: string): string {
  return condition
    .replace(/\bAND\b/gi, '∧')
    .replace(/\bOR\b/gi, '∨')
    .replace(/\bNOT\b/gi, '¬')
    .replace(/\b(nq|ne)\b/gi, '≠')
    .replace(/\b(le)\b/gi, '≤')
    .replace(/\b(ge)\b/gi, '≥')
    .replace(/\blt\b/gi, '<')
    .replace(/\bgt\b/gi, '>')
    .replace(/\beq\b/gi, '=')
    .replace(/\bproduct\b/gi, '×')
    .replace(/\bdifference\b/gi, '−')
    .replace(/\bquotient\b/gi, '÷')
    .replace(/\bsum\b/gi, 'Σ')
    .replace(/\b(avg|average)\b/gi, '平均')
    .replace(/\bpow\b/gi, '幂')
    .replace(/\bsqrt\b/gi, '√')
    .replace(/\b(abs)\b/gi, '|·|')
    .replace(/\b(mod)\b/gi, ' mod ')
    .replace(/\b(pi)\b/gi, 'π')
    .replace(/\b(ifthen)\b/gi, '条件选择')
    .replace(/\b(switch)\b/gi, '分支选择')
    .replace(/\s*&&\s*/g, ' ∧ ')
    .replace(/\s*\|\|\s*/g, ' ∨ ')
    .replace(/!=/g, ' ≠ ')
    .replace(/>=/g, ' ≥ ')
    .replace(/<=/g, ' ≤ ')
    .replace(/==/g, ' = ')
    .replace(/(^|\s)!\s*/g, '$1¬ ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCondition(condition: string): [string, string, string] {
  const match = condition.match(/^\s*(.*?)\s*(<=|>=|!=|==|<|>|=|\ble\b|\bge\b|\blt\b|\bgt\b|\beq\b|\bnq\b)\s*(.*?)\s*$/i);
  return match ? [match[1], match[2], match[3]] : [condition, '==', ''];
}

type Submenu = 'model' | 'script' | null;
type SimPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'restarting' | 'pausing' | 'paused' | 'resuming' | 'loading';

export default function SimMenu({ loading: parentLoading = false, onLog, onOpenRemoteModel, onSyncRemoteModel, selectedModelFromLibrary = '' }: SimMenuProps) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [running, setRunning] = useState(false);
  const [external, setExternal] = useState(false);
  const [connected, setConnected] = useState(false);
  const [cpuLoad, setCpuLoad] = useState<number | null>(null);
  const [cpuCores, setCpuCores] = useState<number[]>([]);
  const [memory, setMemory] = useState<{ total: number; used: number; free: number; percent: number } | null>(null);
  const [fdmRunMs, setFdmRunMs] = useState<number | null>(null);
  const [simulationDt, setSimulationDt] = useState<number | null>(null);
  const [fdmHistory, setFdmHistory] = useState<{ at: number; value: number }[]>([]);
  const [fdmPopupOpen, setFdmPopupOpen] = useState(false);
  const [fdmWindow, setFdmWindow] = useState<10 | 20 | 30>(10);
  const [cpuHistory, setCpuHistory] = useState<number[][]>([]);
  const [cpuPopupOpen, setCpuPopupOpen] = useState(false);
  const [remoteState, setRemoteState] = useState('disconnected');
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
  const [scriptEditor, setScriptEditor] = useState<ScriptEditorValue>({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
  const [scriptEditorExpanded, setScriptEditorExpanded] = useState(false);
  const [globalVariables, setGlobalVariables] = useState<string[]>(() => Array.from(new Set([
    ...readVariableCache('jsbsim-global-variables'),
    ...readVariableCache('jsbsim-available-variables'),
  ])));

  const wrapRef = useRef<HTMLDivElement>(null);
  const scriptSourceRef = useRef<{ path: string; xml: string }>({ path: '', xml: '' });
  useEffect(() => {
    const update = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail || [];
      setGlobalVariables(Array.from(new Set([...paths, ...readVariableCache('jsbsim-global-variables')])));
    };
    window.addEventListener('jsbsim-variables-updated', update);
    return () => window.removeEventListener('jsbsim-variables-updated', update);
  }, []);
  /* Once this UI has issued a lifecycle command, its successful result is
   * authoritative.  The NuttX bridge reports asynchronously over UDP and a
   * status poll must never alternate the Start/Stop button with stale frames. */
  const localLifecycleControlUntilRef = useRef(0);
  const crashReportedRef = useRef(false);
  const appendLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString();
    onLog?.(`[${stamp}] ${message}`);
  }, [onLog]);

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
      setCpuLoad(typeof status.cpu === 'number' ? status.cpu : null);
      const cores = Array.isArray(status.cpuCores)
        ? status.cpuCores.map((value: unknown) => Number(value)).filter(Number.isFinite)
        : [];
      setCpuCores(cores);
      const remoteMemory = status.memory;
      setMemory(remoteMemory && Number.isFinite(Number(remoteMemory.percent)) ? {
        total: Number(remoteMemory.total) || 0,
        used: Number(remoteMemory.used) || 0,
        free: Number(remoteMemory.free) || 0,
        percent: Number(remoteMemory.percent) || 0,
      } : null);
      const remoteFdmRunMs = Number(status.fdmRunMs);
      if (Number.isFinite(remoteFdmRunMs) && remoteFdmRunMs >= 0) {
        setFdmRunMs(remoteFdmRunMs);
        const now = Date.now();
        setFdmHistory(history => [...history, { at: now, value: remoteFdmRunMs }]
          .filter(sample => now - sample.at <= 30000));
      }
      const remoteSimulationDt = Number(status.simulationDt);
      setSimulationDt(Number.isFinite(remoteSimulationDt) && remoteSimulationDt > 0
        ? remoteSimulationDt : null);
      if (cores.length) {
        setCpuHistory(history => [...history, cores].slice(-100));
      }
      setRemoteState(status.state || (status.connected ? 'waiting' : 'disconnected'));
      /* LOAD recreates the remote task and may briefly return the old
       * `stopped` snapshot or report disconnected.  Only a confirmed crash
       * may bypass the local command grace period; otherwise that stale
       * snapshot makes the Start button flash back after one status poll. */
      const remoteCrashed = status.taskAlive === false || status.state === 'crashed';
      if (remoteCrashed || Date.now() >= localLifecycleControlUntilRef.current) {
        setRunning(status.running);
        setPaused(!!status.paused);
        setPhase(status.state === 'paused' ? 'paused' :
          status.state === 'running' ? 'running' : 'idle');
      }
      if (status.taskAlive === false || status.state === 'crashed') {
        if (!crashReportedRef.current) {
          crashReportedRef.current = true;
          setError('JSBSim 任务异常退出');
          appendLog('检测到 NuttX 上的 JSBSim 任务已退出');
        }
      } else if (status.running) {
        crashReportedRef.current = false;
      }
      setCurrentScript(status.script || null);
      setCurrentModel(status.model || null);
    } catch {
      // ignore
    }
  }, [appendLog]);

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
    /* Selecting a run script loads its aircraft into the canvas too.  That
     * model update must not be mistaken for an explicit model selection: it
     * would clear the script context and make the script editor disappear. */
    if (selectedTest) {
      setSelectedModel(selectedModelFromLibrary);
      setPreparedTarget(current => current.script
        ? { ...current, model: selectedModelFromLibrary }
        : current);
      return;
    }
    setSelectedModel(selectedModelFromLibrary);
    setSelectedTest('');
    setPreparedTarget({ script: '', model: selectedModelFromLibrary });
    setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
    setScriptEditorExpanded(false);
    setPhase('idle');
  }, [selectedModelFromLibrary, selectedTest]);

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
        try {
          const synced = await onSyncRemoteModel(modelToSync);
          if (synced) appendLog(`检测到本地修改，已同步模型到 NuttX: ${modelToSync}`);
          else appendLog(`未上传本地修改，直接运行 NuttX 现有模型: ${modelToSync}`);
        } catch (syncErr: any) {
          // A failed optional upload must not prevent starting the model that
          // is already present on NuttX. This is especially important after
          // Stop: an FTP timeout used to leave the UI in "启动失败" forever.
          appendLog(`模型同步失败，继续启动 NuttX 现有模型: ${syncErr?.message || syncErr}`);
        }
      }
      localLifecycleControlUntilRef.current = Date.now() + 35000;
      const res = await simStart({ script, model: script ? modelToSync : model });
      setPreparedTarget({ script: script || '', model: modelToSync || '' });
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(res.model || null);
      setPhase('running');
    } catch (err: any) {
      const message = err.message || '启动失败';
      setError(message);
      appendLog(`启动失败: ${message}`);
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
      if (models.length > 0 && !models.some(model => model.path === aircraft)) {
        throw new Error(`脚本关联模型 ${aircraft} 不在 NuttX 模型库中`);
      }
      setScriptEditor({
        name: file,
        aircraft,
        initialize: documentXml.querySelector('use')?.getAttribute('initialize') || '',
        start: documentXml.querySelector('run')?.getAttribute('start') || '0',
        end: documentXml.querySelector('run')?.getAttribute('end') || '',
        dt: documentXml.querySelector('run')?.getAttribute('dt') || '',
        events: Array.from(documentXml.querySelectorAll('event')).map(event => ({
          name: event.getAttribute('name') || '未命名事件',
          condition: event.querySelector('condition')?.textContent?.trim().replace(/\s+/g, ' ') || '无条件',
          sets: Array.from(event.querySelectorAll('set')).map(set => ({ name: set.getAttribute('name') || '', value: set.getAttribute('value') || '' })),
          notifies: Array.from(event.querySelectorAll('notify')).map(notify => notify.textContent?.trim().replace(/\s+/g, ' ') || notify.getAttribute('name') || ''),
        })),
      });
      scriptSourceRef.current = {
        path: path.startsWith('scripts/') ? path : `scripts/${file}`,
        xml: script.xml,
      };
      setScriptEditorExpanded(true);
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

  const handleSaveScript = useCallback(async (value: ScriptEditorValue) => {
    if (!value.aircraft.trim()) throw new Error('关联模型不能为空');
    const source = scriptSourceRef.current;
    if (!source.path || !source.xml) throw new Error('缺少从仿真机下载的原始脚本');
    const remotePath = source.path.startsWith('scripts/')
      ? source.path
      : `scripts/${source.path.split('/').pop()}`;
    const xml = serializeRunScript(source.xml, value);
    appendLog(`正在上传脚本到 NuttX: ${remotePath}`);
    await ftpUploadFile(remotePath, xml);

    // Read the file back through the same FTP path. A successful upload alone
    // is not enough evidence that the live script contains the edited bytes.
    const file = remotePath.split('/').pop() || value.name;
    const verified = await ftpDownloadScript(file);
    if (verified.xml.trim() !== xml.trim()) {
      throw new Error('上传后回读内容不一致，仿真机脚本未确认更新');
    }
    scriptSourceRef.current = { path: remotePath, xml: verified.xml };
    localStorage.setItem(`jsbsim-script-editor:${value.name}`, JSON.stringify(value));
    setScriptEditor(value);
    setSelectedTest(remotePath);
    setSelectedModel(value.aircraft.trim());
    setPreparedTarget({ script: remotePath, model: value.aircraft.trim() });
    appendLog(`脚本已写入并回读确认: /mnt/sdcard/jsbsim/${remotePath}`);
    await loadLists();
  }, [appendLog, loadLists]);

  useEffect(() => {
    const selectScript = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; openEditor?: boolean }>).detail;
      const path = String(typeof detail === 'string' ? detail : detail?.path || '').trim();
      if (path) {
        void handleRunScript(path).then(() => {
          if (detail && typeof detail !== 'string' && detail.openEditor) setScriptEditorExpanded(true);
        });
      }
    };
    window.addEventListener('jsbsim-library-script-selected', selectScript);
    return () => window.removeEventListener('jsbsim-library-script-selected', selectScript);
  }, [handleRunScript]);

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
      localLifecycleControlUntilRef.current = Date.now() + 3000;
      setRunning(false);
      setPaused(false);
      /* Restore a target only if another state change cleared the visible
       * selection while the simulation was running. */
      setSelectedTest(current => current || preparedTarget.script);
      setSelectedModel(current => current || preparedTarget.model);
      setPhase('idle');
    } catch (err: any) {
      const message = err.message || '停止失败';
      setError(message);
      appendLog(`停止失败: ${message}`);
      setPhase(paused ? 'paused' : 'running');
    }
    setLoading(false);
  }, [preparedTarget, paused, appendLog]);

  const handleRestart = useCallback(async () => {
    setLoading(true);
    setPhase('restarting');
    appendLog(`重新运行当前模型: ${displayName || '当前模型'}`);
    setError('');
    try {
      await simRestart();
      localLifecycleControlUntilRef.current = Date.now() + 3000;
      setRunning(true);
      setPaused(false);
      setPhase('running');
    } catch (err: any) {
      setError(err.message || '重新运行失败');
    }
    setLoading(false);
  }, [appendLog, displayName]);

  const handlePauseToggle = useCallback(async () => {
    setLoading(true);
    setPhase(paused ? 'resuming' : 'pausing');
    appendLog(paused ? '发送继续请求' : '发送暂停请求');
    setError('');
    try {
      if (paused) {
        await simResume();
        localLifecycleControlUntilRef.current = Date.now() + 3000;
        setPaused(false);
        setPhase('running');
      } else {
        const result = await simPause();
        localLifecycleControlUntilRef.current = Date.now() + 3000;
        if (result?.stopped) {
          setPaused(false);
          setRunning(false);
          setPhase('idle');
          appendLog('模型已自然结束，当前为停止状态');
        } else {
          setPaused(true);
          setPhase('paused');
        }
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message :
        (typeof err === 'string' ? err : '操作失败');
      setError(message);
      appendLog(`错误: ${message}`);
    }
    setLoading(false);
  }, [paused]);

  const toggleSubmenu = (key: Submenu) => {
    setSubmenu(prev => (prev === key ? null : key));
  };

  useEffect(() => {
    if (!submenu) return;
    const id = window.setTimeout(() => {
      const selected = wrapRef.current?.querySelector<HTMLElement>(
        `[data-submenu="${submenu}"][data-selected="true"]`,
      );
      selected?.scrollIntoView({ block: 'nearest' });
    }, 0);
    return () => window.clearTimeout(id);
  }, [submenu, selectedTest, selectedModel]);

  const statusText = external
    ? (!connected ? '等待连接' : remoteState === 'waiting' ? '已连接 · 等待开始' : phaseText[phase])
    : phaseText[phase];
  /* Reload creates a new bridge/UDP task.  It can legitimately take longer
   * than the two-second packet timeout, so distinguish that expected gap from
   * a real disconnected board while a lifecycle request is still pending. */
  const awaitingReloadTelemetry = external && !connected &&
    Date.now() < localLifecycleControlUntilRef.current;
  const connectionClass = connected ? 'online' :
    (awaitingReloadTelemetry ? 'syncing' : 'offline');
  const connectionLabel = connected ? '已连接' :
    (awaitingReloadTelemetry ? '重载中' : '等待连接');
  // On an external NuttX target this is a simulator/system status bar rather
  // than a model-only indicator.  Keep connection, CPU, RAM and the latest FDM
  // timing visible while the model is stopped so board health remains
  // observable between runs and reloads.
  const showRuntimeStatus = external || running || phase !== 'idle';
  const fdmVisibleHistory = fdmHistory.filter(sample => Date.now() - sample.at <= fdmWindow * 1000);
  const fdmChartMax = Math.max(0.1, ...fdmVisibleHistory.map(sample => sample.value)) * 1.1;
  const fdmValues = fdmVisibleHistory.map(sample => sample.value);
  const fdmAverage = fdmValues.length ? fdmValues.reduce((sum, value) => sum + value, 0) / fdmValues.length : 0;
  const fdmMaximum = fdmValues.length ? Math.max(...fdmValues) : 0;
  const fdmMinimum = fdmValues.length ? Math.min(...fdmValues) : 0;
  const fdmChartPoints = fdmVisibleHistory.map(sample => {
    const age = Date.now() - sample.at;
    const x = 240 - Math.min(fdmWindow * 1000, age) * 240 / (fdmWindow * 1000);
    const y = 92 - Math.min(92, sample.value * 92 / fdmChartMax);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const handlePrimaryAction = () => {
    if (running) {
      if (paused) {
        void handlePauseToggle();
      } else {
        void handleStop();
      }
    } else if (selectedTest || selectedModel || preparedTarget.script || preparedTarget.model) {
      void handleRunSelected();
    } else {
      setOpen(true);
    }
  };

  useEffect(() => {
    if (showRuntimeStatus) return;
    setCpuPopupOpen(false);
    setFdmPopupOpen(false);
  }, [showRuntimeStatus]);

  return (
    <div className="sim-menu-wrap" ref={wrapRef}>
      <div className={`sim-split-trigger ${running ? 'active' : ''}`}>
        <button
          className="sim-primary-action"
          onClick={handlePrimaryAction}
          disabled={runBusy}
          title={running ? (paused ? '继续当前仿真' : '停止当前仿真') : (selectedTest || selectedModel || preparedTarget.script || preparedTarget.model ? '启动当前选择' : '选择脚本或模型')}
        >
          {phase === 'starting' || phase === 'loading' ? '⏳ 加载中' :
           phase === 'stopping' ? '⏳ 停止中' :
           running ? (paused ? '▶ 继续' : '⏹ 停止') : '▶ 开始'}
        </button>
        <button
          className="sim-dropdown-toggle"
          onClick={() => setOpen(o => !o)}
          disabled={runBusy}
          title="仿真菜单"
          aria-label="打开仿真菜单"
        >▾</button>
      </div>
      {activeName && (
        <span className="sim-selected-target" title={activeName}>
          {(selectedTest || preparedTarget.script || currentScript) ? '📋' : '🛩️'} {displayName}
        </span>
      )}
      {showRuntimeStatus && (
        <span className={`sim-connection-chip ${connectionClass}`} title="仿真机连接状态">
          <span className="sim-connection-dot" />
          {connectionLabel}
          {external && cpuCores.length > 0 && (
            <button className="sim-connection-cpu" onClick={() => setCpuPopupOpen(open => !open)}>
              CPU {cpuCores.map((value, index) => `${index}:${value.toFixed(0)}%`).join(' · ')}
            </button>
          )}
          {external && memory && (
            <span className="sim-connection-memory" title={`已用 ${(memory.used / 1048576).toFixed(1)} MiB / ${(memory.total / 1048576).toFixed(1)} MiB`}>
              RAM {memory.percent.toFixed(1)}%
            </span>
          )}
          {external && fdmRunMs != null && (
            <span className="sim-connection-fdm" role="button" tabIndex={0} title="单击查看 FDM 运行时间曲线" onClick={() => setFdmPopupOpen(open => !open)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setFdmPopupOpen(open => !open); }}>
              FDM {fdmRunMs.toFixed(3)} ms <small>⌁</small>
            </span>
          )}
        </span>
      )}
      {showRuntimeStatus && cpuPopupOpen && cpuCores.length > 0 && (
        <div className="sim-cpu-popup">
          <div className="sim-cpu-popup-head"><b>双核 CPU 利用率</b><span>10 Hz</span></div>
          <svg className="sim-cpu-chart" viewBox="0 0 240 92" preserveAspectRatio="none">
            {[25, 50, 75].map(value => <line key={value} x1="0" x2="240" y1={92-value*.92} y2={92-value*.92} className="sim-cpu-grid" />)}
            {cpuCores.map((_, core) => {
              const points = cpuHistory.map((sample, index) => `${cpuHistory.length < 2 ? 0 : index * 240 / (cpuHistory.length - 1)},${92 - Math.max(0, Math.min(100, sample[core] || 0)) * .92}`).join(' ');
              return <polyline key={core} points={points} className={`sim-cpu-line core-${core}`} />;
            })}
          </svg>
          <div className="sim-cpu-legend">
            {cpuCores.map((value, core) => <span key={core} className={`core-${core}`}>CPU{core} <b>{value.toFixed(1)}%</b></span>)}
          </div>
        </div>
      )}
      {showRuntimeStatus && fdmPopupOpen && fdmRunMs != null && (
        <div className="sim-fdm-popup">
          <div className="sim-cpu-popup-head"><b>FDM 单步运行时间</b><span>{fdmRunMs.toFixed(3)} ms</span></div>
          <div className="sim-fdm-window-picker">
            {([10, 20, 30] as const).map(seconds => <button key={seconds} className={fdmWindow === seconds ? 'active' : ''} onClick={() => setFdmWindow(seconds)}>{seconds}s</button>)}
          </div>
          <svg className="sim-cpu-chart" viewBox="0 0 240 92" preserveAspectRatio="none">
            {[.25, .5, .75].map(value => <line key={value} x1="0" x2="240" y1={92 - value * 92} y2={92 - value * 92} className="sim-cpu-grid" />)}
            <polyline points={fdmChartPoints} className="sim-fdm-line" />
          </svg>
          <div className="sim-fdm-chart-scale"><span>{fdmChartMax.toFixed(3)} ms</span><span>0 ms</span></div>
          <div className="sim-fdm-stats">
            <span>平均 <b>{fdmAverage.toFixed(3)} ms</b></span>
            <span>最大 <b>{fdmMaximum.toFixed(3)} ms</b></span>
            <span>最小 <b>{fdmMinimum.toFixed(3)} ms</b></span>
          </div>
        </div>
      )}

      {open && (
        <div className="sim-dropdown">
          <div className="sim-dropdown-header">
            <span className={`sim-status-dot ${phase === 'paused' ? 'paused' : phase === 'idle' ? 'stopped' : 'running'}`} />
            <div className="sim-status-info">
              <span className="sim-status-text">{statusText}</span>
              {displayName && <span className="sim-status-target" title={activeName}>{displayName}</span>}
              {external && cpuLoad !== null && (
                <span className="sim-status-target">
                  CPU {cpuLoad.toFixed(1)}%
                  {simulationDt != null && ` · 步长 ${simulationDt.toFixed(4)} s · ${(1 / simulationDt).toFixed(0)} Hz`}
                </span>
              )}
            </div>
          </div>

          {external && (
            <div className="sim-menu-external-hint">
              JSBSim 由 px4-jsbsim-bridge 管理
            </div>
          )}

          <div className="sim-menu-list">
            <div className="sim-menu-section-title">🎮 仿真</div>
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
                📋 脚本选择{selectedTest && ` · ${selectedTest.split('/').pop()?.replace(/\.xml$/i, '')}`} <span className="sim-caret">▸</span>
              </button>
              {submenu === 'script' && (
                <div className="sim-submenu-list">
                  {tests.length === 0 && <div className="sim-submenu-empty">无可用脚本</div>}
                  {tests.map(t => (
                    <button
                      key={t.path}
                      data-submenu="script"
                      data-selected={selectedTest === t.path ? 'true' : 'false'}
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
                🛩️ 模型{selectedModel && ` · ${selectedModel.split('/').pop()?.replace(/\.xml$/i, '')}`} <span className="sim-caret">▸</span>
              </button>
              {submenu === 'model' && (
                <div className="sim-submenu-list">
                  {models.length === 0 && <div className="sim-submenu-empty">无可用模型</div>}
                  {models.map(m => (
                    <button
                      key={m.path}
                      data-submenu="model"
                      data-selected={selectedModel === m.path ? 'true' : 'false'}
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
      {scriptEditor.name && scriptEditorExpanded && <ScriptEditorDialog value={scriptEditor} variables={globalVariables} onChange={setScriptEditor} onSave={handleSaveScript} onClose={() => setScriptEditorExpanded(false)} />}
    </div>
  );
}
