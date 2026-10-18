import { useEffect, useMemo, useState } from 'react';
import { firmwareApply, firmwareStage, firmwareStageFile, selectFirmwareFile, isTauri, ftpDownloadSimConfig, ftpUploadSimConfig, ftpGetSimulatorVersion, listenFirmwareProgress, getPlotJugglerRate, setPlotJugglerRate, readSimulatorNetwork, setSimulatorNetwork, SimulatorVersion, type FirmwareSelection, type SimulatorNetworkInterface } from '../utils/tauriApi';
import { useLanguage } from '../i18n';
import { useSimSocket } from '../sim/useSimSocket';

type Tab = '系统设置' | '运行与时间' | '数值积分' | '初始状态' | '环境模型' | 'MCAP日志' | '性能与安全' | '固件升级';
type VariableCategory = 'attitude' | 'position' | 'inertia' | 'controls' | 'propulsion' | 'environment' | 'simulation' | 'other';
const tabs: Tab[] = ['系统设置', '运行与时间', '数值积分', '初始状态', '环境模型', 'MCAP日志', '性能与安全', '固件升级'];
const categoryOrder: VariableCategory[] = ['attitude', 'position', 'inertia', 'controls', 'propulsion', 'environment', 'simulation', 'other'];
const variableCategory = (path: string): VariableCategory => {
  const value = path.replace(/^\/+/, '').toLowerCase();
  if (/^(attitude|aero|aerodynamics|orientation)\//.test(value)) return 'attitude';
  if (/^(position|velocities|velocity|navigation|gps)\//.test(value)) return 'position';
  if (/^(accelerations|inertia|rates|imu)\//.test(value)) return 'inertia';
  if (/^(fcs|controls|gear|flight-control)\//.test(value)) return 'controls';
  if (/^(propulsion|engine|engines|thruster|thrusters)\//.test(value)) return 'propulsion';
  if (/^(atmosphere|environment|weather|wind)\//.test(value)) return 'environment';
  if (/^(simulation|metrics|jsbsim)\//.test(value)) return 'simulation';
  return 'other';
};
const defaults = {
  version: 1,
  runtime: { dt: 0.002, iterationsPerCycle: 1, catchupIterations: 4, realtimeFactor: 1, endBehavior: 'stop' },
  integrators: { rotationalRate: 1, translationalRate: 3, rotationalPosition: 1, translationalPosition: 4 },
  initial: { latitudeDeg: 0, longitudeDeg: 0, altitudeM: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0, airspeedMps: 0, trim: false },
  environment: { pressureSlPsf: 2116.22, temperatureBiasR: 0, relativeHumidityPct: 0, windNorthFps: 0, windEastFps: 0, windDownFps: 0, turbulenceType: 0, turbulenceWindspeed20ftFps: 0, turbulenceSeverity: 0 },
  mcap: { enabled: true, rateHz: 50, backgroundRateHz: 50, directory: '/mnt/sdcard/LOG', maxFileMb: 512, maxDurationMin: 60, queueDepth: 1024, bufferMb: 500, minFreeMb: 128, selectedVariables: [] as string[], criticalVariables: [] as string[] },
  safety: { cpuCore: 0, taskPriority: 120, stackKb: 256, fdmTimeoutMs: 4, cpuWarningPercent: 90, ramWarningPercent: 85, nanCheck: true, faultAction: 'stop' },
  diagnostics: { usbDebugPrint: false },
};

const merge = (source: any) => ({
  ...defaults, ...source,
  runtime: { ...defaults.runtime, ...source?.runtime },
  integrators: { ...defaults.integrators, ...source?.integrators },
  initial: { ...defaults.initial, ...source?.initial },
  environment: { ...defaults.environment, ...source?.environment },
  mcap: { ...defaults.mcap, ...source?.mcap },
  safety: { ...defaults.safety, ...source?.safety },
  diagnostics: { ...defaults.diagnostics, ...source?.diagnostics },
});

function NumberField({ label, value, onChange, unit, step = 1, min }: any) {
  return <label className="sim-config-field"><span>{label}</span><div><input type="number" value={value} step={step} min={min} onChange={e => onChange(Number(e.target.value))} />{unit && <em>{unit}</em>}</div></label>;
}
function SelectField({ label, value, onChange, children }: any) {
  return <label className="sim-config-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{children}</select></label>;
}
const integratorOptions = (isZh: boolean) => <>{[['0',isZh?'冻结':'Freeze'],['1',isZh?'矩形欧拉':'Rectangular Euler'],['2',isZh?'梯形':'Trapezoidal'],['3','Adams–Bashforth 2'],['4','Adams–Bashforth 3'],['5','Adams–Bashforth 4']].map(([v,n]) => <option key={v} value={v}>{n}</option>)}</>;

const formatBuildTime = (value: string | undefined, isZh: boolean) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = isZh ? 'zh-CN' : 'en-US';
  const localTime = date.toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const zone = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
    .formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
  return zone ? `${localTime} ${zone}` : localTime;
};

export default function SimulationConfigDialog({ model, onClose }: { model: string; onClose: () => void }) {
  const { isZh } = useLanguage();
  const { telemetry, connected } = useSimSocket();
  const tr = (zh: string, en: string) => isZh ? zh : en;
  const safeModel = (model || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const variableCacheKey = `jsbsim-mcap-variables:${safeModel}`;
  const path = `config/models/${safeModel}.json`;
  const [tab, setTab] = useState<Tab>('系统设置');
  const [networkInterfaces, setNetworkInterfaces] = useState<SimulatorNetworkInterface[]>([]);
  const [networkInput, setNetworkInput] = useState<SimulatorNetworkInterface>({ name: 'eth0', address: '', netmask: '', gateway: '' });
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkStatus, setNetworkStatus] = useState('');
  const [config, setConfig] = useState<any>(defaults);
  const [baseline, setBaseline] = useState('');
  const [status, setStatus] = useState(tr('正在读取仿真机配置…', 'Reading simulator configuration…'));
  const [saving, setSaving] = useState(false);
  const [plotRateInput, setPlotRateInput] = useState(() => String(getPlotJugglerRate()));
  const [plotRateApplied, setPlotRateApplied] = useState(() => getPlotJugglerRate());
  const [plotRateSaving, setPlotRateSaving] = useState(false);
  const [plotRateStatus, setPlotRateStatus] = useState('');
  const [simulatorVersion, setSimulatorVersion] = useState<SimulatorVersion | null>(null);
  const [versionStatus, setVersionStatus] = useState(tr('正在读取仿真机版本…', 'Reading simulator version…'));
  const [showVersionManager, setShowVersionManager] = useState(false);
  const [firmwareFile, setFirmwareFile] = useState<File | FirmwareSelection | null>(null);
  const [firmwareUpdating, setFirmwareUpdating] = useState(false);
  const [firmwareStatus, setFirmwareStatus] = useState(tr('请选择 nuttx.bin 固件', 'Select a nuttx.bin firmware image'));
  const [firmwareUploadProgress, setFirmwareUploadProgress] = useState(0);
  const [firmwareInstallProgress, setFirmwareInstallProgress] = useState(0);
  const [firmwareInstallStage, setFirmwareInstallStage] = useState<'idle' | 'write' | 'verify' | 'success' | 'error'>('idle');
  const [versionSnapshots, setVersionSnapshots] = useState<Array<SimulatorVersion & { savedAt: string }>>(() => {
    try { const saved = JSON.parse(localStorage.getItem('jsbsim-simulator-version-snapshots') || '[]'); return Array.isArray(saved) ? saved : []; } catch { return []; }
  });
  const [variableFilter, setVariableFilter] = useState('');
  const [manualVariable, setManualVariable] = useState('');
  const [manualVariableError, setManualVariableError] = useState('');
  const [availableVariables, setAvailableVariables] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(variableCacheKey) || '[]'); return Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []; } catch { return []; }
  });
  const serialized = useMemo(() => JSON.stringify(config, null, 2), [config]);
  const set = (group: string, key: string, value: any) => setConfig((current: any) => ({ ...current, [group]: { ...current[group], [key]: value } }));
  const selectedVariables: string[] = Array.isArray(config.mcap.selectedVariables) ? config.mcap.selectedVariables : [];
  const criticalVariables: string[] = Array.isArray(config.mcap.criticalVariables) ? config.mcap.criticalVariables : [];
  const toggleVariable = (path: string) => {
    if (selectedVariables.includes(path)) setConfig((current: any) => ({ ...current, mcap: { ...current.mcap, selectedVariables: selectedVariables.filter(item => item !== path), criticalVariables: criticalVariables.filter(item => item !== path) } }));
    else set('mcap', 'selectedVariables', [...selectedVariables, path]);
  };
  const toggleCriticalVariable = (path: string) => set('mcap', 'criticalVariables',
    criticalVariables.includes(path) ? criticalVariables.filter(item => item !== path) : [...criticalVariables, path]);
  const allVariables = useMemo(() => [...new Set([...availableVariables, ...selectedVariables])].sort((a, b) => a.localeCompare(b)), [availableVariables, selectedVariables]);
  const filteredVariables = useMemo(() => allVariables.filter(path => path.toLowerCase().includes(variableFilter.trim().toLowerCase())), [allVariables, variableFilter]);
  const variableGroups = useMemo(() => categoryOrder.map(category => ({ category, paths: filteredVariables.filter(path => variableCategory(path) === category) })).filter(group => group.paths.length > 0), [filteredVariables]);
  const categoryLabel = (category: VariableCategory) => ({
    attitude: tr('姿态与气动', 'Attitude & Aerodynamics'),
    position: tr('位置与速度', 'Position & Velocity'),
    inertia: tr('惯性与加速度', 'Inertia & Acceleration'),
    controls: tr('飞控与执行机构', 'FCS & Actuators'),
    propulsion: tr('推进系统', 'Propulsion'),
    environment: tr('环境', 'Environment'),
    simulation: tr('仿真与性能', 'Simulation & Performance'),
    other: tr('其他', 'Other'),
  } as Record<VariableCategory, string>)[category];
  const selectPaths = (paths: string[]) => set('mcap', 'selectedVariables', [...new Set([...selectedVariables, ...paths])]);
  const addManualVariable = () => {
    const path = `/${manualVariable.trim().replace(/^\/+/, '')}`;
    if (path === '/' || /\s/.test(path)) {
      setManualVariableError(tr('请输入有效的属性路径', 'Enter a valid property path'));
      return;
    }
    selectPaths([path]);
    setManualVariable('');
    setManualVariableError('');
  };

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(variableCacheKey) || '[]');
      setAvailableVariables(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []);
    } catch { setAvailableVariables([]); }
  }, [variableCacheKey]);

  useEffect(() => {
    if (telemetry?.model !== model) return;
    const paths = Object.entries(telemetry)
      .filter(([path, value]) => path.startsWith('/') && typeof value === 'number' && Number.isFinite(value))
      .map(([path]) => path)
      .sort((a, b) => a.localeCompare(b));
    if (paths.length === 0) return;
    setAvailableVariables(previous => {
      if (previous.length === paths.length && previous.every((path, index) => path === paths[index])) return previous;
      localStorage.setItem(variableCacheKey, JSON.stringify(paths));
      return paths;
    });
  }, [telemetry, model, variableCacheKey]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenFirmwareProgress(progress => {
      const ratio = progress.total > 0 ? Math.min(1, progress.completed / progress.total) : 0;
      if (progress.stage === 'upload') {
        setFirmwareUploadProgress(Math.round(ratio * 100));
      } else if (progress.stage === 'write') {
        setFirmwareInstallStage('write');
        setFirmwareInstallProgress(Math.round(ratio * 50));
      } else {
        setFirmwareInstallStage('verify');
        setFirmwareInstallProgress(50 + Math.round(ratio * 50));
      }
    }).then(stop => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    ftpDownloadSimConfig(path).then(result => {
      const loaded = merge(JSON.parse(result.content)); setConfig(loaded);
      setBaseline(JSON.stringify(loaded, null, 2)); setStatus(tr('已从仿真机读取', 'Loaded from simulator'));
    }).catch(() => { setConfig(defaults); setBaseline(''); setStatus(tr('未找到模型配置，当前使用默认值', 'No model configuration found; using defaults')); });
  }, [path]);

  const refreshSimulatorVersion = async () => {
    setVersionStatus(tr('正在读取仿真机版本…', 'Reading simulator version…'));
    try {
      const version = await ftpGetSimulatorVersion();
      setSimulatorVersion(version);
      setVersionStatus(tr('已读取仿真机版本', 'Simulator version loaded'));
    } catch (error: any) {
      setSimulatorVersion(null);
      setVersionStatus(`${tr('读取失败', 'Read failed')}: ${error?.message || error}`);
    }
  };

  const saveVersionSnapshot = () => {
    if (!simulatorVersion) return;
    const next = [{ ...simulatorVersion, savedAt: new Date().toISOString() }, ...versionSnapshots].slice(0, 20);
    setVersionSnapshots(next);
    localStorage.setItem('jsbsim-simulator-version-snapshots', JSON.stringify(next));
  };

  const chooseFirmware = async () => {
    try {
      const selected = await selectFirmwareFile();
      if (!selected) return;
      setFirmwareFile(selected);
      setFirmwareUploadProgress(0);
      setFirmwareInstallProgress(0);
      setFirmwareInstallStage('idle');
      setFirmwareStatus(`${selected.name} · ${(selected.size / 1024 / 1024).toFixed(2)} MiB`);
    } catch (error: any) {
      setFirmwareStatus(`${tr('选择固件失败', 'Failed to select firmware')}: ${error?.message || error}`);
    }
  };

  const updateFirmware = async () => {
    if (!firmwareFile || firmwareUpdating) return;
    if (!firmwareFile.name.toLowerCase().endsWith('.bin')) {
      setFirmwareStatus(tr('请选择 .bin 固件文件', 'Select a .bin firmware file'));
      return;
    }
    if (firmwareFile.size < 64 * 1024 || firmwareFile.size > 64 * 1024 * 1024) {
      setFirmwareStatus(tr('固件大小必须在 64 KiB 到 64 MiB 之间', 'Firmware size must be between 64 KiB and 64 MiB'));
      return;
    }
    if (!window.confirm(tr(
      `即将升级仿真机固件：\n${firmwareFile.name}\n${(firmwareFile.size / 1024 / 1024).toFixed(2)} MiB\n\n文件将先完整上传到 /data/fireware/nuttx.bin，校验后写入 eMMC。写入期间不要断电或拔除USB。确认继续吗？`,
      `Upgrade simulator firmware?\n${firmwareFile.name}\n${(firmwareFile.size / 1024 / 1024).toFixed(2)} MiB\n\nThe complete file is staged at /data/fireware/nuttx.bin before verified eMMC installation. Do not remove power or USB during installation.`
    ))) return;

    setFirmwareUpdating(true);
    setFirmwareUploadProgress(0);
    setFirmwareInstallProgress(0);
    setFirmwareInstallStage('idle');
    try {
      setFirmwareStatus(tr('正在通过USB上传到 /data/fireware…', 'Uploading to /data/fireware over USB…'));
      const staged = 'path' in firmwareFile
        ? await firmwareStageFile(firmwareFile.path)
        : await firmwareStage(firmwareFile.name, new Uint8Array(await firmwareFile.arrayBuffer()));
      setFirmwareUploadProgress(100);
      setFirmwareInstallStage('write');
      setFirmwareStatus(tr('上传完成，仿真机正在写入并回读校验 eMMC…', 'Upload complete; simulator is writing and verifying eMMC…'));
      const result = await firmwareApply(staged.size, staged.crc32);
      setFirmwareInstallProgress(100);
      setFirmwareInstallStage('success');
      setFirmwareStatus(`${tr('升级成功，重启仿真机后生效', 'Upgrade successful; reboot the simulator to activate')} · ${result.verification}`);
    } catch (error: any) {
      setFirmwareInstallStage('error');
      setFirmwareStatus(`${tr('升级失败', 'Upgrade failed')}: ${error?.message || error}`);
    } finally {
      setFirmwareUpdating(false);
    }
  };

  useEffect(() => { void refreshSimulatorVersion(); }, []);

  const refreshNetwork = async () => {
    setNetworkBusy(true);
    setNetworkStatus(tr('正在从仿真机回读网口…', 'Reading simulator interfaces…'));
    try {
      const interfaces = await readSimulatorNetwork();
      setNetworkInterfaces(interfaces);
      setNetworkInput(current => interfaces.find(item => item.name === current.name) || interfaces[0]);
      setNetworkStatus(tr('已从仿真机回读当前配置', 'Current configuration read from simulator'));
    } catch (error: any) {
      setNetworkStatus(`${tr('回读失败', 'Readback failed')}: ${error?.message || error}`);
    } finally { setNetworkBusy(false); }
  };

  useEffect(() => { void refreshNetwork(); }, []);

  const applyNetwork = async () => {
    if (networkBusy || !window.confirm(tr(
      `将 ${networkInput.name} 改为 ${networkInput.address}，当前网络连接可能立即中断。请保持 USB 连接以完成回读。继续吗？`,
      `Change ${networkInput.name} to ${networkInput.address}? The network connection may drop immediately. Keep USB connected for readback.`
    ))) return;
    setNetworkBusy(true);
    setNetworkStatus(tr('正在通过 USB 写入并回读…', 'Writing and reading back over USB…'));
    try {
      const actual = await setSimulatorNetwork(networkInput);
      setNetworkInterfaces(current => [...current.filter(item => item.name !== actual.name), actual].sort((a, b) => a.name.localeCompare(b.name)));
      setNetworkInput(actual);
      setNetworkStatus(tr('写入成功，IP、掩码和网关均已从仿真机核对', 'Applied; IP, mask and gateway verified from simulator'));
    } catch (error: any) {
      setNetworkStatus(`${tr('写入或回读失败', 'Apply or readback failed')}: ${error?.message || error}`);
    } finally { setNetworkBusy(false); }
  };

  const save = async () => {
    if (saving) return;
    const changedGroups = Object.keys(defaults).filter(key => key !== 'version' && JSON.stringify((config as any)[key]) !== JSON.stringify((baseline ? JSON.parse(baseline) : defaults as any)[key]));
    if (!window.confirm(isZh
      ? `保存到仿真机：\n/mnt/sdcard/jsbsim/${path}\n\n变更分组：${changedGroups.join('、') || '无'}\n配置将在下次重新加载模型时生效。`
      : `Save to simulator:\n/mnt/sdcard/jsbsim/${path}\n\nChanged groups: ${changedGroups.join(', ') || 'None'}\nThe configuration takes effect after the model is reloaded.`)) return;
    setSaving(true);
    setStatus(tr('正在写入仿真机SD卡并回读校验…', 'Writing to simulator SD card and verifying…'));
    try {
      await ftpUploadSimConfig(path, serialized);
      setBaseline(serialized);
      setStatus(tr('已保存并回读校验，重新加载模型后生效', 'Saved and verified; reload the model to apply'));
    } catch (error: any) {
      setStatus(`${tr('保存失败，修改已保留', 'Save failed; edits retained')}: ${error?.message || error}`);
    } finally {
      setSaving(false);
    }
  };

  const applyPlotRate = async () => {
    const rate = Number(plotRateInput);
    if (plotRateInput.trim() === '' || !Number.isInteger(rate) || rate < 0 || rate > 200) {
      setPlotRateStatus(tr('请输入 0～200 的整数。', 'Enter an integer from 0 to 200.'));
      return;
    }
    setPlotRateSaving(true);
    try {
      await setPlotJugglerRate(rate);
      setPlotRateApplied(rate);
      setPlotRateStatus(tr('已应用并保存到本机。', 'Applied and saved locally.'));
    } catch (error) {
      setPlotRateStatus(`${tr('应用失败', 'Failed to apply')}: ${String(error)}`);
    } finally {
      setPlotRateSaving(false);
    }
  };

  return <div className="sim-config-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !firmwareUpdating) onClose(); }}>
    <div className="sim-config-dialog">
      <header><div><b>⚙ {tr('仿真配置', 'Simulation Configuration')}</b><span>{tr('模型', 'Model')}: {safeModel}</span></div><button disabled={firmwareUpdating} onClick={onClose}>×</button></header>
      <div className="simulator-version-card">
        <div><strong>{tr('仿真机版本', 'Simulator Version')}</strong><small>{versionStatus}</small></div>
        {simulatorVersion ? <div className="simulator-version-values"><b>{simulatorVersion.product || 'JSBSim Realtime'} {simulatorVersion.version || '—'}</b><span>{simulatorVersion.firmware || '—'} · JSBSim {simulatorVersion.jsbsim || '—'} · {tr('航空库', 'Aviation library')} {simulatorVersion.aviation_library || '—'}</span><span title={simulatorVersion.build_time}>{tr('编译时间', 'Built')} {formatBuildTime(simulatorVersion.build_time, isZh)} · Git {simulatorVersion.git_short_hash || '—'}</span></div> : <span className="simulator-version-unavailable">—</span>}
        <button type="button" disabled={firmwareUpdating} onClick={() => setTab('固件升级')}>{tr('升级固件', 'Upgrade Firmware')}</button>
        <button type="button" disabled={firmwareUpdating} onClick={() => setShowVersionManager(true)}>{tr('版本管理', 'Version Manager')}</button>
        <button type="button" disabled={firmwareUpdating} onClick={() => void refreshSimulatorVersion()}>{tr('刷新', 'Refresh')}</button>
      </div>
      <div className="sim-config-path">{tr('SD卡路径', 'SD card path')}: /mnt/sdcard/jsbsim/{path}</div>
      <div className="sim-config-layout">
        <nav>{tabs.map(item => <button key={item} disabled={firmwareUpdating} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{({系统设置:'System Settings',运行与时间:'Runtime & Time',数值积分:'Integration',初始状态:'Initial State',环境模型:'Environment',MCAP日志:'MCAP Logging',性能与安全:'Performance & Safety',固件升级:'Firmware Upgrade'} as any)[item] && !isZh ? ({系统设置:'System Settings',运行与时间:'Runtime & Time',数值积分:'Integration',初始状态:'Initial State',环境模型:'Environment',MCAP日志:'MCAP Logging',性能与安全:'Performance & Safety',固件升级:'Firmware Upgrade'} as any)[item] : item}</button>)}</nav>
        <main>
          {tab === '系统设置' && <section className="sim-config-network"><h3>{tr('系统设置', 'System Settings')}</h3><p>{tr('仿真机网口 IPv4 配置与实时回读。', 'Simulator Ethernet IPv4 configuration and live readback.')}</p>
            <div className="sim-config-network-head"><b>{tr('仿真机 IP', 'Simulator IP')}</b><button type="button" disabled={networkBusy} onClick={() => void refreshNetwork()}>{tr('回读', 'Read Back')}</button></div>
            <div className="sim-config-grid">
              <label className="sim-config-field"><span>{tr('网口', 'Interface')}</span><select value={networkInput.name} onChange={event => { const selected = networkInterfaces.find(item => item.name === event.target.value); if (selected) setNetworkInput(selected); }} disabled={networkBusy}>{networkInterfaces.length ? networkInterfaces.map(item => <option key={item.name} value={item.name}>{item.name}</option>) : <option value="eth0">eth0</option>}</select></label>
              {([['address', tr('IP 地址', 'IP address')], ['netmask', tr('子网掩码', 'Subnet mask')], ['gateway', tr('网关', 'Gateway')]] as const).map(([key, label]) => <label className="sim-config-field" key={key}><span>{label}</span><input type="text" inputMode="decimal" value={networkInput[key]} onChange={event => setNetworkInput(current => ({ ...current, [key]: event.target.value }))} disabled={networkBusy} placeholder="192.168.101.81" /></label>)}
            </div>
            <div className="sim-config-network-actions"><button type="button" disabled={networkBusy || networkInterfaces.length === 0 || !networkInput.address || !networkInput.netmask || !networkInput.gateway} onClick={() => void applyNetwork()}>{tr('通过 USB 应用并回读', 'Apply over USB and read back')}</button><span role="status">{networkStatus}</span></div>
            <p>{tr('修改仅对当前运行生效；重启后恢复固件默认网络配置。修改 IP 时请保持 USB 连接。', 'Changes apply to this runtime only; reboot restores firmware defaults. Keep USB connected when changing the IP.')}</p>
          </section>}
          {tab === '运行与时间' && <section><h3>{tr('运行与时间','Runtime & Time')}</h3><div className="sim-config-grid">
            <NumberField label={tr('仿真步长','Time step')} value={config.runtime.dt} step={0.0001} min={0.00001} unit="s" onChange={(v:any)=>set('runtime','dt',v)} />
            <NumberField label={tr('仿真频率（只读）','Simulation rate (read-only)')} value={(1/config.runtime.dt).toFixed(1)} unit="Hz" onChange={()=>{}} />
            <NumberField label={tr('每周期迭代次数','Iterations per cycle')} value={config.runtime.iterationsPerCycle} min={1} onChange={(v:any)=>set('runtime','iterationsPerCycle',v)} />
            <NumberField label={tr('最大追赶迭代次数','Maximum catch-up iterations')} value={config.runtime.catchupIterations} min={1} onChange={(v:any)=>set('runtime','catchupIterations',v)} />
            <NumberField label={tr('实时倍率','Real-time factor')} value={config.runtime.realtimeFactor} step={0.1} min={0.1} unit="×" onChange={(v:any)=>set('runtime','realtimeFactor',v)} />
            <SelectField label={tr('脚本结束行为','End-of-script action')} value={config.runtime.endBehavior} onChange={(v:any)=>set('runtime','endBehavior',v)}><option value="stop">{tr('停止','Stop')}</option><option value="pause">{tr('暂停','Pause')}</option><option value="loop">{tr('循环','Loop')}</option></SelectField>
          </div><div className="sim-config-plotjuggler">
            <label htmlFor="sim-config-plot-rate">{tr('PlotJuggler 发送频率', 'PlotJuggler send rate')}</label>
            <div><input id="sim-config-plot-rate" type="number" min="0" max="200" step="1" value={plotRateInput}
              onChange={event => { setPlotRateInput(event.target.value); setPlotRateStatus(''); }}
              onKeyDown={event => { if (event.key === 'Enter') void applyPlotRate(); }} />
              <span>Hz</span><button type="button" disabled={plotRateSaving} onClick={() => void applyPlotRate()}>{tr('应用', 'Apply')}</button>
              <small>{tr(`当前：${plotRateApplied === 0 ? '逐包发送' : `${plotRateApplied} Hz`}`, `Current: ${plotRateApplied === 0 ? 'every packet' : `${plotRateApplied} Hz`}`)}</small>
            </div>
            <p>{tr('0 为逐包发送；1～200 Hz 为上位机转发上限。本机设置立即生效，无需保存到仿真机。', '0 sends every packet; 1–200 Hz caps forwarding from this computer. Applies immediately and does not require saving to the simulator.')}</p>
            {plotRateStatus && <small role="status">{plotRateStatus}</small>}
          </div></section>}
          {tab === '数值积分' && <section><h3>{tr('数值积分','Numerical Integration')}</h3><p>{tr('修改后需重新加载模型。','Reload the model to apply changes.')}</p><div className="sim-config-grid">
            {([['rotationalRate',tr('旋转角速度','Rotational rate')],['translationalRate',tr('平移速度','Translational rate')],['rotationalPosition',tr('旋转姿态','Rotational position')],['translationalPosition',tr('平移位置','Translational position')]] as const).map(([key,label]) => <SelectField key={key} label={label} value={String(config.integrators[key])} onChange={(v:any)=>set('integrators',key,Number(v))}>{integratorOptions(isZh)}</SelectField>)}
          </div></section>}
          {tab === '初始状态' && <section><h3>{tr('初始状态','Initial State')}</h3><div className="sim-config-grid">
            {([['latitudeDeg',tr('纬度','Latitude'),'°'],['longitudeDeg',tr('经度','Longitude'),'°'],['altitudeM',tr('海拔','Altitude'),'m'],['rollDeg','Roll','°'],['pitchDeg','Pitch','°'],['yawDeg','Yaw','°'],['airspeedMps',tr('初始空速','Initial airspeed'),'m/s']] as const).map(([key,label,unit]) => <NumberField key={key} label={label} value={config.initial[key]} step={0.1} unit={unit} onChange={(v:any)=>set('initial',key,v)} />)}
            <label className="sim-config-check"><input type="checkbox" checked={config.initial.trim} onChange={e=>set('initial','trim',e.target.checked)} />{tr('启动时执行配平','Trim on startup')}</label>
          </div></section>}
          {tab === '环境模型' && <section><h3>{tr('环境模型','Environment Model')}</h3><p>{tr('运行时由 JSBSim 的 FGStandardAtmosphere/FGWinds 读取；保存后需重新加载模型。','Applied through JSBSim FGStandardAtmosphere/FGWinds after reload.')}</p><div className="sim-config-grid">
            <NumberField label={tr('海平面压力','Sea-level pressure')} value={config.environment.pressureSlPsf} step={0.01} min={0} unit="PSF" onChange={(v:any)=>set('environment','pressureSlPsf',v)} />
            <NumberField label={tr('温度偏差','Temperature bias')} value={config.environment.temperatureBiasR} step={0.1} unit="R" onChange={(v:any)=>set('environment','temperatureBiasR',v)} />
            <NumberField label={tr('相对湿度','Relative humidity')} value={config.environment.relativeHumidityPct} step={1} min={0} unit="%" onChange={(v:any)=>set('environment','relativeHumidityPct',v)} />
            <NumberField label={tr('北向风','North wind')} value={config.environment.windNorthFps} step={0.1} unit="ft/s" onChange={(v:any)=>set('environment','windNorthFps',v)} />
            <NumberField label={tr('东向风','East wind')} value={config.environment.windEastFps} step={0.1} unit="ft/s" onChange={(v:any)=>set('environment','windEastFps',v)} />
            <NumberField label={tr('地向风','Down wind')} value={config.environment.windDownFps} step={0.1} unit="ft/s" onChange={(v:any)=>set('environment','windDownFps',v)} />
            <SelectField label={tr('湍流模型','Turbulence model')} value={String(config.environment.turbulenceType)} onChange={(v:any)=>set('environment','turbulenceType',Number(v))}><option value="0">0 · {tr('关闭','Off')}</option><option value="1">1 · Standard</option><option value="2">2 · Culp</option><option value="3">3 · MIL-SPEC</option><option value="4">4 · Tustin</option></SelectField>
            <NumberField label={tr('20 ft 风速','20 ft wind speed')} value={config.environment.turbulenceWindspeed20ftFps} step={0.1} min={0} unit="ft/s" onChange={(v:any)=>set('environment','turbulenceWindspeed20ftFps',v)} />
            <NumberField label={tr('湍流强度','Turbulence severity')} value={config.environment.turbulenceSeverity} step={1} min={0} unit="0–7" onChange={(v:any)=>set('environment','turbulenceSeverity',Math.min(7, Math.max(0, v)))} />
          </div></section>}
          {tab === 'MCAP日志' && <section><h3>{tr('MCAP日志','MCAP Logging')}</h3><div className="sim-config-grid">
            <label className="sim-config-check"><input type="checkbox" checked={config.mcap.enabled} onChange={e=>set('mcap','enabled',e.target.checked)} />{tr('启用 MCAP 日志','Enable MCAP logging')}</label>
            <NumberField label={tr('状态与关键字段频率','State and critical field rate')} value={config.mcap.rateHz} min={1} unit="Hz" onChange={(v:any)=>set('mcap','rateHz',Math.min(500,v))} /><NumberField label={tr('普通字段频率','Background field rate')} value={config.mcap.backgroundRateHz} min={1} unit="Hz" onChange={(v:any)=>set('mcap','backgroundRateHz',Math.min(500,v))} /><NumberField label={tr('队列深度','Queue depth')} value={config.mcap.queueDepth} min={32} onChange={(v:any)=>set('mcap','queueDepth',Math.min(2048,v))} />
            <NumberField label={tr('RAM日志缓冲区','RAM log buffer')} value={config.mcap.bufferMb} min={1} unit="MiB" onChange={(v:any)=>set('mcap','bufferMb',Math.min(1536,v))} />
            <NumberField label={tr('单文件上限','Maximum file size')} value={config.mcap.maxFileMb} min={16} unit="MiB" onChange={(v:any)=>set('mcap','maxFileMb',v)} /><NumberField label={tr('最长记录时间','Maximum duration')} value={config.mcap.maxDurationMin} min={1} unit="min" onChange={(v:any)=>set('mcap','maxDurationMin',v)} /><NumberField label={tr('最小剩余空间','Minimum free space')} value={config.mcap.minFreeMb} min={32} unit="MiB" onChange={(v:any)=>set('mcap','minFreeMb',v)} />
          </div>
          <div className="mcap-variable-selector">
            <div>
              <b>{tr('记录变量选择器', 'Recorded Variable Selector')}</b>
              <small>{tr(
                `已选 ${selectedVariables.length} 项，其中 ${criticalVariables.length} 项关键字段按状态频率记录，其余按普通字段频率记录。基础状态始终按状态频率记录。重新加载模型后生效。`,
                `${selectedVariables.length} selected; ${criticalVariables.length} critical fields use the state rate, others use the background rate. Base state always uses the state rate. Applies after model reload.`
              )}</small>
            </div>
            <div className="mcap-variable-toolbar">
              <button type="button" onClick={() => selectPaths(availableVariables)} disabled={availableVariables.length === 0}>{tr('全选', 'Select All')}</button>
              <button type="button" onClick={() => setConfig((current: any) => ({ ...current, mcap: { ...current.mcap, selectedVariables: [], criticalVariables: [] } }))} disabled={selectedVariables.length === 0}>{tr('清空选择', 'Clear')}</button>
              <span>{tr(`已发现 ${availableVariables.length} 项`, `${availableVariables.length} discovered`)}</span>
            </div>
            <input value={variableFilter} onChange={event => setVariableFilter(event.target.value)} placeholder={tr('搜索属性路径…', 'Search property paths…')} />
            <div className="mcap-variable-manual">
              <input value={manualVariable} onChange={event => { setManualVariable(event.target.value); setManualVariableError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManualVariable(); } }} placeholder={tr('手动输入属性路径，如 /attitude/phi-deg', 'Enter a property path, e.g. /attitude/phi-deg')} />
              <button type="button" onClick={addManualVariable}>{tr('添加', 'Add')}</button>
            </div>
            {manualVariableError && <small role="alert">{manualVariableError}</small>}
            {connected && telemetry?.model && telemetry.model !== model &&
              <small>{tr(`当前运行模型为 ${telemetry.model}；此处仅显示 ${model} 的已保存变量。`, `Running model: ${telemetry.model}; showing saved variables for ${model}.`)}</small>}
            {selectedVariables.length > 0 && <div className="mcap-selected-variables">
              {selectedVariables.map(path => <span key={path}><button onClick={() => toggleVariable(path)} title={tr('移除', 'Remove')}>× {path}</button><label><input type="checkbox" checked={criticalVariables.includes(path)} onChange={() => toggleCriticalVariable(path)} />{tr('关键','Critical')}</label></span>)}
            </div>}
            <div className="mcap-variable-list">
              {variableGroups.map(group => <section className="mcap-variable-category" key={group.category}>
                <header><b>{categoryLabel(group.category)}</b><span>{group.paths.length}</span><button type="button" onClick={() => selectPaths(group.paths)} disabled={group.paths.every(path => selectedVariables.includes(path))}>{tr('选择本类', 'Select category')}</button></header>
                {group.paths.map(path => <label key={path}><input type="checkbox" checked={selectedVariables.includes(path)} onChange={() => toggleVariable(path)} /><span>{path}</span></label>)}
              </section>)}
              {allVariables.length === 0 && <span className="mcap-variable-empty">{tr('暂无已发现的属性。加载当前模型并等待遥测属性树，或在上方手动输入路径。', 'No properties discovered. Load this model and wait for telemetry, or enter a path above.')}</span>}
              {allVariables.length > 0 && variableGroups.length === 0 && <span className="mcap-variable-empty">{tr('没有匹配的变量。', 'No matching variables.')}</span>}
            </div>
          </div>
          <div className="sim-config-readonly">{tr('目录','Directory')}: {config.mcap.directory}<br />{tr('变量数量不再设上限；可记录数量取决于仿真机可用内存和存储空间。压缩：LZ4 Frame；Chunk：1 MiB/最长5秒；CRC：开启；正常关闭后 .active 重命名为 .mcap。','The variable count is unlimited; the practical limit is available simulator memory and storage. Compression: LZ4 Frame; chunk: 1 MiB/maximum 5 seconds; CRC enabled; .active is renamed to .mcap after a clean close.')}</div></section>}
          {tab === '性能与安全' && <section><h3>{tr('性能与安全','Performance & Safety')}</h3><div className="sim-config-grid">
            <NumberField label={tr('CPU核心','CPU core')} value={config.safety.cpuCore} min={0} onChange={(v:any)=>set('safety','cpuCore',v)} /><NumberField label={tr('任务优先级','Task priority')} value={config.safety.taskPriority} min={1} onChange={(v:any)=>set('safety','taskPriority',v)} /><NumberField label={tr('任务栈','Task stack')} value={config.safety.stackKb} min={64} unit="KiB" onChange={(v:any)=>set('safety','stackKb',v)} />
            <NumberField label={tr('FDM超时阈值','FDM timeout')} value={config.safety.fdmTimeoutMs} step={0.1} unit="ms" onChange={(v:any)=>set('safety','fdmTimeoutMs',v)} /><NumberField label={tr('CPU告警','CPU warning')} value={config.safety.cpuWarningPercent} unit="%" onChange={(v:any)=>set('safety','cpuWarningPercent',v)} /><NumberField label={tr('RAM告警','RAM warning')} value={config.safety.ramWarningPercent} unit="%" onChange={(v:any)=>set('safety','ramWarningPercent',v)} />
            <label className="sim-config-check"><input type="checkbox" checked={config.safety.nanCheck} onChange={e=>set('safety','nanCheck',e.target.checked)} />{tr('NaN/Inf检测','NaN/Inf detection')}</label><SelectField label={tr('异常处理','Fault action')} value={config.safety.faultAction} onChange={(v:any)=>set('safety','faultAction',v)}><option value="stop">{tr('停止仿真','Stop simulation')}</option><option value="pause">{tr('暂停','Pause')}</option><option value="restart">{tr('重新加载','Reload')}</option></SelectField>
            <label className="sim-config-check"><input type="checkbox" checked={config.diagnostics.usbDebugPrint} onChange={e=>set('diagnostics','usbDebugPrint',e.target.checked)} />{tr('USB 调试打印','USB debug prints')}</label>
            <p className="sim-config-readonly">{tr('默认关闭 USB 状态和收发统计打印。保存后重新加载模型生效；开启可用于排查通信问题。', 'USB status and transfer statistics are off by default. Save and reload the model to apply; enable when diagnosing communication issues.')}</p>
          </div></section>}
          {tab === '固件升级' && <section className="firmware-upgrade-page">
            <h3>{tr('固件升级', 'Firmware Upgrade')}</h3>
            <p>{tr('先完整上传固件，再由仿真机写入 eMMC 固件分区并回读校验。升级成功后手动重启生效。', 'The image is staged first, then written to the eMMC firmware partition and read back for verification. Reboot manually after success.')}</p>
            <div className="firmware-upgrade-card">
              <div className="firmware-target"><span>{tr('暂存位置', 'Staging')}</span><b>/data/fireware/nuttx.bin</b><span>{tr('启动位置', 'Boot slot')}</span><b>SIM_FW · slot A</b></div>
              {isTauri && /Linux/i.test(navigator.userAgent)
                ? <button type="button" className="firmware-file-picker" disabled={firmwareUpdating} onClick={() => void chooseFirmware()} title={firmwareFile && 'path' in firmwareFile ? firmwareFile.path : undefined}><span>{firmwareFile ? firmwareFile.name : tr('选择 nuttx.bin 固件', 'Choose nuttx.bin firmware')}</span></button>
                : <label className="firmware-file-picker"><input type="file" accept=".bin,application/octet-stream" disabled={firmwareUpdating} onChange={event => { const file = event.target.files?.[0] || null; setFirmwareFile(file); setFirmwareUploadProgress(0); setFirmwareInstallProgress(0); setFirmwareInstallStage('idle'); setFirmwareStatus(file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB` : tr('请选择 nuttx.bin 固件', 'Select a nuttx.bin firmware image')); }} /><span>{firmwareFile ? firmwareFile.name : tr('选择 nuttx.bin 固件', 'Choose nuttx.bin firmware')}</span></label>}
              <div className="firmware-file-details">{firmwareFile ? `${(firmwareFile.size / 1024 / 1024).toFixed(2)} MiB · ${tr('允许 64 KiB–64 MiB', '64 KiB–64 MiB allowed')}` : tr('请选择 AArch64 NuttX .bin 文件', 'Select an AArch64 NuttX .bin file')}</div>
              <div className="firmware-progress-row"><div><span>{tr('上传到数据分区', 'Upload to data partition')}</span><b>{firmwareUploadProgress}%</b></div><div className="firmware-progress-track"><i style={{ width: `${firmwareUploadProgress}%` }} /></div></div>
              <div className="firmware-progress-row"><div><span>{firmwareInstallStage === 'verify' ? tr('eMMC 回读校验', 'eMMC readback verification') : tr('写入 eMMC 固件分区', 'Write eMMC firmware partition')}</span><b>{firmwareInstallProgress}%</b></div><div className={`firmware-progress-track ${firmwareInstallStage}`}><i style={{ width: `${firmwareInstallProgress}%` }} /></div></div>
              <button type="button" className="firmware-update-button" disabled={!firmwareFile || firmwareUpdating} onClick={() => void updateFirmware()}>{firmwareUpdating ? tr('升级中…', 'Updating…') : tr('开始升级', 'Start Upgrade')}</button>
              <p className={firmwareInstallStage === 'error' ? 'error' : ''}>{firmwareStatus}</p>
              <small>{tr('写入期间请勿断电或拔出 USB。固件采用单槽写入，异常中断需通过 U-Boot 恢复。', 'Do not remove power or USB during installation. This is a single-slot update; recover through U-Boot if it is interrupted.')}</small>
            </div>
          </section>}
        </main>
      </div>
      <footer><span role="status">{tab === '固件升级' ? firmwareStatus : tab === '系统设置' ? networkStatus : status}</span>{tab !== '固件升级' && tab !== '系统设置' && <div><button disabled={saving} onClick={()=>setConfig(defaults)}>{tr('恢复默认值','Restore Defaults')}</button><button className="primary" disabled={saving || serialized === baseline} onClick={()=>void save()}>{saving?tr('保存中…','Saving…'):tr('保存到仿真机','Save to Simulator')}</button></div>}</footer>
      {showVersionManager && <div className="sim-config-version-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !firmwareUpdating) setShowVersionManager(false); }}>
        <section className="sim-config-version-manager">
          <header><b>{tr('仿真机版本管理', 'Simulator Version Manager')}</b><button type="button" disabled={firmwareUpdating} onClick={() => setShowVersionManager(false)}>×</button></header>
          <p>{tr('版本来自仿真机只读 VERSION.json；快照保存在本机，便于记录每次固件和航空库组合。', 'The version comes from the simulator read-only VERSION.json. Snapshots are stored locally to track firmware and aviation-library combinations.')}</p>
          <div className="sim-config-version-actions"><button type="button" disabled={firmwareUpdating} onClick={() => void refreshSimulatorVersion()}>{tr('重新读取仿真机', 'Read simulator')}</button><button type="button" disabled={!simulatorVersion || firmwareUpdating} onClick={saveVersionSnapshot}>{tr('保存当前快照', 'Save snapshot')}</button></div>
          <div className="sim-config-version-list">{versionSnapshots.length === 0 ? <span>{tr('暂无版本快照', 'No version snapshots')}</span> : versionSnapshots.map((item, index) => <article key={`${item.savedAt}-${index}`}><b>{item.product || 'JSBSim Realtime'} {item.version || '—'}</b><span>{item.firmware || '—'} · JSBSim {item.jsbsim || '—'} · {new Date(item.savedAt).toLocaleString()}</span></article>)}</div>
        </section>
      </div>}
    </div>
  </div>;
}
