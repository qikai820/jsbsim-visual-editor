import { useState, useCallback } from 'react';
import { generateAircraft } from '../utils/tauriApi';

type AircraftType = 'fixed_wing' | 'multirotor' | 'helicopter';
type UnitSystem = 'IMPERIAL' | 'METRIC';

interface WizardData {
  // Step 1: Type
  aircraftType: AircraftType;
  unitSystem: UnitSystem;
  // Step 2: Basic Info
  name: string;
  version: string;
  release: string;
  author: string;
  description: string;
  // Step 3: Metrics
  wingarea: number;
  wingspan: number;
  chord: number;
  htailarea: number;
  htailarm: number;
  vtailarea: number;
  vtailarm: number;
  wingIncidence: number;
  aerorp: { x: number; y: number; z: number };
  eyepoint: { x: number; y: number; z: number };
  vrp: { x: number; y: number; z: number };
  // Step 4: Mass
  emptywt: number;
  ixx: number;
  iyy: number;
  izz: number;
  ixz: number;
  cg: { x: number; y: number; z: number };
  pointmasses: { name: string; weight: number; x: number; y: number; z: number }[];
  // Step 5: Ground
  contacts: {
    name: string; type: string;
    x: number; y: number; z: number;
    spring: number; damping: number;
    staticFriction: number; dynamicFriction: number; rollingFriction: number;
    maxSteer: number; brakeGroup: string; retractable: boolean;
  }[];
  // Step 6: Propulsion
  engines: {
    name: string; file: string; type: string;
    thrusterFile: string; sense: number; pFactor: number;
    x: number; y: number; z: number;
    pitch: number; yaw: number;
    feed: number[];
  }[];
  tanks: {
    name: string; type: string; number: number;
    x: number; y: number; z: number;
    radius: number; capacity: number; contents: number;
  }[];
  // Step 7: Flight Control
  useAutoFCS: boolean;
  // Step 8: Aero
  useAutoAero: boolean;
  // Step 9: Systems
  sensors: { imu: boolean; baro: boolean; gps: boolean };
  effectors: boolean;
  // Step 10: Output
  outputName: string;
  outputType: string;
  outputRate: number;
}

const STEPS = [
  { key: 'type', label: '类型', icon: '✈️' },
  { key: 'basic', label: '基本信息', icon: '📝' },
  { key: 'metrics', label: '几何参数', icon: '📐' },
  { key: 'mass', label: '质量惯量', icon: '⚖️' },
  { key: 'ground', label: '起落装置', icon: '🛞' },
  { key: 'propulsion', label: '动力系统', icon: '⚙️' },
  { key: 'fcs', label: '飞控系统', icon: '🎮' },
  { key: 'aero', label: '气动系数', icon: '🌊' },
  { key: 'systems', label: '传感器', icon: '📡' },
  { key: 'output', label: '输出配置', icon: '📤' },
  { key: 'preview', label: '预览生成', icon: '✅' },
];

// Presets for common aircraft
const PRESETS: Record<AircraftType, Partial<WizardData>> = {
  fixed_wing: {
    wingarea: 174, wingspan: 36, chord: 4.9,
    htailarea: 21.9, htailarm: 15.7, vtailarea: 16.5, vtailarm: 15.7,
    wingIncidence: 0,
    aerorp: { x: 43.2, y: 0, z: 59.4 },
    eyepoint: { x: 37, y: 0, z: 48 },
    vrp: { x: 42.6, y: 0, z: 38.5 },
    emptywt: 1454, ixx: 948, iyy: 1346, izz: 1967, ixz: 0,
    cg: { x: 41, y: 0, z: 36.5 },
    unitSystem: 'IMPERIAL',
  },
  multirotor: {
    wingarea: 0.016, wingspan: 0.127, chord: 0.127,
    htailarea: 0, htailarm: 0, vtailarea: 0, vtailarm: 0,
    wingIncidence: 0,
    aerorp: { x: 0, y: 0, z: 0 },
    eyepoint: { x: 0, y: 0, z: 0 },
    vrp: { x: 0, y: 0, z: 0 },
    emptywt: 1.3, ixx: 0.015, iyy: 0.015, izz: 0.025, ixz: 0,
    cg: { x: 0, y: 0, z: 0 },
    unitSystem: 'METRIC',
  },
  helicopter: {
    wingarea: 16.6, wingspan: 10.75, chord: 1.54,
    htailarea: 12, htailarm: 16.5, vtailarea: 17.85, vtailarm: 25,
    wingIncidence: 8.5,
    aerorp: { x: 176, y: 0, z: 55 },
    eyepoint: { x: 120, y: 0, z: 70 },
    vrp: { x: 176, y: 0, z: 55 },
    emptywt: 5000, ixx: 2000, iyy: 5000, izz: 4500, ixz: 0,
    cg: { x: 160, y: 0, z: 50 },
    unitSystem: 'IMPERIAL',
  },
};

