import FloatInput from './FloatInput';
import { useFlowStore } from '../store/flowStore';
import type { EngineDef, ThrusterDef, SystemDef } from '../types';
import SignalPathInput from './SignalPathInput';

export default function SubFileEditor() {
  const { subFiles, editingSubFileId, updateSubFile, setEditingSubFile } = useFlowStore();
  const subFile = subFiles.find(f => f.id === editingSubFileId);

  if (!subFile) return null;

  const updateData = (data: Record<string, any>) => {
    updateSubFile(subFile.id, { data: { ...subFile.data, ...data } });
  };

  const renderEngineEditor = () => {
    const d = subFile.data as EngineDef;
    return (
      <>
        <div className="sfe-field">
          <label>发动机类型</label>
          <select value={d.engineType} onChange={e => updateData({ engineType: e.target.value })}>
            <option value="piston">活塞 Piston</option>
            <option value="turbine">涡轮 Turbine</option>
            <option value="rocket">火箭 Rocket</option>
            <option value="electric">电动 Electric</option>
          </select>
        </div>
        {(d.engineType === 'piston' || d.engineType === 'electric') && (
          <div className="sfe-field">
            <label>最大功率 (HP)</label>
            <FloatInput value={d.maxHP ?? 0} onValueChange={value => updateData({ maxHP: value })} />
          </div>
        )}
        {(d.engineType === 'turbine' || d.engineType === 'rocket') && (
          <div className="sfe-field">
            <label>最大推力 (lbs)</label>
            <FloatInput value={d.maxThrust ?? 0} onValueChange={value => updateData({ maxThrust: value })} />
          </div>
        )}
        {d.engineType === 'piston' && (
          <>
            <div className="sfe-field">
              <label>排量 (CID)</label>
              <FloatInput value={d.displacement ?? 0} onValueChange={value => updateData({ displacement: value })} />
            </div>
            <div className="sfe-field">
              <label>冲程数</label>
              <input type="number" value={d.cycles || 4} onChange={e => updateData({ cycles: parseInt(e.target.value) || 4 })} />
            </div>
            <div className="sfe-field">
              <label>BSFC (lbs/hp*hr)</label>
              <FloatInput value={d.bsfc ?? 0.45} onValueChange={value => updateData({ bsfc: value })} />
            </div>
            <div className="sfe-field">
              <label>启动扭矩 (lb*ft)</label>
              <FloatInput value={d.starterTorque ?? 0} onValueChange={value => updateData({ starterTorque: value })} />
            </div>
            <div className="sfe-field">
              <label>怠速 RPM</label>
              <FloatInput value={d.idleRPM ?? 600} onValueChange={value => updateData({ idleRPM: value })} />
            </div>
            <div className="sfe-field">
              <label>最大 RPM</label>
              <FloatInput value={d.maxRPM ?? 2700} onValueChange={value => updateData({ maxRPM: value })} />
            </div>
            <div className="sfe-field">
              <label>最小进气压力 (inHg)</label>
              <FloatInput value={d.minMP ?? 14.7} onValueChange={value => updateData({ minMP: value })} />
            </div>
            <div className="sfe-field">
              <label>最大进气压力 (inHg)</label>
              <FloatInput value={d.maxMP ?? 29.92} onValueChange={value => updateData({ maxMP: value })} />
            </div>
          </>
        )}
        {(d.engineType === 'turbine') && (
          <>
            <div className="sfe-field">
              <label>怠速 RPM</label>
              <FloatInput value={d.idleRPM ?? 0} onValueChange={value => updateData({ idleRPM: value })} />
            </div>
            <div className="sfe-field">
              <label>最大 RPM</label>
              <FloatInput value={d.maxRPM ?? 0} onValueChange={value => updateData({ maxRPM: value })} />
            </div>
          </>
        )}
      </>
    );
  };

  const renderThrusterEditor = () => {
    const d = subFile.data as ThrusterDef;
    return (
      <>
        <div className="sfe-field">
          <label>推力器类型</label>
          <select value={d.thrusterType} onChange={e => updateData({ thrusterType: e.target.value })}>
            <option value="propeller">螺旋桨 Propeller</option>
            <option value="direct">直接 Direct</option>
            <option value="nozzle">喷管 Nozzle</option>
          </select>
        </div>
        {d.thrusterType === 'propeller' && (
          <>
            <div className="sfe-field">
              <label>直径 (ft)</label>
              <FloatInput value={d.diameter ?? 0} onValueChange={value => updateData({ diameter: value })} />
            </div>
            <div className="sfe-field">
              <label>叶片数</label>
              <input type="number" value={d.numBlades || 2} onChange={e => updateData({ numBlades: parseInt(e.target.value) || 2 })} />
            </div>
            <div className="sfe-field">
              <label>齿轮比</label>
              <FloatInput value={d.gearRatio ?? 1} onValueChange={value => updateData({ gearRatio: value })} />
            </div>
          </>
        )}
      </>
    );
  };

  const renderSystemEditor = () => {
    const d = subFile.data as SystemDef;
    const props = d.properties || [];

    const addProp = () => {
      updateData({ properties: [...props, { name: '', value: undefined }] });
    };
    const removeProp = (idx: number) => {
      updateData({ properties: props.filter((_, i) => i !== idx) });
    };
    const updateProp = (idx: number, field: string, val: any) => {
      const newProps = [...props];
      newProps[idx] = { ...newProps[idx], [field]: val };
      updateData({ properties: newProps });
    };

    return (
      <>
        <div className="sfe-field">
          <label>属性列表 Properties</label>
          <div className="sfe-props-list">
            {props.map((prop, idx) => (
              <div key={idx} className="sfe-prop-row">
                <SignalPathInput
                  placeholder="属性名 (如 /sim/model/pushback/kp)"
                  value={prop.name}
                  onChange={name => updateProp(idx, 'name', name)}
                />
                <FloatInput
                  placeholder="默认值"
                  value={prop.value}
                  onValueChange={value => updateProp(idx, 'value', value)}
                  onClear={() => updateProp(idx, 'value', undefined)}
                />
                <button className="sfe-prop-remove" onClick={() => removeProp(idx)}>✗</button>
              </div>
            ))}
            <button className="sfe-prop-add" onClick={addProp}>+ 添加属性</button>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="subfile-editor">
      <div className="sfe-header">
        <button className="sfe-back-btn" onClick={() => setEditingSubFile(null)}>← 返回</button>
        <span className="sfe-title">
          {subFile.fileType === 'engine' ? '⚙️' : subFile.fileType === 'thruster' ? '🔄' : '🔗'}
          {' '}{subFile.fileName}
        </span>
      </div>
      <div className="sfe-field">
        <label>文件名</label>
        <input type="text" value={subFile.fileName} onChange={e => updateSubFile(subFile.id, { fileName: e.target.value })} />
      </div>
      {subFile.fileType === 'engine' && renderEngineEditor()}
      {subFile.fileType === 'thruster' && renderThrusterEditor()}
      {subFile.fileType === 'system' && renderSystemEditor()}
    </div>
  );
}
