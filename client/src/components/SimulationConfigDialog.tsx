import { useEffect, useMemo, useState } from 'react';
import { ftpDownloadSimConfig, ftpUploadSimConfig } from '../utils/tauriApi';
import { useLanguage } from '../i18n';

type Tab = '运行与时间' | '数值积分' | '初始状态' | '环境模型' | 'MCAP日志' | '性能与安全';
type VariableCategory = 'attitude' | 'position' | 'inertia' | 'controls' | 'propulsion' | 'environment' | 'simulation' | 'other';
const tabs: Tab[] = ['运行与时间', '数值积分', '初始状态', '环境模型', 'MCAP日志', '性能与安全'];
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
  mcap: { enabled: true, rateHz: 50, directory: '/mnt/sdcard/LOG', maxFileMb: 512, maxDurationMin: 60, queueDepth: 256, bufferMb: 500, minFreeMb: 128, selectedVariables: [] as string[] },
  safety: { cpuCore: 0, taskPriority: 120, stackKb: 256, fdmTimeoutMs: 4, cpuWarningPercent: 90, ramWarningPercent: 85, nanCheck: true, faultAction: 'stop' },
};

const merge = (source: any) => ({
  ...defaults, ...source,
  runtime: { ...defaults.runtime, ...source?.runtime },
  integrators: { ...defaults.integrators, ...source?.integrators },
  initial: { ...defaults.initial, ...source?.initial },
  environment: { ...defaults.environment, ...source?.environment },
  mcap: { ...defaults.mcap, ...source?.mcap },
  safety: { ...defaults.safety, ...source?.safety },
});

function NumberField({ label, value, onChange, unit, step = 1, min }: any) {
  return <label className="sim-config-field"><span>{label}</span><div><input type="number" value={value} step={step} min={min} onChange={e => onChange(Number(e.target.value))} />{unit && <em>{unit}</em>}</div></label>;
}
function SelectField({ label, value, onChange, children }: any) {
  return <label className="sim-config-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{children}</select></label>;
}
const integratorOptions = (isZh: boolean) => <>{[['0',isZh?'冻结':'Freeze'],['1',isZh?'矩形欧拉':'Rectangular Euler'],['2',isZh?'梯形':'Trapezoidal'],['3','Adams–Bashforth 2'],['4','Adams–Bashforth 3'],['5','Adams–Bashforth 4']].map(([v,n]) => <option key={v} value={v}>{n}</option>)}</>;

