import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n';
import { getLocalSimulator, saveLocalSimulator, type LocalSimulatorConfig, type LocalSimulatorStatus } from '../utils/tauriApi';

export default function LocalSimulationSettings({ onActiveChange }: { onActiveChange: (active: boolean) => void }) {
  const { isZh } = useLanguage();
  const [status, setStatus] = useState<LocalSimulatorStatus>();
  const [draft, setDraft] = useState<LocalSimulatorConfig>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const initialized = useRef(false), saving = useRef(false), mounted = useRef(true), epoch = useRef(0);
  useEffect(() => {
    mounted.current = true; let polling = false;
    const refresh = async () => {
      if (polling || saving.current) return;
      const request = epoch.current;
      polling = true;
      try {
        const result = await getLocalSimulator();
        if (!mounted.current || saving.current || request !== epoch.current) return;
        setLoadError('');
        setStatus(result); onActiveChange(result.active);
        if (!initialized.current) { setDraft(result.config); initialized.current = true; }
      } catch (e) { if (mounted.current && request === epoch.current) setLoadError(String(e)); }
      finally { polling = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [onActiveChange]);
  const save = async (next = draft) => {
    if (!next || saving.current) return;
    saving.current = true; epoch.current++; setBusy(true); setError('');
    try {
      const result = await saveLocalSimulator(next);
      if (mounted.current) { setStatus(result); setDraft(result.config); onActiveChange(result.active); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const bundled = !!draft?.bundled;
  const presetEnabled = !!status?.config.enabled && !!status?.config.bundled;
  return <div className="local-simulation-settings">
    <div className="local-settings-row">
      <div><b>{isZh ? '电脑端模型仿真' : 'Run models on this computer'}</b><small>{isZh ? '由上位机管理本机 JSBSim、模型库和日志；保存后重启生效。' : 'Manage local JSBSim, models and logs. Restart the app after saving.'}</small></div>
      <label className="local-settings-toggle"><input aria-label={isZh ? '启用电脑端模型仿真' : 'Enable local simulation'} type="checkbox" disabled={!draft || busy} checked={draft?.enabled || false} onChange={e => setDraft(c => c && ({ ...c, enabled: e.target.checked }))}/><span>{draft?.enabled ? (isZh ? '已开启' : 'On') : (isZh ? '已关闭' : 'Off')}</span></label>
    </div>
    {draft && <>
      <div className="local-simulation-preset">
        <div><b>{isZh ? '内置 F450 四旋翼仿真' : 'Built-in F450 quadrotor simulation'}</b><small>{isZh ? '自带模型和软件飞控，自动连接并加载模型。无需选择目录；不会自动解锁或起飞。' : 'Includes the model and flight controller; loads and connects automatically. Does not arm or take off.'}</small></div>
        <button aria-label="启用内置仿真" disabled={busy || !status?.builtin?.available || presetEnabled} onClick={() => void save({ ...draft, bundled: true, enabled: true })}>{presetEnabled ? (isZh ? '内置仿真已启用' : 'Built-in simulation enabled') : (isZh ? '启用内置仿真' : 'Enable built-in simulation')}</button>
        {!status?.builtin?.available && <small>{status?.builtin?.error || (isZh ? '当前安装包未提供内置组件，可使用下方自定义运行程序。' : 'This installation has no bundled runtime; configure a custom runtime below.')}</small>}
      </div>
      <label className="local-settings-path">{isZh ? '运行方式' : 'Runtime source'}<select aria-label="本机仿真运行方式" value={bundled ? 'bundled' : 'custom'} disabled={busy} onChange={e => setDraft({ ...draft, bundled: e.target.value === 'bundled' })}><option value="bundled">{isZh ? '内置预设 · 无需设置' : 'Built-in preset · no setup'}</option><option value="custom">{isZh ? '自定义 · 目录与连接参数' : 'Custom directories and connection'}</option></select></label>
      {bundled && <p className="local-simulation-preset-note">{isZh ? '启用后重新打开上位机，自动启动 F450 模型和软件飞控。自定义设置会保留，可随时切换。' : 'Reopen the app after enabling to start the model and controller. Custom settings are retained.'}</p>}
      {!bundled && <details open={draft.enabled || status?.active}>
        <summary>{isZh ? '本机运行配置' : 'Local runtime settings'}</summary>
        <fieldset disabled={busy}>
          <label className="local-settings-path">{isZh ? 'JSBSim 工程目录' : 'JSBSim project directory'}<input aria-label="JSBSim project directory" value={draft.projectDirectory} onChange={e => setDraft({ ...draft, projectDirectory: e.target.value })}/></label>
          <label className="local-settings-path">{isZh ? 'PC 构建目录' : 'PC build directory'}<input aria-label="PC build directory" value={draft.buildDirectory} onChange={e => setDraft({ ...draft, buildDirectory: e.target.value })}/></label>
          <label className="local-settings-path">{isZh ? '飞控 HIL 目标 IPv4' : 'Flight controller HIL IPv4'}<input aria-label="Local simulator HIL host" value={draft.hilHost} onChange={e => setDraft({ ...draft, hilHost: e.target.value })}/></label>
          <label className="local-settings-path">{isZh ? '飞控 HIL 接收端口' : 'Flight controller HIL receive port'}<input aria-label="Local simulator HIL port" type="number" min="1" max="65535" value={draft.hilPort} onChange={e => setDraft({ ...draft, hilPort: e.target.valueAsNumber })}/></label>
        </fieldset>
        <small>{isZh ? '同机 PX4：飞控监听 14561，模型接收执行器 14560。也可填写外部飞控地址。' : 'Local PX4 listens on 14561; model actuator input is 14560. External flight controller addresses are supported.'}</small>
      </details>}
      <button className="local-simulation-save" disabled={busy || JSON.stringify(draft) === JSON.stringify(status?.config)} onClick={() => void save()}>{busy ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存本机仿真配置' : 'Save local simulation settings')}</button>
    </>}
    {status && <p role="status">{status.active ? (status.ready ? (isZh ? '本机模型服务已就绪' : 'Local model service ready') : status.running ? (isZh ? '本机模型服务正在启动…' : 'Starting local model service…') : (isZh ? '本机模型服务未运行' : 'Local model service stopped')) : (isZh ? '当前连接：外部仿真机' : 'Current target: external simulator')}{status.restartRequired && <strong> · {isZh ? '配置已保存，请退出并重新打开上位机' : 'Saved. Quit and reopen the app to apply.'}</strong>}</p>}
    {(error || loadError || status?.error) && <p role="alert">{error || loadError || status?.error}</p>}
    {!!status?.logs.length && <details><summary>{isZh ? '本机服务日志' : 'Local service logs'}</summary><pre aria-label="Local simulator logs">{status.logs.join('\n')}</pre></details>}
  </div>;
}
