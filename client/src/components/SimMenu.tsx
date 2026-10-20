import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  simStart,
  simStop,
  simPause,
  simResume,
  simRestart,
  simGetStatus,
  simListTests,
  simListModels,
  type FlightControllerStatus,
  type FdmWindowStats,
  type McapStatus,
  ftpDownloadScript,
  ftpUploadFile,
} from '../utils/tauriApi';
import ScriptEditorDialog, { type ScriptEditorValue } from './ScriptEditorDialog';
import { useSimSocket } from '../sim/useSimSocket';
import { validateXmlSource, showXmlDiagnostic } from '../utils/xmlDiagnostics';
import { MAX_PERFORMANCE_PERIOD_SECONDS, readPerformancePeriod } from '../utils/performanceSettings';

export interface FleetControls {
  connected: boolean;
  configuredCount: number;
  runningCount: number;
  pausedCount: number;
  busy: boolean;
  error: string;
  onCommand: (action: 'start' | 'pause' | 'resume' | 'stop') => void;
}

interface SimMenuProps {
  fleetControls?: FleetControls;
  statusOnly?: boolean;
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

function flightMode(status: FlightControllerStatus | null): string {
  if (!status?.heartbeat_alive || status.status_stale) return '--';
  if (status.autopilot === 12) { // MAV_AUTOPILOT_PX4
    const main = (status.custom_mode >>> 16) & 0xff;
    const sub = (status.custom_mode >>> 24) & 0xff;
    if (main === 4) {
      const autoModes: Record<number, string> = {
        1: '自动待命', 2: '起飞', 3: '盘旋', 4: '任务', 5: '返航',
        6: '降落', 7: '返场', 8: '跟随', 9: '精准降落',
      };
      return autoModes[sub] || `自动(${sub})`;
    }
    const modes: Record<number, string> = {
      1: '手动', 2: '高度', 3: '位置', 5: '特技', 6: 'Offboard',
      7: '增稳', 8: 'Rattitude',
    };
    return modes[main] || `PX4(${main})`;
  }
  return status.base_mode & 1 ? `自定义(${status.custom_mode})` :
    status.base_mode & 4 ? '自动' : status.base_mode & 8 ? '引导' : '手动';
}

function confirmRunExistingModel(model: string, error: unknown, action: '启动' | '重新运行'): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return window.confirm(
    `本地模型同步失败：\n${detail}\n\n是否${action}仿真机上现有的 ${model}？本地新增或修改的模块不会生效。\n\n确定 = 使用板上现有模型；取消 = 留在编辑器修正配置。`,
  );
}

// These IDs are unique in the PX4 board configurations used by this project.
// Other IDs can be shared by different boards and must remain unidentified.
const PX4_BOARD_MODELS: Record<number, string> = {
  0x0033: 'PX4 FMU v5X 系列',
  0x0035: 'PX4 FMU v6X 系列',
  0x0039: 'ARK FMU v6X',
  0x003a: 'ARK Pi6X',
  0x004e: 'Holybro Pix32 v5',
  0x1012: 'CubePilot Cube Yellow',
  0x1013: 'Matek H743 Slim',
  0x1016: 'CubePilot Cube Orange',
  0x1017: 'mRo Pixracer Pro',
  0x1022: 'mRo Control Zero Classic',
  0x1023: 'mRo Control Zero H7',
  0x1024: 'mRo Control Zero H7 OEM',
  0x1058: 'CubePilot Cube Orange+',
};

function flightControllerModel(status: FlightControllerStatus): string {
  if (status.status_stale) return '--';
  const model = status.heartbeat_alive ? status.model_name?.trim() : '';
  if (model) {
    const vendor = status.vendor_name?.trim();
    return vendor && !model.toLowerCase().includes(vendor.toLowerCase()) ? `${vendor} ${model}` : model;
  }
  const usbProduct = status.usb_connected ? status.usb_product?.trim() : '';
  if (usbProduct && !/^(PX4|ArduPilot|CDC ACM Serial|USB Serial|USB CDC|NuttX CDC\/ACM)$/i.test(usbProduct)) return usbProduct;
  if (status.autopilot === 12 && status.board_id_available && status.board_id != null) {
    const boardModel = PX4_BOARD_MODELS[status.board_id];
    return boardModel ? `${boardModel}（Board ID 推断）` : '未识别';
  }
  return '未识别';
}

function flightControllerUsbId(status: FlightControllerStatus): string {
  if (status.status_stale || !status.usb_connected || !status.usb_info_available ||
      status.usb_vendor_id == null || status.usb_product_id == null) return '--';
  return `${status.usb_vendor_id.toString(16).toUpperCase().padStart(4, '0')}:${status.usb_product_id.toString(16).toUpperCase().padStart(4, '0')}`;
}

function flightControllerFirmware(autopilot: number): string {
  if (autopilot === 12) return 'PX4';
  if (autopilot === 3) return 'ArduPilot';
  return `MAVLink 类型 ${autopilot}`;
}

