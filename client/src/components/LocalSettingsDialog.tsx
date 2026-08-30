import { useState } from 'react';
import { type Language, useLanguage } from '../i18n';

export default function LocalSettingsDialog({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, isZh } = useLanguage();
  const [timeThreshold, setTimeThreshold] = useState(() => Number(localStorage.getItem('jsbsim-time-sync-threshold-secs') || 60));
  const [logDirectory, setLogDirectory] = useState(() => localStorage.getItem('jsbsim-log-download-directory') || '~/Downloads/JSBSim-Logs');
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