const TYPE_INFO: Record<AircraftType, { label: string; icon: string; desc: string }> = {
  fixed_wing: { label: '固定翼', icon: '🛩️', desc: '传统固定翼飞机，使用机翼产生升力' },
  multirotor: { label: '多旋翼', icon: '🚁', desc: '多旋翼无人机，通过电机差速控制姿态' },
  helicopter: { label: '直升机', icon: '🚀', desc: '单旋翼直升机，使用主旋翼和尾旋翼' },
};

function getDefaultData(): WizardData {
  return {
    aircraftType: 'fixed_wing',
    unitSystem: 'IMPERIAL',
    name: 'New Aircraft',
    version: '2.0',
    release: 'BETA',
    author: '',
    description: '',
    wingarea: 0, wingspan: 0, chord: 0,
    htailarea: 0, htailarm: 0, vtailarea: 0, vtailarm: 0,
    wingIncidence: 0,
    aerorp: { x: 0, y: 0, z: 0 },
    eyepoint: { x: 0, y: 0, z: 0 },
    vrp: { x: 0, y: 0, z: 0 },
    emptywt: 0, ixx: 0, iyy: 0, izz: 0, ixz: 0,
    cg: { x: 0, y: 0, z: 0 },
    pointmasses: [],
    contacts: [],
    engines: [],
    tanks: [],
    useAutoFCS: true,
    useAutoAero: true,
    sensors: { imu: true, baro: true, gps: true },
    effectors: true,
    outputName: 'localhost',
    outputType: 'SOCKET',
    outputRate: 60,
  };
}

interface Props {
  onClose: () => void;
  onGenerate: (xml: string) => void;
}

