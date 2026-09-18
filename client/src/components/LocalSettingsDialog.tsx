import { useState } from 'react';
import { type Language, useLanguage } from '../i18n';
import {
  getSimulatorTransportMode,
  isRemoteUploadEnabled,
  setRemoteUploadEnabled,
  setSimulatorTransportMode,
  type SimulatorTransportMode,
} from '../utils/tauriApi';

export default function LocalSettingsDialog({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, isZh } = useLanguage();
  const [remoteUpload, setRemoteUpload] = useState(() => isRemoteUploadEnabled());
  const [transportMode, setTransportMode] = useState<SimulatorTransportMode>(() => getSimulatorTransportMode());
  const [transportError, setTransportError] = useState('');
  const [timeThreshold, setTimeThreshold] = useState(() => Number(localStorage.getItem('jsbsim-time-sync-threshold-secs') || 60));
  const [logDirectory, setLogDirectory] = useState(() => localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs');
  const saveRemoteUpload = (value: boolean) => {
    setRemoteUpload(value); setRemoteUploadEnabled(value);
  };
  const saveTransportMode = async (value: SimulatorTransportMode) => {
    const previous = transportMode;
    setTransportMode(value);
    setTransportError('');
    try {
      await setSimulatorTransportMode(value);
      window.dispatchEvent(new Event('jsbsim-local-settings-changed'));
    } catch (error: any) {
      setTransportMode(previous);
      setTransportError(error?.message || String(error));
    }
  };
  const saveTimeThreshold = (value: number) => {
    const next = Math.max(1, Math.min(86400, Number.isFinite(value) ? value : 60));
    setTimeThreshold(next); localStorage.setItem('jsbsim-time-sync-threshold-secs', String(next));
    window.dispatchEvent(new Event('jsbsim-local-settings-changed'));
  };
  const saveLogDirectory = (value: string) => {
    setLogDirectory(value); localStorage.setItem('jsbsim-log-download-directory', value.trim() || '~/Downloads/JSBSim-Logs');
  };
  return <div className="local-settings-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="local-settings-dialog" role="dialog" aria-modal="true" aria-label={isZh ? '本地配置' : 'Local Settings'}>
      <header><div><b>⚙ {isZh ? '本地配置' : 'Local Settings'}</b><span>{isZh ? '仅保存在当前上位机' : 'Stored on this computer only'}</span></div><button onClick={onClose}>×</button></header>
      <section>
        <div className="local-settings-row">
          <div><b>{isZh ? '界面语言' : 'Interface Language'}</b><small>{isZh ? '切换后立即生效，重启后保持' : 'Applies immediately and persists after restart'}</small></div>
          <select value={language} onChange={event => setLanguage(event.target.value as Language)}>
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '仿真机通讯' : 'Simulator communication'}</b><small>{isZh ? '网络使用 UDP/FTP；自动模式在 USB 异常时继续使用网络' : 'Network uses UDP/FTP; Auto keeps network fallback available'}</small>{transportError && <small>{transportError}</small>}</div>
          <select value={transportMode} onChange={event => void saveTransportMode(event.target.value as SimulatorTransportMode)}>
            <option value="auto">{isZh ? '自动' : 'Auto'}</option>
            <option value="network">{isZh ? '网络' : 'Network'}</option>
            <option value="usb">USB</option>
          </select>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '允许写入仿真机模型' : 'Allow writing simulator models'}</b><small>{isZh ? '关闭时「保存到仿真机」只提示不写入；开启后会真实覆盖 NuttX SD 卡上的模型' : 'When off, save-to-simulator only reports. When on, it really overwrites models on the NuttX SD card'}</small></div>
          <label className="local-settings-toggle"><input type="checkbox" checked={remoteUpload} onChange={event => saveRemoteUpload(event.target.checked)} /><span>{remoteUpload ? (isZh ? '已开启' : 'On') : (isZh ? '已关闭' : 'Off')}</span></label>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '仿真机校时阈值' : 'Simulator clock threshold'}</b><small>{isZh ? '上位机每 15 秒检查；偏差超过阈值才自动同步' : 'Checked every 15 seconds; synchronize only above this difference'}</small></div>
          <label className="local-settings-number"><input type="number" min="1" max="86400" value={timeThreshold} onChange={event => saveTimeThreshold(Number(event.target.value))} /><span>s</span></label>
        </div>
        <div className="local-settings-path">
          <b>{isZh ? '日志下载目录' : 'Log download directory'}</b>
          <small>{isZh ? '仅允许当前用户主目录内的绝对路径，支持 ~/' : 'Absolute path inside the current user home directory; ~/ is supported'}</small>
          <input value={logDirectory} placeholder="~/Downloads/JSBSim-Logs" onChange={event => saveLogDirectory(event.target.value)} />
        </div>
      </section>
      <footer><button className="primary" onClick={onClose}>{isZh ? '完成' : 'Done'}</button></footer>
    </div>
  </div>;
}