export default function SimulationConfigDialog({ model, onClose }: { model: string; onClose: () => void }) {
  const { isZh } = useLanguage();
  const tr = (zh: string, en: string) => isZh ? zh : en;
  const safeModel = (model || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const path = `config/models/${safeModel}.json`;
  const [tab, setTab] = useState<Tab>('运行与时间');
  const [config, setConfig] = useState<any>(defaults);
  const [baseline, setBaseline] = useState('');
  const [status, setStatus] = useState(tr('正在读取仿真机配置…', 'Reading simulator configuration…'));
  const [saving, setSaving] = useState(false);
  const [variableFilter, setVariableFilter] = useState('');
  const [availableVariables, setAvailableVariables] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem('jsbsim-available-variables') || '[]'); return Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []; } catch { return []; }
  });
  const serialized = useMemo(() => JSON.stringify(config, null, 2), [config]);
  const set = (group: string, key: string, value: any) => setConfig((current: any) => ({ ...current, [group]: { ...current[group], [key]: value } }));
  const selectedVariables: string[] = Array.isArray(config.mcap.selectedVariables) ? config.mcap.selectedVariables : [];
  const toggleVariable = (path: string) => {
    if (selectedVariables.includes(path)) set('mcap', 'selectedVariables', selectedVariables.filter(item => item !== path));
    else set('mcap', 'selectedVariables', [...selectedVariables, path]);
  };
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

  useEffect(() => {
    const update = (event: Event) => {
      const paths = (event as CustomEvent).detail;
      if (Array.isArray(paths)) setAvailableVariables(paths.filter(value => typeof value === 'string'));
    };
    window.addEventListener('jsbsim-variables-updated', update);
    return () => window.removeEventListener('jsbsim-variables-updated', update);
  }, []);

  useEffect(() => {
    ftpDownloadSimConfig(path).then(result => {
      const loaded = merge(JSON.parse(result.content)); setConfig(loaded);
      setBaseline(JSON.stringify(loaded, null, 2)); setStatus(tr('已从仿真机读取', 'Loaded from simulator'));
    }).catch(() => { setConfig(defaults); setBaseline(''); setStatus(tr('未找到模型配置，当前使用默认值', 'No model configuration found; using defaults')); });
  }, [path]);

  const save = async () => {
    const changedGroups = Object.keys(defaults).filter(key => key !== 'version' && JSON.stringify((config as any)[key]) !== JSON.stringify((baseline ? JSON.parse(baseline) : defaults as any)[key]));
    if (!window.confirm(isZh
      ? `保存到仿真机：\n/mnt/sdcard/jsbsim/${path}\n\n变更分组：${changedGroups.join('、') || '无'}\n配置将在下次重新加载模型时生效。`
      : `Save to simulator:\n/mnt/sdcard/jsbsim/${path}\n\nChanged groups: ${changedGroups.join(', ') || 'None'}\nThe configuration takes effect after the model is reloaded.`)) return;
    setSaving(true);
    try { await ftpUploadSimConfig(path, serialized); setBaseline(serialized); setStatus(tr('已保存到仿真机SD卡（掉电保持）', 'Saved to simulator SD card (persistent)')); }
    catch (error: any) { setStatus(`${tr('保存失败', 'Save failed')}: ${error?.message || error}`); }
    setSaving(false);
  };

  return <div className="sim-config-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="sim-config-dialog">
      <header><div><b>⚙ {tr('仿真配置', 'Simulation Configuration')}</b><span>{tr('模型', 'Model')}: {safeModel}</span></div><button onClick={onClose}>×</button></header>
      <div className="sim-config-path">{tr('SD卡路径', 'SD card path')}: /mnt/sdcard/jsbsim/{path}</div>
      <div className="sim-config-layout">
        <nav>{tabs.map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{({运行与时间:'Runtime & Time',数值积分:'Integration',初始状态:'Initial State',环境模型:'Environment',MCAP日志:'MCAP Logging',性能与安全:'Performance & Safety'} as any)[item] && !isZh ? ({运行与时间:'Runtime & Time',数值积分:'Integration',初始状态:'Initial State',环境模型:'Environment',MCAP日志:'MCAP Logging',性能与安全:'Performance & Safety'} as any)[item] : item}</button>)}</nav>
        <main>
          {tab === '运行与时间' && <section><h3>{tr('运行与时间','Runtime & Time')}</h3><div className="sim-config-grid">
            <NumberField label={tr('仿真步长','Time step')} value={config.runtime.dt} step={0.0001} min={0.00001} unit="s" onChange={(v:any)=>set('runtime','dt',v)} />
            <NumberField label={tr('仿真频率（只读）','Simulation rate (read-only)')} value={(1/config.runtime.dt).toFixed(1)} unit="Hz" onChange={()=>{}} />
            <NumberField label={tr('每周期迭代次数','Iterations per cycle')} value={config.runtime.iterationsPerCycle} min={1} onChange={(v:any)=>set('runtime','iterationsPerCycle',v)} />
            <NumberField label={tr('最大追赶迭代次数','Maximum catch-up iterations')} value={config.runtime.catchupIterations} min={1} onChange={(v:any)=>set('runtime','catchupIterations',v)} />
            <NumberField label={tr('实时倍率','Real-time factor')} value={config.runtime.realtimeFactor} step={0.1} min={0.1} unit="×" onChange={(v:any)=>set('runtime','realtimeFactor',v)} />
            <SelectField label={tr('脚本结束行为','End-of-script action')} value={config.runtime.endBehavior} onChange={(v:any)=>set('runtime','endBehavior',v)}><option value="stop">{tr('停止','Stop')}</option><option value="pause">{tr('暂停','Pause')}</option><option value="loop">{tr('循环','Loop')}</option></SelectField>
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
            <label className="sim-config-check"><input type="checkbox" checked={config.mcap.enabled} onChange={e=>set('mcap','enabled',e.target.checked)} />{tr('启用 Protobuf + MCAP 日志','Enable Protobuf + MCAP logging')}</label>
            <NumberField label={tr('记录频率','Logging rate')} value={config.mcap.rateHz} min={1} unit="Hz" onChange={(v:any)=>set('mcap','rateHz',v)} /><NumberField label={tr('队列深度','Queue depth')} value={config.mcap.queueDepth} min={32} onChange={(v:any)=>set('mcap','queueDepth',v)} />
            <NumberField label={tr('RAM日志缓冲区','RAM log buffer')} value={config.mcap.bufferMb} min={1} unit="MiB" onChange={(v:any)=>set('mcap','bufferMb',Math.min(1536,v))} />
            <NumberField label={tr('单文件上限','Maximum file size')} value={config.mcap.maxFileMb} min={16} unit="MiB" onChange={(v:any)=>set('mcap','maxFileMb',v)} /><NumberField label={tr('最长记录时间','Maximum duration')} value={config.mcap.maxDurationMin} min={1} unit="min" onChange={(v:any)=>set('mcap','maxDurationMin',v)} /><NumberField label={tr('最小剩余空间','Minimum free space')} value={config.mcap.minFreeMb} min={32} unit="MiB" onChange={(v:any)=>set('mcap','minFreeMb',v)} />
          </div><div className="mcap-variable-selector"><div><b>{tr('日志变量选择器','Log Variable Selector')}</b><small>{tr(`已选 ${selectedVariables.length} 项；按分类选择实时属性，重新加载模型后生效。`,`Selected ${selectedVariables.length}; select live properties by category. Applies after model reload.`)}</small></div><div className="mcap-variable-toolbar"><button type="button" onClick={() => selectPaths(allVariables)} disabled={allVariables.length === 0}>{tr('全选','Select All')}</button><button type="button" onClick={() => set('mcap', 'selectedVariables', [])} disabled={selectedVariables.length === 0}>{tr('清空选择','Clear')}</button><span>{tr(`已发现 ${allVariables.length} 项`, `${allVariables.length} discovered`)}</span></div><input value={variableFilter} onChange={event => setVariableFilter(event.target.value)} placeholder={tr('搜索属性路径…','Search property paths…')} />{selectedVariables.length > 0 && <div className="mcap-selected-variables">{selectedVariables.map(path => <button key={path} onClick={() => toggleVariable(path)} title={tr('移除','Remove')}>× {path}</button>)}</div>}<div className="mcap-variable-list">{variableGroups.map(group => <section className="mcap-variable-category" key={group.category}><header><b>{categoryLabel(group.category)}</b><span>{group.paths.length}</span><button type="button" onClick={() => selectPaths(group.paths)} disabled={group.paths.every(path => selectedVariables.includes(path))}>{tr('选择本类','Select category')}</button></header>{group.paths.map(path => <label key={path}><input type="checkbox" checked={selectedVariables.includes(path)} onChange={() => toggleVariable(path)} /><span>{path}</span></label>)}</section>)}{availableVariables.length === 0 && <span className="mcap-variable-empty">{tr('暂无可选变量。请先打开“实时”属性浏览器并等待遥测属性树加载。','No variables discovered yet. Open the Live property browser and wait for telemetry.')}</span>}{availableVariables.length > 0 && variableGroups.length === 0 && <span className="mcap-variable-empty">{tr('没有匹配的变量。','No matching variables.')}</span>}</div></div><div className="sim-config-readonly">{tr('目录','Directory')}: {config.mcap.directory}<br />{tr('变量数量不再设上限；可记录数量取决于仿真机可用内存和存储空间。压缩：LZ4 Frame；Chunk：1 MiB/最长5秒；CRC：开启；正常关闭后 .active 重命名为 .mcap。','The variable count is unlimited; the practical limit is available simulator memory and storage. Compression: LZ4 Frame; chunk: 1 MiB/maximum 5 seconds; CRC enabled; .active is renamed to .mcap after a clean close.')}</div></section>}
          {tab === '性能与安全' && <section><h3>{tr('性能与安全','Performance & Safety')}</h3><div className="sim-config-grid">
            <NumberField label={tr('CPU核心','CPU core')} value={config.safety.cpuCore} min={0} onChange={(v:any)=>set('safety','cpuCore',v)} /><NumberField label={tr('任务优先级','Task priority')} value={config.safety.taskPriority} min={1} onChange={(v:any)=>set('safety','taskPriority',v)} /><NumberField label={tr('任务栈','Task stack')} value={config.safety.stackKb} min={64} unit="KiB" onChange={(v:any)=>set('safety','stackKb',v)} />
            <NumberField label={tr('FDM超时阈值','FDM timeout')} value={config.safety.fdmTimeoutMs} step={0.1} unit="ms" onChange={(v:any)=>set('safety','fdmTimeoutMs',v)} /><NumberField label={tr('CPU告警','CPU warning')} value={config.safety.cpuWarningPercent} unit="%" onChange={(v:any)=>set('safety','cpuWarningPercent',v)} /><NumberField label={tr('RAM告警','RAM warning')} value={config.safety.ramWarningPercent} unit="%" onChange={(v:any)=>set('safety','ramWarningPercent',v)} />
            <label className="sim-config-check"><input type="checkbox" checked={config.safety.nanCheck} onChange={e=>set('safety','nanCheck',e.target.checked)} />{tr('NaN/Inf检测','NaN/Inf detection')}</label><SelectField label={tr('异常处理','Fault action')} value={config.safety.faultAction} onChange={(v:any)=>set('safety','faultAction',v)}><option value="stop">{tr('停止仿真','Stop simulation')}</option><option value="pause">{tr('暂停','Pause')}</option><option value="restart">{tr('重新加载','Reload')}</option></SelectField>
          </div></section>}
        </main>
      </div>
      <footer><span>{status}</span><div><button onClick={()=>setConfig(defaults)}>{tr('恢复默认值','Restore Defaults')}</button><button className="primary" disabled={saving || serialized === baseline} onClick={()=>void save()}>{saving?tr('保存中…','Saving…'):tr('保存到仿真机','Save to Simulator')}</button></div></footer>
    </div>
  </div>;
}
