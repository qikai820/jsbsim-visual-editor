import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MovingPlatformPreview from './components/MovingPlatformPreview';

function Preview() {
  const [params, setParams] = useState<Record<string, number>>({ 'moving-platform/contact-mode': 2, 'scenario/mode': 3 });
  const change = (key: string, value: number) => setParams(p => ({ ...p, [key]: value }));
  return <main style={{ maxWidth: 1400, margin: 'auto', padding: '28px 32px', color: '#e0edf1', fontFamily: 'system-ui,sans-serif' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'end' }}>
      <div><div style={{ letterSpacing: 3, color: '#70bbc0', fontSize: 12 }}>JSBSIM · MOVING PLATFORM</div><h1 style={{ fontSize: 30, margin: '10px 0' }}>移动平台工作船</h1><p style={{ margin: 0, color: '#a7bec9' }}>下载船体 + 参数化起降甲板 + 双杆导向</p></div>
      <span style={{ border: '1px solid #49666c', borderRadius: 20, padding: '7px 14px', fontSize: 12 }}>离线 GLB · Kenney / CC0</span>
    </header>
    <MovingPlatformPreview params={params} large />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 14, alignItems: 'center' }}>
      <label>接触显示 <select value={params['moving-platform/contact-mode']} onChange={e => change('moving-platform/contact-mode', Number(e.target.value))}><option value="0">甲板</option><option value="1">双杆</option><option value="2">甲板与双杆</option></select></label>
      <label>场景 <select value={params['scenario/mode']} onChange={e => change('scenario/mode', Number(e.target.value))}><option value="0">静止</option><option value="2">3 m/s 轻晃</option><option value="3">5 m/s 强晃</option></select></label>
      {([['moving-platform/deck-length-m', '甲板长', 4], ['moving-platform/deck-width-m', '甲板宽', 3], ['guide-rail/length-m', '杆长', 1.5]] as const).map(([key, label, value]) => <label key={key}> {label} <input type="number" min="0.1" step="0.1" aria-label={label} value={params[key] ?? value} onChange={e => { if (Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber > 0) change(key, e.target.valueAsNumber); }} style={{ width: 60 }} /> m</label>)}
      <a href="/scenery/moving-platform/moving-platform.glb" download style={{ color: '#85d7d1' }}>下载完整视景 GLB</a>
      <a href="/scenery/moving-platform/vessel.glb" download style={{ color: '#85d7d1' }}>原始船体</a>
      <a href="https://kenney.nl/assets/watercraft-kit" style={{ color: '#85d7d1' }}>原始资源与许可 ↗</a>
    </div>
    <p style={{ fontSize: 12, color: '#8ca7b5', marginTop: 20 }}>本页为模型与摇摆预览。真实视景由 moving-platform 模块遥测驱动；船体和标线仅用于显示，接触范围由甲板与双杆参数决定。</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