function readVariableCache(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const SIM_TARGET_CACHE_KEY = 'jsbsim-last-simulation-target';

function readSavedSimulationTarget(): { script: string; model: string } {
  try {
    const value = JSON.parse(localStorage.getItem(SIM_TARGET_CACHE_KEY) || '{}');
    return {
      script: typeof value?.script === 'string' ? value.script : '',
      model: typeof value?.model === 'string' ? value.model : '',
    };
  } catch {
    return { script: '', model: '' };
  }
}

function saveSimulationTarget(script: string, model: string) {
  localStorage.setItem(SIM_TARGET_CACHE_KEY, JSON.stringify({ script, model }));
}

function scriptEditorCacheKey(path: string) {
  const file = path.split('/').pop() || path;
  return `jsbsim-script-editor:${file}`;
}

function readSavedScriptEditor(path: string): ScriptEditorValue | null {
  if (!path) return null;
  try {
    const value = JSON.parse(localStorage.getItem(scriptEditorCacheKey(path)) || 'null');
    return value && typeof value.name === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseScriptEditorValue(file: string, xml: string): ScriptEditorValue {
  validateXmlSource(xml, file);
  const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
  if (documentXml.querySelector('parsererror')) throw new Error(`脚本 XML 解析失败: ${file}`);
  const aircraft = documentXml.querySelector('use')?.getAttribute('aircraft')?.trim();
  if (!aircraft) throw new Error(`脚本 ${file} 未声明 <use aircraft="...">`);
  return {
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
  };
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
      const originalText = notifyElement.textContent?.trim().replace(/\s+/g, ' ') || notifyElement.getAttribute('name') || '';
      // An untouched <notify> may contain many <property> children and other
      // JSBSim metadata. Keep that structure when editing another field.
      if (existingNotifies[notifyIndex] && text === originalText) return;
      if (notifyElement.hasAttribute('name')) {
        setOptionalAttribute(notifyElement, 'name', text);
      } else {
        const properties = directChildren(notifyElement, 'property');
        if (!text) {
          properties.forEach(element => element.remove());
          return;
        }
        const property = properties[0] || documentXml.createElement('property');
        if (!properties[0]) notifyElement.appendChild(property);
        property.textContent = text;
        properties.slice(1).forEach(element => element.remove());
      }
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
type NetworkCounter = { at: number; rxBytes: number; txBytes: number };
type NetworkRate = { rx: number; tx: number };
type NetworkPort = 'eth0' | 'eth1';
type NetworkHistorySample = { at: number; name: NetworkPort; rx: number; tx: number };
type McapCounter = { at: number; bytes: number };

function formatMcapBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatNetworkRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1048576) return `${(bytesPerSecond / 1048576).toFixed(2)} MiB/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
}

export default function SimMenu({ statusOnly = false, loading: parentLoading = false, onLog, fleetControls, onOpenRemoteModel, onSyncRemoteModel, selectedModelFromLibrary = '' }: SimMenuProps) {
  const { telemetry } = useSimSocket();
  const savedTargetRef = useRef(readSavedSimulationTarget());
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [running, setRunning] = useState(false);
  const [external, setExternal] = useState(false);
  const [connected, setConnected] = useState(false);
  const [cpuLoad, setCpuLoad] = useState<number | null>(null);
  const [cpuCores, setCpuCores] = useState<number[]>([]);
  const [flightController, setFlightController] = useState<FlightControllerStatus | null>(null);
  const [flightControllerPopupOpen, setFlightControllerPopupOpen] = useState(false);
  const flightControllerRef = useRef<HTMLDivElement>(null);
  const [mcapStatus, setMcapStatus] = useState<McapStatus | null>(null);
  const [mcapRate, setMcapRate] = useState<number | null>(null);
  const mcapCounterRef = useRef<McapCounter | null>(null);
  const [mcapPopupOpen, setMcapPopupOpen] = useState(false);
  const mcapRef = useRef<HTMLDivElement>(null);
  const [healthFresh, setHealthFresh] = useState(false);
  const [memory, setMemory] = useState<{ total: number; used: number; free: number; percent: number } | null>(null);
  const [fdmRunMs, setFdmRunMs] = useState<number | null>(null);
  const [fdmIsWindow, setFdmIsWindow] = useState(false);
  const [fdmDetails, setFdmDetails] = useState<FdmWindowStats | null>(null);
  const fdmSampleKeyRef = useRef<string | null>(null);
  const fdmSampleSourceRef = useRef<string | null>(null);
  const [simulationDt, setSimulationDt] = useState<number | null>(null);
  const [fdmHistory, setFdmHistory] = useState<{ at: number; value: number; peak: number; samples: number }[]>([]);
  const [performancePopupOpen, setPerformancePopupOpen] = useState(false);
  const [hiddenPerformanceSeries, setHiddenPerformanceSeries] = useState<Record<string, boolean>>({});
  const togglePerformanceSeries = (series: string) => {
    setHiddenPerformanceSeries(hidden => ({ ...hidden, [series]: !hidden[series] }));
  };
  const [performancePeriod, setPerformancePeriod] = useState(readPerformancePeriod);
  const [fdmMultiplier, setFdmMultiplier] = useState<1 | 2 | 3 | 4>(1);
  const fdmWindow = performancePeriod * fdmMultiplier;
  const [cpuHistory, setCpuHistory] = useState<{ at: number; values: number[] }[]>([]);
  const networkCounterRef = useRef<Record<string, NetworkCounter>>({});
  const networkSeenRef = useRef<Record<string, number>>({});
  const [networkRates, setNetworkRates] = useState<Record<string, NetworkRate>>({});
  const [networkHistory, setNetworkHistory] = useState<NetworkHistorySample[]>([]);
  const [networkAvailable, setNetworkAvailable] = useState<string[]>([]);
  const [networkReported, setNetworkReported] = useState(false);
  const [remoteState, setRemoteState] = useState('disconnected');
  const [paused, setPaused] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [tests, setTests] = useState<TestScript[]>([]);
  const [models, setModels] = useState<AircraftModel[]>([]);
  const [selectedTest, setSelectedTest] = useState(() => readSavedSimulationTarget().script);
  const [selectedModel, setSelectedModel] = useState(() => readSavedSimulationTarget().model);
  /* The bridge clears status.model/status.script after STOP.  Keep the
   * user's last valid launch target independently so STOP never forces an
   * unnecessary second model selection before START can be used again. */
  const [preparedTarget, setPreparedTarget] = useState(() => readSavedSimulationTarget());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<SimPhase>('idle');
  const [scriptEditor, setScriptEditor] = useState<ScriptEditorValue>(() =>
    readSavedScriptEditor(savedTargetRef.current.script) || { name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
  const [scriptEditorExpanded, setScriptEditorExpanded] = useState(false);
  const [globalVariables, setGlobalVariables] = useState<string[]>(() => Array.from(new Set([
    ...readVariableCache('jsbsim-global-variables'),
    ...readVariableCache('jsbsim-available-variables'),
  ])));

  useEffect(() => {
    if (statusOnly) return;
    if (selectedTest || selectedModel || preparedTarget.script || preparedTarget.model) {
      saveSimulationTarget(
        selectedTest || preparedTarget.script,
        selectedModel || preparedTarget.model,
      );
    }
  }, [statusOnly, selectedTest, selectedModel, preparedTarget]);

  useEffect(() => {
    const updatePeriod = () => setPerformancePeriod(readPerformancePeriod());
    window.addEventListener('jsbsim-local-settings-changed', updatePeriod);
    return () => window.removeEventListener('jsbsim-local-settings-changed', updatePeriod);
  }, []);

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
  const launchInProgressRef = useRef(false);
  const crashReportedRef = useRef(false);
  const appendLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString();
    onLog?.(`[${stamp}] ${message}`);
  }, [onLog]);

  useEffect(() => {
    if (statusOnly) return;
    const path = savedTargetRef.current.script;
    if (!path) return;
    let cancelled = false;
    const file = path.split('/').pop() || path;
    void ftpDownloadScript(file).then(script => {
      if (cancelled) return;
      const value = parseScriptEditorValue(file, script.xml);
      scriptSourceRef.current = { path: path.startsWith('scripts/') ? path : `scripts/${file}`, xml: script.xml };
      localStorage.setItem(scriptEditorCacheKey(path), JSON.stringify(value));
      setScriptEditor(value);
      setSelectedModel(value.aircraft);
      setPreparedTarget({ script: path, model: value.aircraft });
    }).catch(error => appendLog(`恢复脚本编辑失败: ${error?.message || error}`));
    return () => { cancelled = true; };
    // Restore once at startup; parent log callback identity is not stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // A short loss of the desktop transport must not erase the board's
      // independently reported flight-controller state. The backend marks a
      // cached record stale once it has genuinely aged out.
      setFlightController(status.flightController || null);
      const fresh = !!status.connected && typeof status.healthAgeMs === 'number' &&
        status.healthAgeMs <= 1500;
      setHealthFresh(fresh);
      const mcap = fresh ? status.mcap || null : null;
      setMcapStatus(mcap);
      if (!mcap?.recording || mcap.stopping || mcap.bufferFull || !Number.isSafeInteger(mcap.recordedBytes)) {
        mcapCounterRef.current = null;
        setMcapRate(null);
      } else {
        const now = Date.now();
        const previous = mcapCounterRef.current;
        if (!previous || mcap.recordedBytes < previous.bytes) {
          mcapCounterRef.current = { at: now, bytes: mcap.recordedBytes };
          setMcapRate(null);
        } else if (now - previous.at >= 900) {
          setMcapRate((mcap.recordedBytes - previous.bytes) * 1000 / (now - previous.at));
          mcapCounterRef.current = { at: now, bytes: mcap.recordedBytes };
        }
      }
      setNetworkReported(Array.isArray(status.network));
      if (!fresh) {
        networkCounterRef.current = {};
        networkSeenRef.current = {};
        setNetworkRates({});
        setNetworkAvailable([]);
      } else {
        const counters = Array.isArray(status.network) ? status.network : [];
        const now = Date.now();
        const available = counters.filter(counter =>
          (counter.name === 'eth0' || counter.name === 'eth1') &&
          Number.isSafeInteger(counter.rxBytes) && counter.rxBytes >= 0 &&
          Number.isSafeInteger(counter.txBytes) && counter.txBytes >= 0);
        for (const counter of available) networkSeenRef.current[counter.name] = now;
        const visible = ['eth0', 'eth1'].filter(name =>
          networkSeenRef.current[name] != null && now - networkSeenRef.current[name] < 2000);
        setNetworkAvailable(visible);
        for (const name of ['eth0', 'eth1']) {
          if (!visible.includes(name)) {
            delete networkCounterRef.current[name];
          }
        }
        for (const counter of available) {
          const previous = networkCounterRef.current[counter.name];
          if (!previous || counter.rxBytes < previous.rxBytes || counter.txBytes < previous.txBytes) {
            networkCounterRef.current[counter.name] = { at: now, rxBytes: counter.rxBytes, txBytes: counter.txBytes };
            if (previous) setNetworkHistory(history => history.filter(sample => sample.name !== counter.name));
            setNetworkRates(rates => {
              const next = { ...rates };
              delete next[counter.name];
              return next;
            });
          } else if (now - previous.at >= 900) {
            const seconds = (now - previous.at) / 1000;
            const rate = {
              rx: (counter.rxBytes - previous.rxBytes) / seconds,
              tx: (counter.txBytes - previous.txBytes) / seconds,
            };
            setNetworkRates(rates => ({ ...rates, [counter.name]: rate }));
            setNetworkHistory(history => [...history, { at: now, name: counter.name as NetworkPort, ...rate }]
              .filter(sample => now - sample.at <= MAX_PERFORMANCE_PERIOD_SECONDS * 4 * 1000));
            networkCounterRef.current[counter.name] = { at: now, rxBytes: counter.rxBytes, txBytes: counter.txBytes };
          }
        }
      }
      const remoteMemory = status.memory;
      setMemory(remoteMemory && Number.isFinite(Number(remoteMemory.percent)) ? {
        total: Number(remoteMemory.total) || 0,
        used: Number(remoteMemory.used) || 0,
        free: Number(remoteMemory.free) || 0,
        percent: Number(remoteMemory.percent) || 0,
      } : null);
      const window = status.fdmWindow;
      const hasWindow = !!window && window.samples > 0 && Number.isFinite(window.averageMs) && Number.isFinite(window.maxMs);
      const remoteFdmRunMs = hasWindow ? window!.averageMs
        : typeof status.fdmRunMs === 'number' ? status.fdmRunMs : null;
      const peak = hasWindow ? window!.maxMs : remoteFdmRunMs;
      setFdmDetails(fresh && status.state === 'running' && hasWindow ? window! : null);
      const sampleSource = `${status.model || ''}:${hasWindow ? 'window' : 'sample'}`;
      if (!fresh || status.state !== 'running') {
        fdmSampleKeyRef.current = null;
      } else {
        setFdmIsWindow(hasWindow);
        if (sampleSource !== fdmSampleSourceRef.current) {
          fdmSampleKeyRef.current = null;
          setFdmHistory([]);
        }
        fdmSampleSourceRef.current = sampleSource;
      }
      if (remoteFdmRunMs != null && Number.isFinite(remoteFdmRunMs) && remoteFdmRunMs >= 0) {
        setFdmRunMs(remoteFdmRunMs);
        const sampleKey = hasWindow && window!.sequence != null ? `${sampleSource}:${window!.sequence}` : null;
        if (fresh && status.state === 'running' && !launchInProgressRef.current &&
            (sampleKey === null || sampleKey !== fdmSampleKeyRef.current)) {
          fdmSampleKeyRef.current = sampleKey;
          const now = Date.now();
          setFdmHistory(history => [...history, { at: now, value: remoteFdmRunMs, peak: peak ?? remoteFdmRunMs, samples: hasWindow ? window!.samples : 1 }]
            .filter(sample => now - sample.at <= MAX_PERFORMANCE_PERIOD_SECONDS * 4 * 1000));
        }
      }
      const remoteSimulationDt = Number(status.simulationDt);
      setSimulationDt(Number.isFinite(remoteSimulationDt) && remoteSimulationDt > 0
        ? remoteSimulationDt : null);
      if (fresh && cores.length) {
        const now = Date.now();
        setCpuHistory(history => [...history, { at: now, values: cores }]
          .filter(sample => now - sample.at <= MAX_PERFORMANCE_PERIOD_SECONDS * 4 * 1000));
      }
      setRemoteState(status.state || (status.connected ? 'waiting' : 'disconnected'));
      /* LOAD recreates the remote task and may briefly return the old
       * `stopped` snapshot or report disconnected.  Only a confirmed crash
       * may bypass the local command grace period; otherwise that stale
       * snapshot makes the Start button flash back after one status poll. */
      const remoteCrashed = status.state !== 'loading' &&
        (status.taskAlive === false || status.state === 'crashed');
      /* A stopped state has already passed the backend's command-handshake
       * resolution and now comes from the periodic board heartbeat. Let it
       * end the local start grace period immediately when a script finishes. */
      const heartbeatStopped = status.state === 'stopped';
      if (!launchInProgressRef.current &&
          (remoteCrashed || heartbeatStopped || status.state === 'loading' ||
           Date.now() >= localLifecycleControlUntilRef.current)) {
        if (heartbeatStopped) localLifecycleControlUntilRef.current = 0;
        setRunning(status.running);
        setPaused(!!status.paused);
        setPhase(status.state === 'loading' ? 'loading' :
          status.state === 'paused' ? 'paused' :
          status.state === 'running' ? 'running' : 'idle');
      }
      if (!launchInProgressRef.current && remoteCrashed) {
        if (!crashReportedRef.current) {
          crashReportedRef.current = true;
          setError('JSBSim 任务异常退出');
          appendLog('检测到 NuttX 上的 JSBSim 任务已退出');
        }
      } else if (status.running) {
        crashReportedRef.current = false;
        setError(current => current === 'JSBSim 任务异常退出' ? '' : current);
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
    // Match the board's stopped/paused task_top telemetry rate so CPU, RAM
    // and FDM timing continue to visibly refresh when the model is idle.
    const id = setInterval(checkStatus, 100);
    return () => clearInterval(id);
  }, [checkStatus]);

  // The model library is also a simulation source.  Selecting an item there
  // prepares it for the primary "开始" action without forcing an XML upload.
  const lastLibraryModelRef = useRef(selectedModelFromLibrary);
  useEffect(() => {
    if (!selectedModelFromLibrary || lastLibraryModelRef.current === selectedModelFromLibrary) return;
    lastLibraryModelRef.current = selectedModelFromLibrary;
    /* Selecting a run script loads its aircraft into the canvas too.  That
     * model update must not be mistaken for an explicit model selection: it
     * would clear the script context and make the script editor disappear. */
    const scriptModel = scriptEditor.aircraft.trim() || preparedTarget.model;
    if ((selectedTest || preparedTarget.script) && scriptModel === selectedModelFromLibrary) {
      setSelectedModel(selectedModelFromLibrary);
      setPreparedTarget(current => current.script
        ? { ...current, model: selectedModelFromLibrary }
        : current);
      saveSimulationTarget(
        selectedTest || preparedTarget.script,
        selectedModelFromLibrary,
      );
      return;
    }
    setSelectedModel(selectedModelFromLibrary);
    setSelectedTest('');
    setPreparedTarget({ script: '', model: selectedModelFromLibrary });
    setScriptEditor({ name: '', aircraft: '', initialize: '', start: '', end: '', dt: '', events: [] });
    setScriptEditorExpanded(false);
    setPhase('idle');
    saveSimulationTarget('', selectedModelFromLibrary);
    // Only an actual model-library change should replace the selected script.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    if (!flightControllerPopupOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!flightControllerRef.current?.contains(event.target as Node)) {
        setFlightControllerPopupOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFlightControllerPopupOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [flightControllerPopupOpen]);

  useEffect(() => {
    if (!mcapPopupOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!mcapRef.current?.contains(event.target as Node)) setMcapPopupOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMcapPopupOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mcapPopupOpen]);

  const runBusy = parentLoading || loading ||
    (external && connected && remoteState === 'loading');
  const phaseText: Record<SimPhase, string> = {
    idle: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止',
    restarting: '正在重新运行', pausing: '正在暂停', paused: '已暂停', resuming: '正在继续', loading: '正在加载模型',
  };
  // Prefer the user's current selection. The bridge status can still report
  // the previously running aircraft while a new script/model is selected.
  const activeName = selectedTest || selectedModel || preparedTarget.script ||
    preparedTarget.model || currentScript || currentModel || '';
  const displayName = activeName.split('/').pop()?.replace(/\.xml$/i, '') || '';
  const scriptStart = Number.parseFloat(scriptEditor.start);
  const scriptEnd = Number.parseFloat(scriptEditor.end);
  const totalSimulationTime = Number.isFinite(scriptStart) && Number.isFinite(scriptEnd) && scriptEnd >= scriptStart
    ? scriptEnd - scriptStart
    : null;
  const elapsedSimulationTime = typeof telemetry?.t === 'number' && Number.isFinite(telemetry.t)
    ? Math.max(0, telemetry.t - (Number.isFinite(scriptStart) ? scriptStart : 0))
    : null;

  const handleRunSelected = useCallback(async () => {
    const script = selectedTest || preparedTarget.script || undefined;
    const model = !script ? (selectedModel || preparedTarget.model || undefined) : undefined;
    const modelToSync = selectedModel || preparedTarget.model || undefined;
    if (!script && !model) return;
    launchInProgressRef.current = true;
    setLoading(true);
    setPhase('starting');
    appendLog(`启动请求: ${selectedModel || selectedTest || '当前选择'}`);
    setError('');
    try {
      if (script && modelToSync && scriptEditor.aircraft.trim() && scriptEditor.aircraft.trim() !== modelToSync) {
        throw new Error(`脚本关联模型是 ${scriptEditor.aircraft.trim()}，当前选择的是 ${modelToSync}。请重新选择对应脚本。`);
      }
      if (!script && modelToSync === 'F450_PX4') {
        throw new Error('F450_PX4 请从“脚本选择”启动 F450_PX4_lan.xml，以应用地面初始状态。');
      }
      if (modelToSync && onSyncRemoteModel) {
        setPhase('loading');
        try {
          const synced = await onSyncRemoteModel(modelToSync);
          if (synced) appendLog(`检测到本地修改，已同步模型到 NuttX: ${modelToSync}`);
          else appendLog(`未上传本地修改，直接运行 NuttX 现有模型: ${modelToSync}`);
        } catch (syncErr: any) {
          if (!confirmRunExistingModel(modelToSync, syncErr, '启动')) {
            appendLog(`模型同步失败，未启动 ${modelToSync}: ${syncErr?.message || syncErr}`);
            throw syncErr;
          }
          appendLog(`模型未同步，按用户选择启动仿真机现有模型: ${modelToSync}`);
        }
      }
      localLifecycleControlUntilRef.current = Date.now() + 35000;
      const res = await simStart({ script, model: script ? modelToSync : model });
      setPreparedTarget({ script: script || '', model: modelToSync || '' });
      saveSimulationTarget(script || '', modelToSync || '');
      setRunning(true);
      setPaused(false);
      setCurrentScript(res.script || null);
      setCurrentModel(res.model || null);
      setPhase('running');
    } catch (err: any) {
      const message = err?.message || String(err || '启动失败');
      localLifecycleControlUntilRef.current = 0;
      setError(message);
      appendLog(`启动失败: ${message}`);
      setPhase('idle');
      setOpen(true);
      setSubmenu(null);
      if (/xml|:\d+:\d+:/i.test(message)) showXmlDiagnostic(message, '仿真机加载诊断');
    }
    launchInProgressRef.current = false;
    setLoading(false);
  }, [selectedTest, selectedModel, preparedTarget, scriptEditor.aircraft, onSyncRemoteModel]);

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
      const editorValue = parseScriptEditorValue(file, script.xml);
      const aircraft = editorValue.aircraft;
      if (models.length > 0 && !models.some(model => model.path === aircraft)) {
        throw new Error(`脚本关联模型 ${aircraft} 不在 NuttX 模型库中`);
      }
      setScriptEditor(editorValue);
      localStorage.setItem(scriptEditorCacheKey(path), JSON.stringify(editorValue));
      scriptSourceRef.current = {
        path: path.startsWith('scripts/') ? path : `scripts/${file}`,
        xml: script.xml,
      };
      setScriptEditorExpanded(true);
      setSelectedModel(aircraft);
      setPreparedTarget({ script: path, model: aircraft });
      saveSimulationTarget(path, aircraft);
      if (!onOpenRemoteModel) throw new Error('编辑器模型加载接口不可用');
      appendLog(`脚本关联模型: ${aircraft}，正在加载到编辑器`);
      await onOpenRemoteModel(aircraft);
      appendLog(`脚本 ${file} 及模型 ${aircraft} 已选择，点击“运行”启动脚本`);
      setPhase('idle');
    } catch (err: any) {
      setSelectedModel('');
      const message = err?.message || String(err);
      setError(message);
      showXmlDiagnostic(message, '脚本 XML 加载失败');
      appendLog(`脚本加载失败: ${message}`);
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
    saveSimulationTarget(remotePath, value.aircraft.trim());
    appendLog(`脚本已写入并回读确认: /mnt/sdcard/jsbsim/${remotePath}`);
    await loadLists();
  }, [appendLog, loadLists]);

  useEffect(() => {
    if (statusOnly) return;
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
  }, [handleRunScript, statusOnly]);

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
      saveSimulationTarget('', path);
      if (!onOpenRemoteModel) throw new Error('编辑器模型加载接口不可用');
      await onOpenRemoteModel(path);
      appendLog(`模型已加载到编辑器: ${path}`);
      setPhase('idle');
    } catch (err: any) {
      const message = err?.message || String(err);
      setError(message);
      showXmlDiagnostic(message, '模型 XML 加载失败');
      appendLog(`模型加载失败: ${message}`);
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
    launchInProgressRef.current = true;
    setLoading(true);
    setPhase('restarting');
    appendLog(`重新运行当前模型: ${displayName || '当前模型'}`);
    setError('');
    let syncFailed = false;
    try {
      const modelToSync = currentModel || preparedTarget.model || selectedModel || scriptEditor.aircraft.trim();
      if (modelToSync && onSyncRemoteModel) {
        try {
          const synced = await onSyncRemoteModel(modelToSync);
          if (synced) appendLog(`检测到本地修改，已同步模型到 NuttX: ${modelToSync}`);
          else appendLog(`未上传本地修改，重新运行 NuttX 现有模型: ${modelToSync}`);
        } catch (syncErr: any) {
          if (!confirmRunExistingModel(modelToSync, syncErr, '重新运行')) {
            syncFailed = true;
            throw syncErr;
          }
          appendLog(`模型未同步，按用户选择重新运行仿真机现有模型: ${modelToSync}`);
        }
      }
      await simRestart();
      localLifecycleControlUntilRef.current = Date.now() + 3000;
      setRunning(true);
      setPaused(false);
      setPhase('running');
    } catch (err: any) {
      const message = err?.message || String(err);
      if (syncFailed) {
        setPhase(paused ? 'paused' : 'running');
        setError(message);
        appendLog(`模型同步失败，未重新运行: ${message}`);
        setOpen(true);
        setSubmenu(null);
      } else {
        setError(message);
        setPhase('idle');
        appendLog(`重新加载失败: ${message}`);
        if (/xml|:\d+:\d+:/i.test(message)) showXmlDiagnostic(message, '仿真机加载诊断');
      }
    }
    launchInProgressRef.current = false;
    setLoading(false);
  }, [appendLog, currentModel, displayName, onSyncRemoteModel, paused, preparedTarget.model, scriptEditor.aircraft, selectedModel]);

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
  const showBoardStatus = statusOnly || (showRuntimeStatus && external);
  const fdmLoading = external && (launchInProgressRef.current || remoteState === 'loading');
  const chartNow = Date.now();
  const fdmVisibleHistory = fdmHistory.filter(sample => chartNow - sample.at <= fdmWindow * 1000);
  const cpuVisibleHistory = cpuHistory.filter(sample => chartNow - sample.at <= fdmWindow * 1000);
  const networkVisibleHistory = networkHistory.filter(sample => chartNow - sample.at <= fdmWindow * 1000);
  const networkPeak = networkVisibleHistory.reduce((peak, sample) => Math.max(peak, sample.rx, sample.tx), 0);
  const networkUnitBytes = networkPeak >= 1048576 ? 1048576 : 1024;
  const networkUnitLabel = networkUnitBytes === 1048576 ? 'MiB/s' : 'KiB/s';
  const networkChartMax = Math.max(0.4, Math.ceil(networkPeak / networkUnitBytes * 1.1 * 10) / 10) * networkUnitBytes;
  const cpuChartMax = Math.min(100, Math.max(5,
    Math.ceil(Math.max(0, ...cpuVisibleHistory.flatMap(sample => sample.values)) * 1.1 / 5) * 5));
  const fdmChartMax = Math.max(0.1, ...fdmVisibleHistory.map(sample => sample.peak)) * 1.1;
  const fdmValues = fdmVisibleHistory.map(sample => sample.value);
  const fdmSampleCount = fdmVisibleHistory.reduce((sum, sample) => sum + sample.samples, 0);
  const fdmAverage = fdmSampleCount ? fdmVisibleHistory.reduce((sum, sample) => sum + sample.value * sample.samples, 0) / fdmSampleCount : 0;
  const fdmMaximum = fdmVisibleHistory.length ? Math.max(...fdmVisibleHistory.map(sample => sample.peak)) : 0;
  const fdmMinimum = fdmValues.length ? Math.min(...fdmValues) : 0;
  const fdmCurveLabel = fdmIsWindow ? 'FDM 窗口均值' : 'FDM 周期采样';
  const fdmCurveDescription = fdmIsWindow
    ? '板端统计窗口内的周期平均耗时，包含输入、输出等待'
    : '板端每次上报最近一个周期的耗时，包含输入、输出等待；下方统计覆盖收到的样本';
  const chartX = (at: number) => 35 + (1 - Math.min(fdmWindow * 1000, Math.max(0, chartNow - at)) / (fdmWindow * 1000)) * 290;
  const cpuChartPoints = cpuCores.map((_, core) => cpuVisibleHistory.map(sample => {
    const x = chartX(sample.at);
    const y = 122 - Math.max(0, Math.min(cpuChartMax, sample.values[core] ?? 0)) * 96 / cpuChartMax;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' '));
  const fdmChartPoints = fdmVisibleHistory.map(sample => {
    const x = chartX(sample.at);
    const y = 122 - Math.min(96, sample.value * 96 / fdmChartMax);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fdmPeakPoints = fdmVisibleHistory.map(sample => {
    const x = chartX(sample.at);
    const y = 122 - Math.min(96, sample.peak * 96 / fdmChartMax);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const networkChartPath = (name: NetworkPort, direction: 'rx' | 'tx') => {
    let path = '';
    let previousAt = 0;
    for (const sample of networkVisibleHistory) {
      if (sample.name !== name) continue;
      const x = chartX(sample.at);
      const y = 104 - Math.min(80, sample[direction] * 80 / networkChartMax);
      path += `${previousAt && sample.at - previousAt <= 3000 ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
      previousAt = sample.at;
    }
    return path;
  };

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
    if (showBoardStatus) return;
    setPerformancePopupOpen(false);
    setFlightControllerPopupOpen(false);
    setMcapPopupOpen(false);
  }, [showBoardStatus]);

  const flightConnection = !flightController || flightController.status_stale
    ? '待更新' : flightController.usb_connected ? '已连接' : '未连接';
  const flightConnectionClass = !flightController || flightController.status_stale
    ? 'stale' : flightController.usb_connected ? 'online' : 'offline';
  const cpuPeak = healthFresh && cpuCores.length > 0 ? Math.max(...cpuCores) : null;
  const cpuSummary = cpuPeak == null ? '--' : `${cpuPeak.toFixed(1)}%`;
  const memorySummary = healthFresh && memory ? `${memory.percent.toFixed(1)}%` : '--';
  const fdmSummary = fdmLoading ? '…' : fdmRunMs == null ? '--' : `${fdmRunMs.toFixed(3)}ms`;
  const metricsDescription = `CPU 最高核心 ${cpuSummary}${healthFresh && cpuCores.length > 0 ? `（${cpuCores.map((value, index) => `${index}: ${value.toFixed(1)}%`).join('，')}）` : ''}；内存 ${memorySummary}${memory ? `（已用 ${(memory.used / 1048576).toFixed(1)} / ${(memory.total / 1048576).toFixed(1)} MiB）` : ''}；FDM ${fdmLoading ? '加载中' : fdmRunMs == null ? '等待更新' : `${fdmRunMs.toFixed(3)} ms`}。点击查看性能曲线`;
  const mcapState = !healthFresh || !mcapStatus ? '待更新'
    : mcapStatus.stopping ? '保存中' : mcapStatus.bufferFull ? '缓存已满'
      : mcapStatus.recording ? '录制中' : '未录制';
  const mcapWriteState = !healthFresh || !mcapStatus ? '写入待更新'
    : mcapStatus.writeFailed ? '写入失败'
      : mcapStatus.writing ? '写入 SD'
        : mcapStatus.recording ? '仅缓存' : mcapStatus.writtenBytes > 0 ? '已写入' : '未写入';

  const fleetPrimary = fleetControls && (fleetControls.runningCount > 0 ? 'stop' :
    fleetControls.pausedCount > 0 ? 'resume' : 'start');
  const fleetActive = !!fleetControls && (fleetControls.runningCount > 0 || fleetControls.pausedCount > 0);
  const fleetSection = fleetControls && <div className="sim-fleet-section" aria-label="编组控制">
    <div className="sim-menu-section-title">编组控制</div>
    {(['start', 'pause', 'resume', 'stop'] as const).map((action, index) =>
      <button key={action} type="button" className="sim-menu-item"
        disabled={!fleetControls.connected || fleetControls.busy || (action === 'start' && !fleetControls.configuredCount)}
        onClick={() => fleetControls.onCommand(action)}>
        {fleetControls.busy ? '⏳ ' : ''}{['全组启动', '全组暂停', '全组继续', '全组停止'][index]}
      </button>)}
    {fleetControls.error && <div className="sim-error" role="alert">{fleetControls.error}</div>}
  </div>;

  return (
    <div className="sim-menu-wrap" ref={wrapRef}>
      {!statusOnly && <div className={`sim-split-trigger ${running ? 'active' : ''}`}>
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
      </div>}
      {statusOnly && fleetControls && <div className={`sim-split-trigger ${fleetActive ? 'active' : ''}`}>
        <button type="button" className="sim-primary-action"
          disabled={!fleetControls.connected || fleetControls.busy || (fleetPrimary === 'start' && !fleetControls.configuredCount)}
          title="控制全部仿真实例" onClick={() => { if (fleetPrimary) fleetControls.onCommand(fleetPrimary); }}>
          {fleetControls.busy ? '⏳ 发送中' : fleetPrimary === 'stop' ? '⏹ 停止' :
            fleetPrimary === 'resume' ? '▶ 继续' : '▶ 开始'}
        </button>
        <button type="button" className="sim-dropdown-toggle" title="编组操作" aria-label="打开编组操作菜单"
          aria-expanded={open} onClick={() => setOpen(value => !value)}>▾</button>
      </div>}
      {statusOnly && open && fleetControls && <div className="sim-dropdown">{fleetSection}</div>}
      {!statusOnly && (activeName || showRuntimeStatus) && (
        <span className={`sim-target-status ${connectionClass}`} title={`${activeName || '仿真机'} · ${connectionLabel}`}>
          {showRuntimeStatus && <span className="sim-connection-dot" role="status" aria-label={connectionLabel} />}
          {activeName && <span className="sim-selected-target" title={activeName}>
            {(selectedTest || preparedTarget.script || currentScript) ? '📋' : '🛩️'} {displayName}
          </span>}
          {showRuntimeStatus && (!activeName || !connected) && <span className="sim-connection-label">{connectionLabel}</span>}
        </span>
      )}
      {showBoardStatus && (
        <button type="button" className="sim-runtime-metrics"
          aria-label={metricsDescription} aria-expanded={performancePopupOpen} aria-controls="sim-performance-popup"
          title={metricsDescription}
          onClick={() => {
            setFlightControllerPopupOpen(false);
            setMcapPopupOpen(false);
            setPerformancePopupOpen(value => !value);
          }}>
          <span className="sim-metric-item sim-metric-cpu" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false"><rect x="4.5" y="4.5" width="11" height="11" rx="2" /><rect x="8" y="8" width="4" height="4" rx=".5" /><path d="M7 1.5v3m6-3v3M7 15.5v3m6-3v3m-11.5-11h3m-3 8h3m11-8h3m-3 8h3" /></svg>
            <span>{cpuSummary}</span>
          </span>
          <span className="sim-metric-item sim-metric-ram" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false"><rect x="2" y="4.5" width="16" height="11" rx="2" /><rect className="sim-metric-ram-fill" x="4" y="6.5" width={healthFresh && memory ? 12 * Math.max(0, Math.min(100, memory.percent)) / 100 : 0} height="7" rx=".7" /><path d="M5 1.5v3m5-3v3m5-3v3M5 15.5v3m5-3v3m5-3v3" /></svg>
            <span>{memorySummary}</span>
          </span>
          <span className="sim-metric-item sim-metric-fdm" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false"><circle cx="10" cy="11" r="6.5" /><path d="M10 4.5v-3M7 1.5h6M10 11l2.8-2.8" /></svg>
            <span>{fdmSummary}</span>
          </span>
          <span className="sim-metric-caret" aria-hidden="true">⌄</span>
        </button>
      )}
      {showBoardStatus && (
        <div className="sim-flight-controller-anchor" ref={flightControllerRef}>
          <button type="button" className={`sim-flight-controller ${flightConnectionClass}`}
            aria-label={`飞控 USB ${flightConnection}，点击查看详情`}
            aria-expanded={flightControllerPopupOpen} aria-controls="sim-flight-controller-popover"
            onClick={() => {
              setPerformancePopupOpen(false);
              setFlightControllerPopupOpen(value => !value);
            }}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
              <path d="M7 1.5v3m6-3v3M7 15.5v3m6-3v3m-11.5-11h3m-3 8h3m11-8h3m-3 8h3" />
              <circle cx="10" cy="10" r="2" />
            </svg>
            <span>USB {flightConnection}</span>
          </button>
          {flightControllerPopupOpen && (
            <div id="sim-flight-controller-popover" className="sim-flight-controller-popover" role="region" aria-label="飞控详细状态">
              <div className="sim-flight-controller-popover-head">
                <strong>飞控信息</strong>
                <button type="button" aria-label="关闭飞控信息" onClick={() => setFlightControllerPopupOpen(false)}>×</button>
              </div>
              {!flightController && <p>等待仿真机上报飞控状态</p>}
              {flightController && <>
                {flightController.status_stale && <p>状态上报已中断 {((flightController.status_age_ms ?? 0) / 1000).toFixed(1)} 秒，等待更新</p>}
                <dl>
                  <dt>飞控型号</dt><dd>{flightControllerModel(flightController)}</dd>
                  <dt>Board ID</dt><dd>{flightController.heartbeat_alive && !flightController.status_stale && flightController.board_id_available && flightController.board_id != null ? `0x${flightController.board_id.toString(16).toUpperCase().padStart(4, '0')} (${flightController.board_id})` : '--'}</dd>
                  <dt>USB 产品名</dt><dd>{(!flightController.status_stale && flightController.usb_connected && flightController.usb_product?.trim()) || '--'}</dd>
                  <dt>USB VID:PID</dt><dd>{flightControllerUsbId(flightController)}</dd>
                  <dt>设备路径</dt><dd>{(!flightController.status_stale && flightController.usb_connected && flightController.device_path?.trim()) || '--'}</dd>
                  <dt>飞控固件</dt><dd>{flightController.heartbeat_alive && !flightController.status_stale ? flightControllerFirmware(flightController.autopilot) : '--'}</dd>
                  <dt>USB 连接</dt><dd>{flightController.status_stale ? '待更新' : flightController.usb_connected ? '已连接' : '未连接'}</dd>
                  <dt>心跳</dt><dd>{flightController.status_stale ? '待更新' : flightController.heartbeat_alive ? '在线' : '离线'}</dd>
                  <dt>已接收心跳</dt><dd>{flightController.heartbeat_count} 包</dd>
                  <dt>最近心跳</dt><dd>{flightController.heartbeat_alive && !flightController.status_stale ? `${flightController.heartbeat_age_ms} ms 前` : '--'}</dd>
                  <dt>HIL_ACTUATOR_CONTROLS</dt><dd>{!flightController.status_stale && flightController.actuator_rate_available && Number.isFinite(flightController.actuator_rate_hz) ? `${flightController.actuator_rate_hz!.toFixed(1)} Hz` : '--'}</dd>
                  <dt>解锁状态</dt><dd>{flightController.heartbeat_alive && !flightController.status_stale ? (flightController.armed ? '已解锁' : '未解锁') : '未知'}</dd>
                  <dt>模式</dt><dd>{flightMode(flightController)}</dd>
                </dl>
              </>}
            </div>
          )}
        </div>
      )}
      {showBoardStatus && (
        <div className="sim-mcap-anchor" ref={mcapRef}>
          <button type="button" className={`sim-mcap-status ${!healthFresh || !mcapStatus ? 'stale' : mcapStatus.writeFailed ? 'failed' : mcapStatus.recording ? 'recording' : ''}`}
            aria-label={`MCAP 日志${mcapState}，已录制${mcapStatus ? formatMcapBytes(mcapStatus.recordedBytes) : '待更新'}，录制速度${mcapRate == null ? '待更新' : formatNetworkRate(mcapRate)}，${mcapWriteState}，点击查看详情`}
            aria-expanded={mcapPopupOpen} aria-controls="sim-mcap-popover"
            title="MCAP 日志 · 点击查看录制详情"
            onClick={() => {
              setPerformancePopupOpen(false);
              setFlightControllerPopupOpen(false);
              setMcapPopupOpen(value => !value);
            }}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="6" /><circle cx="10" cy="10" r="3" /></svg>
            <span className="sim-mcap-size">{mcapStatus ? formatMcapBytes(mcapStatus.recordedBytes) : '--'}</span>
          </button>
          {mcapPopupOpen && (
            <div id="sim-mcap-popover" className="sim-flight-controller-popover sim-mcap-popover" role="region" aria-label="MCAP 日志状态">
              <div className="sim-flight-controller-popover-head">
                <strong>MCAP 日志</strong>
                <button type="button" aria-label="关闭 MCAP 日志状态" onClick={() => setMcapPopupOpen(false)}>×</button>
              </div>
              {!mcapStatus && <p>等待任务机上报 MCAP 状态</p>}
              {mcapStatus && <>
                {mcapStatus.bufferFull && <p>录制缓存已满，后续数据无法继续录入。</p>}
                <dl>
                  <dt>录制状态</dt><dd>{mcapState}</dd>
                  <dt>已录制数据</dt><dd>{formatMcapBytes(mcapStatus.recordedBytes)}</dd>
                  <dt>录制速度</dt><dd>{mcapRate == null ? (mcapStatus.recording ? '计算中' : '--') : formatNetworkRate(mcapRate)}</dd>
                  <dt>SD 写入</dt><dd>{mcapWriteState}</dd>
                  <dt>已写入 SD</dt><dd>{formatMcapBytes(mcapStatus.writtenBytes)}</dd>
                </dl>
                <p className="sim-mcap-note">已录制数据是内存中的 MCAP 记录量。最终文件经压缩，停止后完成校验，大小可能不同。</p>
              </>}
            </div>
          )}
        </div>
      )}
      {showBoardStatus && performancePopupOpen && (
        <div id="sim-performance-popup" className="sim-performance-popup" role="region" aria-label="性能曲线">
          <div className="sim-performance-head">
            <b>性能曲线</b>
            <span>{healthFresh ? '实时' : '等待更新'}</span>
            <div className="sim-performance-window" aria-label={`${performancePeriod} 秒周期时间范围`}>
              <span>周期 {performancePeriod}s</span>
              {([1, 2, 3, 4] as const).map(multiplier => <button key={multiplier} type="button" className={fdmMultiplier === multiplier ? 'active' : ''} aria-pressed={fdmMultiplier === multiplier} onClick={() => setFdmMultiplier(multiplier)}>×{multiplier}</button>)}
            </div>
            <button type="button" className="sim-performance-close" aria-label="收起性能曲线" onClick={() => setPerformancePopupOpen(false)}>×</button>
          </div>
          <div className="sim-performance-legend">
            {cpuCores.map((value, core) => <button key={core} type="button" className={`sim-performance-series core-${core}`}
              aria-label={`CPU${core} 曲线`} aria-pressed={!hiddenPerformanceSeries[`cpu-${core}`]}
              title={`${hiddenPerformanceSeries[`cpu-${core}`] ? '显示' : '隐藏'} CPU${core} 曲线`}
              onClick={() => togglePerformanceSeries(`cpu-${core}`)}>
              <i aria-hidden="true" />CPU{core} <b>{healthFresh ? `${value.toFixed(1)}%` : '--'}</b>
            </button>)}
            {!fdmLoading && fdmRunMs != null && <>
              <button type="button" className="sim-performance-series fdm-mean" aria-label={`${fdmCurveLabel}曲线`}
                aria-pressed={!hiddenPerformanceSeries['fdm-mean']} title={fdmCurveDescription}
                onClick={() => togglePerformanceSeries('fdm-mean')}><i aria-hidden="true" />{fdmCurveLabel}</button>
              {fdmIsWindow && <button type="button" className="sim-performance-series fdm-peak" aria-label="FDM 峰值曲线"
                aria-pressed={!hiddenPerformanceSeries['fdm-peak']} title={`${hiddenPerformanceSeries['fdm-peak'] ? '显示' : '隐藏'} FDM 峰值曲线`}
                onClick={() => togglePerformanceSeries('fdm-peak')}><i aria-hidden="true" />峰值</button>}
            </>}
          </div>
          <div className="sim-performance-network-row" aria-label="板端网口实时速率">
            {(['eth0', 'eth1'] as const).map(name => {
              const rate = healthFresh && networkReported && networkAvailable.includes(name) ? networkRates[name] : undefined;
              const status = !healthFresh ? '等待连接'
                : !networkReported ? '遥测未上报网口统计'
                : !networkAvailable.includes(name) ? '暂未取得统计'
                : '采样中';
              return <span key={name} className={`sim-performance-network network-${name}`} aria-label={`${name} 网速`}>
                <b>{name}</b>{rate
                  ? ([['rx', '↓'], ['tx', '↑']] as const).map(([direction, arrow]) => {
                    const key = `${name}-${direction}`;
                    return <button key={direction} type="button" className={`sim-network-series network-${key}`}
                      aria-label={`${name} ${direction === 'rx' ? '接收' : '发送'}速率曲线`}
                      aria-pressed={!hiddenPerformanceSeries[key]}
                      title={`${hiddenPerformanceSeries[key] ? '显示' : '隐藏'} ${name} ${direction === 'rx' ? '接收' : '发送'}速率曲线`}
                      onClick={() => togglePerformanceSeries(key)}>
                      <i aria-hidden="true" />{arrow} {formatNetworkRate(rate[direction])}
                    </button>;
                  })
                  : <b className="sim-network-wait">{status}</b>}
              </span>;
            })}
          </div>
          <svg className="sim-performance-chart" viewBox="0 0 360 152" role="img" aria-label="CPU 利用率与 FDM 周期耗时共用时间轴，左轴为 CPU 百分比，右轴为 FDM 毫秒">
            <text x="35" y="14">CPU %</text><text x="325" y="14" textAnchor="end">FDM ms</text>
            {[0, 1, 2, 3, 4].map(step => {
              const y = 122 - step * 24;
              return <g key={step}>
                <line x1="35" x2="325" y1={y} y2={y} className="sim-performance-grid" />
                <text x="30" y={y + 3} textAnchor="end">{(cpuChartMax * step / 4).toFixed(1)}</text>
                <text x="330" y={y + 3}>{(fdmChartMax * step / 4).toFixed(2)}</text>
              </g>;
            })}
            {cpuChartPoints.map((points, core) => !hiddenPerformanceSeries[`cpu-${core}`] && <polyline key={core} points={points} className={`sim-performance-line core-${core}`} />)}
            {!fdmLoading && <>
              {!hiddenPerformanceSeries['fdm-mean'] && <polyline points={fdmChartPoints} className="sim-performance-line fdm-mean" />}
              {fdmIsWindow && !hiddenPerformanceSeries['fdm-peak'] && <polyline points={fdmPeakPoints} className="sim-performance-line fdm-peak" />}
            </>}
            <text x="35" y="145">-{fdmWindow}s</text><text x="325" y="145" textAnchor="end">现在</text>
          </svg>
          <svg className="sim-performance-chart sim-network-chart" viewBox="0 0 360 128" role="img" aria-label={`eth0 与 eth1 接收和发送速率曲线，纵轴单位 ${networkUnitLabel}`}>
            <text x="35" y="14">网速 {networkUnitLabel}</text>
            {[0, 1, 2, 3, 4].map(step => {
              const y = 104 - step * 20;
              return <g key={step}>
                <line x1="35" x2="325" y1={y} y2={y} className="sim-performance-grid" />
                <text x="30" y={y + 3} textAnchor="end">{(networkChartMax / networkUnitBytes * step / 4).toFixed(1)}</text>
              </g>;
            })}
            {(['eth0', 'eth1'] as const).flatMap(name => (['rx', 'tx'] as const).map(direction => {
              const key = `${name}-${direction}`;
              return !hiddenPerformanceSeries[key] && <path key={key} d={networkChartPath(name, direction)} className={`sim-network-line network-${key}`} />;
            }))}
            {!networkVisibleHistory.length && <text x="180" y="68" textAnchor="middle">等待网速采样</text>}
            <text x="35" y="123">-{fdmWindow}s</text><text x="325" y="123" textAnchor="end">现在</text>
          </svg>
          {!fdmLoading && fdmVisibleHistory.length > 0 && <div className="sim-performance-stats">
            <span>{fdmIsWindow ? '周期均值' : '采样均值'} <b>{fdmAverage.toFixed(3)} ms</b></span>
            <span>{fdmIsWindow ? '最大' : '采样最大'} <b>{fdmMaximum.toFixed(3)} ms</b></span>
            <span>{fdmIsWindow ? '最低均值' : '采样最小'} <b>{fdmMinimum.toFixed(3)} ms</b></span>
          </div>}
          {!fdmLoading && fdmDetails && fdmDetails.coreMs != null && <div className="sim-performance-stats"
            title="最近统计窗口的每周期平均耗时；计算和 I/O 含调度等待，日志采样为读取变量耗时。超时按含遥测、日志入队的周期总工作时间超过目标周期统计。">
            <span>计算 <b>{fdmDetails.coreMs.toFixed(3)} ms</b></span>
            <span>I/O <b>{fdmDetails.ioMs?.toFixed(3) ?? '--'} ms</b></span>
            <span>日志采样 <b>{fdmDetails.captureMs?.toFixed(3) ?? '--'} ms</b></span>
            <span>目标周期 <b>{fdmDetails.periodMs?.toFixed(2) ?? '--'} ms</b></span>
            <span>实时倍率 <b>{fdmDetails.realtimeFactor?.toFixed(2) ?? '--'}×</b></span>
            <span>超时周期 <b>{fdmDetails.overruns ?? '--'}/{fdmDetails.samples}</b></span>
          </div>}
        </div>
      )}

      {!statusOnly && open && (
        <div className="sim-dropdown">
          <div className="sim-dropdown-header">
            <span className={`sim-status-dot ${phase === 'paused' ? 'paused' : phase === 'idle' ? 'stopped' : 'running'}`} />
            <div className="sim-status-info">
              <span className="sim-status-text">{statusText}</span>
              {displayName && <span className="sim-status-target" title={activeName}>{displayName}</span>}
              {phase !== 'idle' && (
                <span className="sim-status-target sim-runtime-time">
                  ⏱ 已运行 {elapsedSimulationTime == null ? '--' : `${elapsedSimulationTime.toFixed(1)} s`}
                  {' / 总计 '}
                  {totalSimulationTime == null ? '未设置' : `${totalSimulationTime.toFixed(1)} s`}
                </span>
              )}
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
      {!statusOnly && scriptEditor.name && !scriptEditorExpanded && createPortal(
        <button className="script-flow-mini" onClick={() => setScriptEditorExpanded(true)} title="点击查看完整脚本逻辑">
          <span className="script-flow-mini-head">📋 {scriptEditor.name}</span>
          <span className="script-flow-mini-meta">
            ✈️ {scriptEditor.aircraft}　⏱ 步长 {scriptEditor.dt || '—'}s
            <span className="script-flow-mini-duration">
              总时长 {totalSimulationTime == null ? '未设置' : `${totalSimulationTime.toFixed(1)}s`}
            </span>
          </span>
          <span className="script-flow-mini-track"><i>▶</i>{scriptEditor.events.slice(0, 4).map((event, index) => <i key={`${event.name}-${index}`}>{index + 1}</i>)}<i>■</i></span>
          <span className="script-flow-mini-hint">点击展开完整逻辑</span>
        </button>, document.body
      )}
      {!statusOnly && scriptEditor.name && scriptEditorExpanded && <ScriptEditorDialog value={scriptEditor} variables={globalVariables} onChange={setScriptEditor} onSave={handleSaveScript} onClose={() => setScriptEditorExpanded(false)} />}
    </div>
  );
}