export default function AircraftWizard({ onClose, onGenerate }: Props) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(getDefaultData());
  const [generating, setGenerating] = useState(false);
  const [previewXml, setPreviewXml] = useState('');

  const update = useCallback((patch: Partial<WizardData>) => {
    setData(prev => ({ ...prev, ...patch }));
  }, []);

  const applyPreset = (type: AircraftType) => {
    const preset = PRESETS[type];
    const def = getDefaultData();
    setData({ ...def, ...preset, aircraftType: type, name: def.name });

    // Auto-generate default contacts and engines based on type
    if (type === 'fixed_wing') {
      setData(prev => ({
        ...prev, ...preset, aircraftType: type,
        contacts: [
          { name: 'NOSE', type: 'BOGEY', x: 30, y: 0, z: -20, spring: 1200, damping: 60, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.02, maxSteer: 10, brakeGroup: 'NONE', retractable: false },
          { name: 'LMAIN', type: 'BOGEY', x: 45, y: -30, z: -20, spring: 1800, damping: 90, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.02, maxSteer: 0, brakeGroup: 'LEFT', retractable: false },
          { name: 'RMAIN', type: 'BOGEY', x: 45, y: 30, z: -20, spring: 1800, damping: 90, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.02, maxSteer: 0, brakeGroup: 'RIGHT', retractable: false },
        ],
        engines: [
          { name: 'Main Engine', file: 'eng_io320', type: 'piston', thrusterFile: 'prop_75in2f', sense: 1, pFactor: 10, x: -37, y: 0, z: 26, pitch: 0, yaw: 0, feed: [0, 1] },
        ],
        tanks: [
          { name: 'Fuel Tank 0', type: 'FUEL', number: 0, x: 43, y: -20, z: 36, radius: 5, capacity: 165, contents: 165 },
          { name: 'Fuel Tank 1', type: 'FUEL', number: 1, x: 43, y: 20, z: 36, radius: 5, capacity: 165, contents: 165 },
        ],
      }));
    } else if (type === 'multirotor') {
      const armLen = 0.3;
      setData(prev => ({
        ...prev, ...preset, aircraftType: type,
        contacts: [
          { name: 'Front', type: 'BOGEY', x: armLen, y: 0, z: -0.05, spring: 500, damping: 25, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.5, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
          { name: 'RearL', type: 'BOGEY', x: -armLen, y: -armLen, z: -0.05, spring: 500, damping: 25, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.5, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
          { name: 'RearR', type: 'BOGEY', x: -armLen, y: armLen, z: -0.05, spring: 500, damping: 25, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.5, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
        ],
        engines: [
          { name: 'front right', file: 'DJI_E305', type: 'brushless_dc', thrusterFile: 'DJI_9450', sense: -1, pFactor: 0, x: 0, y: 0.16, z: 0, pitch: 90, yaw: 0, feed: [] },
          { name: 'aft left', file: 'DJI_E305', type: 'brushless_dc', thrusterFile: 'DJI_9450', sense: -1, pFactor: 0, x: -0.16, y: -0.16, z: 0, pitch: 90, yaw: 0, feed: [] },
          { name: 'front left', file: 'DJI_E305', type: 'brushless_dc', thrusterFile: 'DJI_9450', sense: 1, pFactor: 0, x: 0, y: -0.16, z: 0, pitch: 90, yaw: 0, feed: [] },
          { name: 'aft right', file: 'DJI_E305', type: 'brushless_dc', thrusterFile: 'DJI_9450', sense: 1, pFactor: 0, x: -0.16, y: 0.16, z: 0, pitch: 90, yaw: 0, feed: [] },
        ],
        tanks: [],
      }));
    } else {
      setData(prev => ({
        ...prev, ...preset, aircraftType: type,
        contacts: [
          { name: 'L_SKID_FRONT', type: 'BOGEY', x: 120, y: -12, z: -10, spring: 2000, damping: 100, staticFriction: 0.65, dynamicFriction: 0.5, rollingFriction: 0.65, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
          { name: 'R_SKID_FRONT', type: 'BOGEY', x: 120, y: 12, z: -10, spring: 2000, damping: 100, staticFriction: 0.65, dynamicFriction: 0.5, rollingFriction: 0.65, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
          { name: 'L_SKID_REAR', type: 'BOGEY', x: 200, y: -12, z: -10, spring: 2000, damping: 100, staticFriction: 0.65, dynamicFriction: 0.5, rollingFriction: 0.65, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
          { name: 'R_SKID_REAR', type: 'BOGEY', x: 200, y: 12, z: -10, spring: 2000, damping: 100, staticFriction: 0.65, dynamicFriction: 0.5, rollingFriction: 0.65, maxSteer: 0, brakeGroup: 'NONE', retractable: false },
        ],
        engines: [
          { name: 'Main Engine', file: 'electric_1mw', type: 'turbine', thrusterFile: '', sense: 1, pFactor: 0, x: 100, y: 0, z: 60, pitch: 90, yaw: 0, feed: [0] },
          { name: 'Tail Rotor', file: 'electric147kW', type: 'electric', thrusterFile: '', sense: 1, pFactor: 0, x: 320, y: 0, z: 30, pitch: 0, yaw: 90, feed: [] },
        ],
        tanks: [
          { name: 'Fuel Tank', type: 'FUEL', number: 0, x: 150, y: 0, z: 40, radius: 8, capacity: 500, contents: 0 },
        ],
      }));
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const xml = await generateAircraft(data);
      setPreviewXml(xml);
    } catch (err: any) {
      alert('生成失败: ' + err.message);
    }
    setGenerating(false);
  };

  const canNext = () => {
    if (step === 0) return !!data.aircraftType;
    if (step === 1) return data.name.trim().length > 0;
    return true;
  };

  const isLastStep = step === STEPS.length - 1;
  const isPreviewStep = step === STEPS.length - 1;

  // ── Step Renderers ───────────────────────────────────────────────────────

  const renderTypeStep = () => (
    <div className="wizard-step">
      <h3>选择飞机类型</h3>
      <div className="wizard-type-grid">
        {(Object.entries(TYPE_INFO) as [AircraftType, typeof TYPE_INFO[AircraftType]][]).map(([type, info]) => (
          <div
            key={type}
            className={`wizard-type-card ${data.aircraftType === type ? 'active' : ''}`}
            onClick={() => applyPreset(type)}
          >
            <span className="wizard-type-icon">{info.icon}</span>
            <span className="wizard-type-label">{info.label}</span>
            <span className="wizard-type-desc">{info.desc}</span>
          </div>
        ))}
      </div>
      <div className="wizard-field" style={{ marginTop: 16 }}>
        <label>单位制</label>
        <select value={data.unitSystem} onChange={e => update({ unitSystem: e.target.value as UnitSystem })}>
          <option value="IMPERIAL">英制 (FT, IN, LBS, SLUG)</option>
          <option value="METRIC">公制 (M, CM, KG)</option>
        </select>
      </div>
    </div>
  );

  const renderBasicStep = () => (
    <div className="wizard-step">
      <h3>基本信息</h3>
      <div className="wizard-field"><label>飞机名称 *</label>
        <input type="text" value={data.name} onChange={e => update({ name: e.target.value })} placeholder="如: Cessna 172P" /></div>
      <div className="wizard-field"><label>版本</label>
        <input type="text" value={data.version} onChange={e => update({ version: e.target.value })} /></div>
      <div className="wizard-field"><label>发布阶段</label>
        <select value={data.release} onChange={e => update({ release: e.target.value })}>
          <option value="ALPHA">ALPHA</option>
          <option value="BETA">BETA</option>
          <option value="PRODUCTION">PRODUCTION</option>
        </select></div>
      <div className="wizard-field"><label>作者</label>
        <input type="text" value={data.author} onChange={e => update({ author: e.target.value })} /></div>
      <div className="wizard-field"><label>描述</label>
        <textarea value={data.description} onChange={e => update({ description: e.target.value })} rows={3} /></div>
    </div>
  );

  const renderLocField = (label: string, loc: { x: number; y: number; z: number }, onChange: (l: { x: number; y: number; z: number }) => void) => (
    <div className="wizard-field">
      <label>{label}</label>
      <div className="wizard-loc-row">
        {['X', 'Y', 'Z'].map((axis, i) => (
          <div key={axis} className="wizard-loc-item">
            <span>{axis}</span>
            <input type="number" step="any" value={loc[['x', 'y', 'z'][i] as 'x' | 'y' | 'z']}
              onChange={e => onChange({ ...loc, [['x', 'y', 'z'][i]]: parseFloat(e.target.value) || 0 })} />
          </div>
        ))}
      </div>
    </div>
  );

  const renderMetricsStep = () => {
    const isRotory = data.aircraftType !== 'fixed_wing';
    return (
      <div className="wizard-step">
        <h3>几何参数 Metrics</h3>
        <div className="wizard-grid2">
          <div className="wizard-field"><label>机翼面积 {data.unitSystem === 'IMPERIAL' ? '(FT²)' : '(M²)'}</label>
            <input type="number" step="any" value={data.wingarea} onChange={e => update({ wingarea: parseFloat(e.target.value) || 0 })} /></div>
          <div className="wizard-field"><label>翼展 {data.unitSystem === 'IMPERIAL' ? '(FT)' : '(M)'}</label>
            <input type="number" step="any" value={data.wingspan} onChange={e => update({ wingspan: parseFloat(e.target.value) || 0 })} /></div>
          <div className="wizard-field"><label>弦长 {data.unitSystem === 'IMPERIAL' ? '(FT)' : '(M)'}</label>
            <input type="number" step="any" value={data.chord} onChange={e => update({ chord: parseFloat(e.target.value) || 0 })} /></div>
          {data.aircraftType === 'helicopter' && (
            <div className="wizard-field"><label>机翼安装角 (DEG)</label>
              <input type="number" step="any" value={data.wingIncidence} onChange={e => update({ wingIncidence: parseFloat(e.target.value) || 0 })} /></div>
          )}
        </div>
        {!isRotory && (
          <div className="wizard-grid2">
            <div className="wizard-field"><label>水平尾翼面积</label>
              <input type="number" step="any" value={data.htailarea} onChange={e => update({ htailarea: parseFloat(e.target.value) || 0 })} /></div>
            <div className="wizard-field"><label>水平尾翼力臂</label>
              <input type="number" step="any" value={data.htailarm} onChange={e => update({ htailarm: parseFloat(e.target.value) || 0 })} /></div>
            <div className="wizard-field"><label>垂直尾翼面积</label>
              <input type="number" step="any" value={data.vtailarea} onChange={e => update({ vtailarea: parseFloat(e.target.value) || 0 })} /></div>
            <div className="wizard-field"><label>垂直尾翼力臂</label>
              <input type="number" step="any" value={data.vtailarm} onChange={e => update({ vtailarm: parseFloat(e.target.value) || 0 })} /></div>
          </div>
        )}
        <div className="wizard-section-title">参考点位置</div>
        {renderLocField('气动参考点 (AERORP)', data.aerorp, l => update({ aerorp: l }))}
        {renderLocField('视点位置 (EYEPOINT)', data.eyepoint, l => update({ eyepoint: l }))}
        {renderLocField('虚拟参考点 (VRP)', data.vrp, l => update({ vrp: l }))}
      </div>
    );
  };

  const renderMassStep = () => (
    <div className="wizard-step">
      <h3>质量与惯量 Mass Balance</h3>
      <div className="wizard-grid2">
        <div className="wizard-field"><label>空重 {data.unitSystem === 'IMPERIAL' ? '(LBS)' : '(KG)'}</label>
          <input type="number" step="any" value={data.emptywt} onChange={e => update({ emptywt: parseFloat(e.target.value) || 0 })} /></div>
      </div>
      <div className="wizard-section-title">转动惯量</div>
      <div className="wizard-grid2">
        <div className="wizard-field"><label>Ixx</label>
          <input type="number" step="any" value={data.ixx} onChange={e => update({ ixx: parseFloat(e.target.value) || 0 })} /></div>
        <div className="wizard-field"><label>Iyy</label>
          <input type="number" step="any" value={data.iyy} onChange={e => update({ iyy: parseFloat(e.target.value) || 0 })} /></div>
        <div className="wizard-field"><label>Izz</label>
          <input type="number" step="any" value={data.izz} onChange={e => update({ izz: parseFloat(e.target.value) || 0 })} /></div>
        <div className="wizard-field"><label>Ixz</label>
          <input type="number" step="any" value={data.ixz} onChange={e => update({ ixz: parseFloat(e.target.value) || 0 })} /></div>
      </div>
      {renderLocField('重心位置 (CG)', data.cg, l => update({ cg: l }))}
      <div className="wizard-section-title">
        集中质量 (Point Mass)
        <button className="wizard-add-btn" onClick={() => update({ pointmasses: [...data.pointmasses, { name: `PM${data.pointmasses.length + 1}`, weight: 0, x: 0, y: 0, z: 0 }] })}>+ 添加</button>
      </div>
      {data.pointmasses.map((pm, i) => (
        <div key={i} className="wizard-sub-item">
          <div className="wizard-grid2">
            <div className="wizard-field"><label>名称</label>
              <input type="text" value={pm.name} onChange={e => { const arr = [...data.pointmasses]; arr[i] = { ...arr[i], name: e.target.value }; update({ pointmasses: arr }); }} /></div>
            <div className="wizard-field"><label>重量</label>
              <input type="number" step="any" value={pm.weight} onChange={e => { const arr = [...data.pointmasses]; arr[i] = { ...arr[i], weight: parseFloat(e.target.value) || 0 }; update({ pointmasses: arr }); }} /></div>
          </div>
          {renderLocField('位置', { x: pm.x, y: pm.y, z: pm.z }, l => { const arr = [...data.pointmasses]; arr[i] = { ...arr[i], ...l }; update({ pointmasses: arr }); })}
          <button className="wizard-del-btn" onClick={() => update({ pointmasses: data.pointmasses.filter((_, j) => j !== i) })}>🗑️ 删除</button>
        </div>
      ))}
    </div>
  );

  const renderGroundStep = () => (
    <div className="wizard-step">
      <h3>起落装置 Ground Reactions</h3>
      <p className="wizard-hint">{data.aircraftType === 'helicopter' ? '配置滑橇式起落架' : data.aircraftType === 'multirotor' ? '配置简易支撑点（用于地面配平）' : '配置轮式起落架'}</p>
      <button className="wizard-add-btn" onClick={() => update({ contacts: [...data.contacts, { name: `CONTACT${data.contacts.length + 1}`, type: 'BOGEY', x: 0, y: 0, z: 0, spring: 1000, damping: 50, staticFriction: 0.5, dynamicFriction: 0.4, rollingFriction: 0.02, maxSteer: 0, brakeGroup: 'NONE', retractable: false }] })}>+ 添加接触点</button>
      {data.contacts.map((c, i) => (
        <div key={i} className="wizard-sub-item">
          <div className="wizard-sub-header">
            <input type="text" value={c.name} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], name: e.target.value }; update({ contacts: arr }); }} style={{ fontWeight: 600, flex: 1 }} />
            <select value={c.type} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], type: e.target.value }; update({ contacts: arr }); }}>
              <option value="BOGEY">BOGEY</option>
              <option value="STRUCTURE">STRUCTURE</option>
            </select>
            <button className="wizard-del-btn" onClick={() => update({ contacts: data.contacts.filter((_, j) => j !== i) })}>✕</button>
          </div>
          {renderLocField('位置', { x: c.x, y: c.y, z: c.z }, l => { const arr = [...data.contacts]; arr[i] = { ...arr[i], ...l }; update({ contacts: arr }); })}
          <div className="wizard-grid2">
            <div className="wizard-field"><label>弹簧系数</label>
              <input type="number" step="any" value={c.spring} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], spring: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
            <div className="wizard-field"><label>阻尼系数</label>
              <input type="number" step="any" value={c.damping} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], damping: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
            <div className="wizard-field"><label>静摩擦</label>
              <input type="number" step="any" value={c.staticFriction} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], staticFriction: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
            <div className="wizard-field"><label>动摩擦</label>
              <input type="number" step="any" value={c.dynamicFriction} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], dynamicFriction: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
            <div className="wizard-field"><label>滚动摩擦</label>
              <input type="number" step="any" value={c.rollingFriction} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], rollingFriction: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
            <div className="wizard-field"><label>最大转向角</label>
              <input type="number" step="any" value={c.maxSteer} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], maxSteer: parseFloat(e.target.value) || 0 }; update({ contacts: arr }); }} /></div>
          </div>
          <div className="wizard-grid2">
            <div className="wizard-field"><label>刹车组</label>
              <select value={c.brakeGroup} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], brakeGroup: e.target.value }; update({ contacts: arr }); }}>
                <option value="NONE">NONE</option>
                <option value="LEFT">LEFT</option>
                <option value="RIGHT">RIGHT</option>
                <option value="NOSE">NOSE</option>
                <option value="TAIL">TAIL</option>
              </select></div>
            <div className="wizard-field"><label>可收放</label>
              <select value={c.retractable ? '1' : '0'} onChange={e => { const arr = [...data.contacts]; arr[i] = { ...arr[i], retractable: e.target.value === '1' }; update({ contacts: arr }); }}>
                <option value="0">否</option>
                <option value="1">是</option>
              </select></div>
          </div>
        </div>
      ))}
    </div>
  );

  const renderPropulsionStep = () => (
    <div className="wizard-step">
      <h3>动力系统 Propulsion</h3>
      <div className="wizard-section-title">
        发动机 ({data.engines.length})
        <button className="wizard-add-btn" onClick={() => update({ engines: [...data.engines, { name: `Engine ${data.engines.length + 1}`, file: '', type: 'piston', thrusterFile: '', sense: 1, pFactor: 0, x: 0, y: 0, z: 0, pitch: 0, yaw: 0, feed: [] }] })}>+ 添加</button>
      </div>
      {data.engines.map((eng, i) => (
        <div key={i} className="wizard-sub-item">
          <div className="wizard-sub-header">
            <input type="text" value={eng.name} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], name: e.target.value }; update({ engines: arr }); }} style={{ fontWeight: 600, flex: 1 }} />
            <button className="wizard-del-btn" onClick={() => update({ engines: data.engines.filter((_, j) => j !== i) })}>✕</button>
          </div>
          <div className="wizard-grid2">
            <div className="wizard-field"><label>发动机类型</label>
              <select value={eng.type} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], type: e.target.value }; update({ engines: arr }); }}>
                <option value="piston">活塞</option>
                <option value="turbine">涡轮</option>
                <option value="turboprop">涡桨</option>
                <option value="rocket">火箭</option>
                <option value="electric">电动</option>
                <option value="brushless_dc">无刷直流</option>
              </select></div>
            <div className="wizard-field"><label>发动机文件</label>
              <input type="text" value={eng.file} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], file: e.target.value }; update({ engines: arr }); }} placeholder="如: DJI_E305" /></div>
            <div className="wizard-field"><label>推力器文件</label>
              <input type="text" value={eng.thrusterFile} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], thrusterFile: e.target.value }; update({ engines: arr }); }} placeholder="如: DJI_9450" /></div>
            <div className="wizard-field"><label>旋转方向 (sense)</label>
              <select value={eng.sense} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], sense: parseInt(e.target.value) }; update({ engines: arr }); }}>
                <option value="1">+1 (顺时针)</option>
                <option value="-1">-1 (逆时针)</option>
              </select></div>
          </div>
          {renderLocField('位置', { x: eng.x, y: eng.y, z: eng.z }, l => { const arr = [...data.engines]; arr[i] = { ...arr[i], ...l }; update({ engines: arr }); })}
          <div className="wizard-grid2">
            <div className="wizard-field"><label>Pitch (DEG)</label>
              <input type="number" step="any" value={eng.pitch} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], pitch: parseFloat(e.target.value) || 0 }; update({ engines: arr }); }} /></div>
            <div className="wizard-field"><label>Yaw (DEG)</label>
              <input type="number" step="any" value={eng.yaw} onChange={e => { const arr = [...data.engines]; arr[i] = { ...arr[i], yaw: parseFloat(e.target.value) || 0 }; update({ engines: arr }); }} /></div>
          </div>
        </div>
      ))}
      {data.aircraftType === 'fixed_wing' && (
        <>
          <div className="wizard-section-title">
            油箱 ({data.tanks.length})
            <button className="wizard-add-btn" onClick={() => update({ tanks: [...data.tanks, { name: `Tank ${data.tanks.length}`, type: 'FUEL', number: data.tanks.length, x: 0, y: 0, z: 0, radius: 5, capacity: 100, contents: 100 }] })}>+ 添加</button>
          </div>
          {data.tanks.map((t, i) => (
            <div key={i} className="wizard-sub-item">
              <div className="wizard-sub-header">
                <input type="text" value={t.name} onChange={e => { const arr = [...data.tanks]; arr[i] = { ...arr[i], name: e.target.value }; update({ tanks: arr }); }} style={{ fontWeight: 600, flex: 1 }} />
                <button className="wizard-del-btn" onClick={() => update({ tanks: data.tanks.filter((_, j) => j !== i) })}>✕</button>
              </div>
              <div className="wizard-grid2">
                <div className="wizard-field"><label>容量</label>
                  <input type="number" step="any" value={t.capacity} onChange={e => { const arr = [...data.tanks]; arr[i] = { ...arr[i], capacity: parseFloat(e.target.value) || 0 }; update({ tanks: arr }); }} /></div>
                <div className="wizard-field"><label>当前油量</label>
                  <input type="number" step="any" value={t.contents} onChange={e => { const arr = [...data.tanks]; arr[i] = { ...arr[i], contents: parseFloat(e.target.value) || 0 }; update({ tanks: arr }); }} /></div>
              </div>
              {renderLocField('位置', { x: t.x, y: t.y, z: t.z }, l => { const arr = [...data.tanks]; arr[i] = { ...arr[i], ...l }; update({ tanks: arr }); })}
            </div>
          ))}
        </>
      )}
    </div>
  );

  const renderFCSStep = () => (
    <div className="wizard-step">
      <h3>飞控系统 Flight Control</h3>
      <div className="wizard-field">
        <label>
          <input type="checkbox" checked={data.useAutoFCS} onChange={e => update({ useAutoFCS: e.target.checked })} />
          自动生成飞控系统（根据飞机类型生成默认控制通道）
        </label>
      </div>
      {data.useAutoFCS && (
        <div className="wizard-preview-box">
          <strong>将自动生成以下通道：</strong>
          {data.aircraftType === 'fixed_wing' && (
            <ul>
              <li>Pitch — 升降舵控制</li>
              <li>Roll — 副翼控制</li>
              <li>Yaw — 方向舵控制</li>
              <li>Flaps — 襟翼控制</li>
            </ul>
          )}
          {data.aircraftType === 'multirotor' && (
            <ul>
              <li>Pilot Inputs — 驾驶员输入映射</li>
              <li>Inner Loop Rates — PID 角速率稳定</li>
              <li>Control Mixer — 电机混控输出</li>
            </ul>
          )}
          {data.aircraftType === 'helicopter' && (
            <ul>
              <li>Tailplane — 水平尾翼</li>
              <li>Downwash — 下洗流延迟</li>
              <li>Ground Effect — 地面效应</li>
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const renderAeroStep = () => (
    <div className="wizard-step">
      <h3>气动系数 Aerodynamics</h3>
      <div className="wizard-field">
        <label>
          <input type="checkbox" checked={data.useAutoAero} onChange={e => update({ useAutoAero: e.target.checked })} />
          自动生成气动系数（根据飞机类型生成默认气动模型）
        </label>
      </div>
      {data.useAutoAero && (
        <div className="wizard-preview-box">
          <strong>将自动生成以下轴：</strong>
          <ul>
            <li>LIFT — 升力系数</li>
            <li>DRAG — 阻力系数</li>
            <li>SIDE — 侧力系数</li>
            {data.aircraftType !== 'helicopter' && <li>ROLL — 滚转力矩</li>}
            <li>PITCH — 俯仰力矩</li>
            <li>YAW — 偏航力矩</li>
          </ul>
          {data.aircraftType === 'multirotor' && (
            <p style={{ color: '#888', fontSize: 11, marginTop: 4 }}>※ 多旋翼气动力极小，使用占位系数</p>
          )}
        </div>
      )}
    </div>
  );

  const renderSystemsStep = () => (
    <div className="wizard-step">
      <h3>传感器与系统</h3>
      <div className="wizard-section-title">传感器</div>
      <div className="wizard-check-group">
        <label><input type="checkbox" checked={data.sensors.imu} onChange={e => update({ sensors: { ...data.sensors, imu: e.target.checked } })} /> 📡 IMU (加速度计 + 陀螺仪 + 磁力计)</label>
        <label><input type="checkbox" checked={data.sensors.baro} onChange={e => update({ sensors: { ...data.sensors, baro: e.target.checked } })} /> 🌡️ 气压计</label>
        <label><input type="checkbox" checked={data.sensors.gps} onChange={e => update({ sensors: { ...data.sensors, gps: e.target.checked } })} /> 🛰️ GPS</label>
      </div>
      <div className="wizard-section-title">执行机构</div>
      <div className="wizard-check-group">
        <label><input type="checkbox" checked={data.effectors} onChange={e => update({ effectors: e.target.checked })} /> ⚡ Effectors (电调/舵机映射)</label>
      </div>
    </div>
  );

  const renderOutputStep = () => (
    <div className="wizard-step">
      <h3>输出配置 Output</h3>
      <div className="wizard-grid2">
        <div className="wizard-field"><label>输出名称</label>
          <input type="text" value={data.outputName} onChange={e => update({ outputName: e.target.value })} /></div>
        <div className="wizard-field"><label>输出类型</label>
          <select value={data.outputType} onChange={e => update({ outputType: e.target.value })}>
            <option value="SOCKET">SOCKET (网络)</option>
            <option value="CSV">CSV (文件)</option>
          </select></div>
        <div className="wizard-field"><label>输出频率 (Hz)</label>
          <input type="number" value={data.outputRate} onChange={e => update({ outputRate: parseInt(e.target.value) || 0 })} /></div>
      </div>
    </div>
  );

  const renderPreviewStep = () => (
    <div className="wizard-step">
      <h3>预览与生成</h3>
      {!previewXml ? (
        <div>
          <p className="wizard-hint">点击"生成 XML"创建飞机模型文件</p>
          <div className="wizard-summary">
            <div className="wizard-summary-item"><span>类型:</span> <strong>{TYPE_INFO[data.aircraftType].icon} {TYPE_INFO[data.aircraftType].label}</strong></div>
            <div className="wizard-summary-item"><span>名称:</span> <strong>{data.name}</strong></div>
            <div className="wizard-summary-item"><span>单位制:</span> <strong>{data.unitSystem === 'IMPERIAL' ? '英制' : '公制'}</strong></div>
            <div className="wizard-summary-item"><span>发动机:</span> <strong>{data.engines.length} 台</strong></div>
            <div className="wizard-summary-item"><span>接触点:</span> <strong>{data.contacts.length} 个</strong></div>
            <div className="wizard-summary-item"><span>传感器:</span> <strong>{[data.sensors.imu && 'IMU', data.sensors.baro && '气压计', data.sensors.gps && 'GPS'].filter(Boolean).join(', ') || '无'}</strong></div>
          </div>
          <button className="wizard-generate-btn" onClick={handleGenerate} disabled={generating}>
            {generating ? '⏳ 生成中...' : '✅ 生成 XML'}
          </button>
        </div>
      ) : (
        <div>
          <div className="wizard-preview-actions">
            <button onClick={() => setPreviewXml('')}>← 返回修改</button>
            <button onClick={() => { navigator.clipboard.writeText(previewXml); }}>📋 复制</button>
            <button onClick={() => {
              const blob = new Blob([previewXml], { type: 'application/xml' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${data.name.replace(/\s+/g, '_')}.xml`;
              a.click();
              URL.revokeObjectURL(url);
            }}>💾 下载</button>
            <button className="wizard-import-btn" onClick={() => onGenerate(previewXml)}>📥 导入到编辑器</button>
          </div>
          <textarea className="wizard-xml-preview" readOnly value={previewXml} />
        </div>
      )}
    </div>
  );

  const stepRenderers = [renderTypeStep, renderBasicStep, renderMetricsStep, renderMassStep, renderGroundStep, renderPropulsionStep, renderFCSStep, renderAeroStep, renderSystemsStep, renderOutputStep, renderPreviewStep];

  return (
    <div className="wizard-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wizard-modal" onClick={e => e.stopPropagation()}>
        <div className="wizard-header">
          <h2>✈️ 飞机模型创建向导</h2>
          <button className="wizard-close" onClick={onClose}>✕</button>
        </div>
        <div className="wizard-body">
          {/* Step sidebar */}
          <div className="wizard-sidebar">
            {STEPS.map((s, i) => (
              <div key={s.key} className={`wizard-nav-item ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                onClick={() => i <= step || canNext() ? setStep(i) : null}>
                <span className="wizard-nav-icon">{i < step ? '✓' : s.icon}</span>
                <span className="wizard-nav-label">{s.label}</span>
              </div>
            ))}
          </div>
          {/* Step content */}
          <div className="wizard-content">
            {stepRenderers[step]()}
          </div>
        </div>
        {/* Footer navigation */}
        <div className="wizard-footer">
          <button disabled={step === 0} onClick={() => setStep(step - 1)}>← 上一步</button>
          <span className="wizard-step-indicator">{step + 1} / {STEPS.length}</span>
          {!isPreviewStep && (
            <button disabled={!canNext()} onClick={() => {
              if (step === STEPS.length - 2) handleGenerate();
              setStep(step + 1);
            }}>
              {step === STEPS.length - 2 ? '生成 →' : '下一步 →'}
            </button>
          )}
          {isPreviewStep && previewXml && (
            <button className="wizard-import-btn" onClick={() => onGenerate(previewXml)}>📥 导入到编辑器</button>
          )}
        </div>
      </div>
    </div>
  );
}
