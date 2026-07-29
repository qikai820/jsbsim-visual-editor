import { useFlowStore } from '../store/flowStore';
import type { EngineDef, ThrusterDef, SystemDef } from '../types';

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
            <input type="number" value={d.maxHP || 0} onChange={e => updateData({ maxHP: parseFloat(e.target.value) || 0 })} />
          </div>
        )}
        {(d.engineType === 'turbine' || d.engineType === 'rocket') && (
          <div className="sfe-field">
            <label>最大推力 (lbs)</label>
            <input type="number" value={d.maxThrust || 0} onChange={e => updateData({ maxThrust: parseFloat(e.target.value) || 0 })} />
          </div>
        )}
        {d.engineType === 'piston' && (
          <>
            <div className="sfe-field">
              <label>排量 (CID)</label>
              <input type="number" value={d.displacement || 0} onChange={e => updateData({ displacement: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>冲程数</label>
              <input type="number" value={d.cycles || 4} onChange={e => updateData({ cycles: parseInt(e.target.value) || 4 })} />
            </div>
            <div className="sfe-field">
              <label>BSFC (lbs/hp*hr)</label>
              <input type="number" step="0.01" value={d.bsfc || 0.45} onChange={e => updateData({ bsfc: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>启动扭矩 (lb*ft)</label>
              <input type="number" value={d.starterTorque || 0} onChange={e => updateData({ starterTorque: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>怠速 RPM</label>
              <input type="number" value={d.idleRPM || 600} onChange={e => updateData({ idleRPM: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>最大 RPM</label>
              <input type="number" value={d.maxRPM || 2700} onChange={e => updateData({ maxRPM: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>最小进气压力 (inHg)</label>
              <input type="number" step="0.1" value={d.minMP || 14.7} onChange={e => updateData({ minMP: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>最大进气压力 (inHg)</label>
              <input type="number" step="0.1" value={d.maxMP || 29.92} onChange={e => updateData({ maxMP: parseFloat(e.target.value) || 0 })} />
            </div>
          </>
        )}
        {(d.engineType === 'turbine') && (
          <>
            <div className="sfe-field">
              <label>怠速 RPM</label>
              <input type="number" value={d.idleRPM || 0} onChange={e => updateData({ idleRPM: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>最大 RPM</label>
              <input type="number" value={d.maxRPM || 0} onChange={e => updateData({ maxRPM: parseFloat(e.target.value) || 0 })} />
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
              <input type="number" step="0.01" value={d.diameter || 0} onChange={e => updateData({ diameter: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="sfe-field">
              <label>叶片数</label>
              <input type="number" value={d.numBlades || 2} onChange={e => updateData({ numBlades: parseInt(e.target.value) || 2 })} />
            </div>
            <div className="sfe-field">
              <label>齿轮比</label>
              <input type="number" step="0.01" value={d.gearRatio || 1} onChange={e => updateData({ gearRatio: parseFloat(e.target.value) || 1 })} />
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
                <input
                  type="text"
                  placeholder="属性名 (如 /sim/model/pushback/kp)"
                  value={prop.name}
                  onChange={e => updateProp(idx, 'name', e.target.value)}
                />
                <input
                  type="number"
                  placeholder="默认值"
                  value={prop.value ?? ''}
                  onChange={e => updateProp(idx, 'value', e.target.value ? parseFloat(e.target.value) : undefined)}
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
