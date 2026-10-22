import { useEffect, useState } from 'react';
import { type Language, useLanguage } from '../i18n';
import type { ToolbarAppearance } from '../utils/toolbarAppearance';
import { MAX_PERFORMANCE_PERIOD_SECONDS, MIN_PERFORMANCE_PERIOD_SECONDS, readPerformancePeriod, savePerformancePeriod } from '../utils/performanceSettings';
import { readDisplayScale, saveDisplayScale, type DisplayScaleSetting } from '../utils/displayScale';
import {
  getSimulatorTransportMode,
  getSimulatorNetworkTarget,
  isRemoteUploadEnabled,
  setRemoteUploadEnabled,
  setSimulatorTransportMode,
  type SimulatorTransportMode,
} from '../utils/tauriApi';

interface LocalSettingsDialogProps {
  onClose: () => void;
  toolbarAppearance: ToolbarAppearance;
  onToolbarAppearanceChange: (appearance: ToolbarAppearance) => void;
}

export default function LocalSettingsDialog({ onClose, toolbarAppearance, onToolbarAppearanceChange }: LocalSettingsDialogProps) {
  const { language, setLanguage, isZh } = useLanguage();
  const [displayScale, setDisplayScale] = useState<DisplayScaleSetting>(readDisplayScale);
  const [remoteUpload, setRemoteUpload] = useState(() => isRemoteUploadEnabled());
  const [transportMode, setTransportMode] = useState<SimulatorTransportMode>(() => getSimulatorTransportMode());
  const [transportError, setTransportError] = useState('');
  const [networkTarget, setNetworkTarget] = useState<string | null>(null);
  useEffect(() => {
    if (transportMode === 'usb') return;
    let active = true;
    const refresh = () => { void getSimulatorNetworkTarget()
      .then(target => { if (active) setNetworkTarget(target); })
      .catch(() => { if (active) setNetworkTarget(null); }); };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [transportMode]);
  const [timeThreshold, setTimeThreshold] = useState(() => Number(localStorage.getItem('jsbsim-time-sync-threshold-secs') || 60));
  const [performancePeriod, setPerformancePeriod] = useState(readPerformancePeriod);
  const [logDirectory, setLogDirectory] = useState(() => localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs');
  const [usbDownloadDirectory, setUsbDownloadDirectory] = useState(() => localStorage.getItem('jsbsim-usb-download-directory') || '~/Downloads/JSBSim-Files');
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
  const savePerformancePeriodSetting = (value: number) => {
    const next = savePerformancePeriod(value);
    setPerformancePeriod(next);
    window.dispatchEvent(new Event('jsbsim-local-settings-changed'));
  };
  const saveLogDirectory = (value: string) => {
    setLogDirectory(value); localStorage.setItem('jsbsim-log-download-directory', value.trim() || '~/Downloads/JSBSim-Logs');
  };
  const saveUsbDownloadDirectory = (value: string) => {
    setUsbDownloadDirectory(value); localStorage.setItem('jsbsim-usb-download-directory', value.trim() || '~/Downloads/JSBSim-Files');
  };
  return <div className="local-settings-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="local-settings-dialog" role="dialog" aria-label={isZh ? '本地配置' : 'Local Settings'}>
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
          <div><b>{isZh ? '界面大小' : 'Interface Size'}</b><small>{isZh ? '自动适应窗口和屏幕缩放；Ctrl+0 恢复自动' : 'Auto fits the window and display; Ctrl+0 restores Auto'}</small></div>
          <select value={displayScale} aria-label={isZh ? '界面大小' : 'Interface Size'} onChange={event => {
            const setting = event.target.value === 'auto' ? 'auto' : Number(event.target.value);
            setDisplayScale(setting); saveDisplayScale(setting);
          }}>
            <option value="auto">{isZh ? '自动适应' : 'Auto'}</option>
            {[75, 80, 90, 100, 110, 125, 150, 175, 200].map(percent =>
              <option key={percent} value={percent / 100}>{percent}%</option>)}
          </select>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '状态菜单栏颜色' : 'Status menu bar color'}</b><small>{isZh ? '仅调整顶部菜单栏背景' : 'Changes the top menu bar background only'}</small></div>
          <label className="local-settings-color">
            <input type="color" value={toolbarAppearance.color} aria-label={isZh ? '状态菜单栏颜色' : 'Status menu bar color'} onChange={event => onToolbarAppearanceChange({ ...toolbarAppearance, color: event.target.value })} />
            <span>{toolbarAppearance.color.toUpperCase()}</span>
          </label>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '状态菜单栏透明度' : 'Status menu bar transparency'}</b><small>{isZh ? '0% 不透明，100% 完全透明；调整后立即生效' : '0% opaque, 100% transparent; applies immediately'}</small></div>
          <label className="local-settings-opacity">
            <input type="range" min="0" max="100" step="1" value={toolbarAppearance.transparency} aria-label={isZh ? '状态菜单栏透明度' : 'Status menu bar transparency'} onChange={event => onToolbarAppearanceChange({ ...toolbarAppearance, transparency: Number(event.target.value) })} />
            <span>{toolbarAppearance.transparency}%</span>
          </label>
        </div>
        <div className="local-settings-row">
          <div><b>{isZh ? '仿真机通讯' : 'Simulator communication'}</b><small>{isZh ? '网络使用 UDP/FTP；自动模式在 USB 异常时继续使用网络' : 'Network uses UDP/FTP; Auto keeps network fallback available'}</small>{transportMode !== 'usb' && <small>{networkTarget ? (isZh ? `已发现仿真机 IP：${networkTarget}` : `Discovered simulator IP: ${networkTarget}`) : (isZh ? '正在自动发现网口仿真机…' : 'Discovering network simulator…')}</small>}{transportError && <small>{transportError}</small>}</div>
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
        <div className="local-settings-row">
          <div><b>{isZh ? '性能曲线周期' : 'Performance chart period'}</b><small>{isZh ? '×1 到 ×4 时间范围的基础周期' : 'Base period for the ×1 to ×4 chart ranges'}</small></div>
          <label className="local-settings-number"><input type="number" min={MIN_PERFORMANCE_PERIOD_SECONDS} max={MAX_PERFORMANCE_PERIOD_SECONDS} step="1" value={performancePeriod} onChange={event => savePerformancePeriodSetting(Number(event.target.value))} /><span>s</span></label>
        </div>
        <div className="local-settings-path">
          <b>{isZh ? '日志下载目录' : 'Log download directory'}</b>
          <small>{isZh ? '仅允许当前用户主目录内的绝对路径，支持 ~/' : 'Absolute path inside the current user home directory; ~/ is supported'}</small>
          <input value={logDirectory} placeholder="~/Downloads/JSBSim-Logs" onChange={event => saveLogDirectory(event.target.value)} />
        </div>
        <div className="local-settings-path">
          <b>{isZh ? 'USB 文件下载目录' : 'USB file download directory'}</b>
          <small>{isZh ? '文件管理器下载到这里，支持 ~/' : 'Files downloaded from Simulator Files are saved here; ~/ is supported'}</small>
          <input value={usbDownloadDirectory} placeholder="~/Downloads/JSBSim-Files" onChange={event => saveUsbDownloadDirectory(event.target.value)} />
        </div>
      </section>
      <footer><button className="primary" onClick={onClose}>{isZh ? '完成' : 'Done'}</button></footer>
    </div>
  </div>;
}
