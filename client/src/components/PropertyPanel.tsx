import { useFlowStore } from '../store/flowStore';
import { getComponentDef } from '../utils/componentDefs';
import { getUnitOptions, convertUnit, formatValue } from '../utils/unitConverter';
import type { ParamDef } from '../types';
import SubFileEditor from './SubFileEditor';
import AeroEditor from './AeroEditor';

// Normalize param value: could be a plain number or { value, unit }
function getNumVal(p: any): number {
  if (typeof p === 'number') return p;
  if (p && typeof p === 'object' && 'value' in p) return Number(p.value) || 0;
  return 0;
}

function getUnitStr(p: any, fallback: string): string {
  if (p && typeof p === 'object' && 'unit' in p && p.unit) return p.unit;
  return fallback;
}

export default function PropertyPanel() {
  const { nodes, selectedNodeId, updateNodeParams, removeNode, setSelectedNode, editingSubFileId } = useFlowStore();

  if (editingSubFileId) return <SubFileEditor />;

  const node = nodes.find(n => n.id === selectedNodeId);

  if (!node) {
    return (
      <div className="property-panel">
        <h3>属性 Properties</h3>
        <p className="no-selection">选择一个节点查看属性</p>
      </div>
    );
  }

  const def = getComponentDef(node.data.componentType);
  if (!def) return null;

  if (node.data.componentType === 'aero_coefficients') {
    return (
      <div className="property-panel">
        <h3>属性 Properties</h3>
        <div className="prop-header">
          <span className="prop-type-badge" style={{ background: def.color }}>
            {def.icon} {def.label}
          </span>
          <button className="delete-btn" onClick={() => { removeNode(node.id); setSelectedNode(null); }}>
            🗑️ 删除
          </button>
        </div>
        <div className="field-row">
          <label>名称</label>
          <input
            type="text"
            value={node.data.label}
            onChange={e => {
              useFlowStore.setState({
                nodes: useFlowStore.getState().nodes.map(n =>
                  n.id === node.id ? { ...n, data: { ...n.data, label: e.target.value } } : n
                ),
              });
            }}
          />
        </div>
        <div className="prop-divider" />
        <AeroEditor />
      </div>
    );
  }

  const handleChange = (key: string, value: any) => {
    updateNodeParams(node.id, { [key]: value });
  };

  // Handle unit change for number fields: convert the value
  const handleUnitChange = (key: string, newUnit: string, oldUnit: string) => {
    const raw = node.data.params[key] ?? 0;
    const oldVal = getNumVal(raw);
    const newVal = convertUnit(oldVal, oldUnit, newUnit);
    // Store as { value, unit } format
    handleChange(key, { value: newVal, unit: newUnit });
  };

  // Handle value change for number fields
  const handleNumChange = (key: string, newVal: number, currentUnit: string) => {
    const raw = node.data.params[key];
    if (raw && typeof raw === 'object' && 'unit' in raw) {
      // Already in { value, unit } format — keep it
      handleChange(key, { value: newVal, unit: raw.unit });
    } else {
      // Plain number — just update the number
      handleChange(key, newVal);
    }
  };

  // Handle unit change for location/vector3 fields
  const handleLocUnitChange = (key: string, newUnit: string, oldUnit: string) => {
    const loc = node.data.params[key] || { x: 0, y: 0, z: 0 };
    const oldX = typeof loc.x === 'number' ? loc.x : 0;
    const oldY = typeof loc.y === 'number' ? loc.y : 0;
    const oldZ = typeof loc.z === 'number' ? loc.z : 0;
    handleChange(key, {
      x: convertUnit(oldX, oldUnit, newUnit),
      y: convertUnit(oldY, oldUnit, newUnit),
      z: convertUnit(oldZ, oldUnit, newUnit),
      unit: newUnit,
    });
  };

  const renderField = (key: string, paramDef: ParamDef) => {
    const raw = node.data.params[key] ?? paramDef.default;

    switch (paramDef.type) {
      case 'number': {
        const numVal = getNumVal(raw);
        const currentUnit = getUnitStr(raw, paramDef.unit || '');
        const unitOptions = currentUnit ? getUnitOptions(currentUnit) : [];
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <div className="field-input-row">
              <input
                type="number"
                value={formatValue(numVal)}
                step="any"
                onChange={e => handleNumChange(key, parseFloat(e.target.value) || 0, currentUnit)}
              />
              {unitOptions.length > 1 ? (
                <select
                  className="unit-select"
                  value={currentUnit}
                  onChange={e => handleUnitChange(key, e.target.value, currentUnit)}
                  title="切换单位"
                >
                  {unitOptions.map(u => (
                    <option key={u.value} value={u.value}>{u.value}</option>
                  ))}
                </select>
              ) : currentUnit ? (
                <span className="unit-label" title={unitOptions[0]?.label}>{currentUnit}</span>
              ) : null}
            </div>
          </div>
        );
      }
      case 'string':
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <input
              type="text"
              value={raw}
              onChange={e => handleChange(key, e.target.value)}
            />
          </div>
        );
      case 'select':
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <select value={raw} onChange={e => handleChange(key, e.target.value)}>
              {paramDef.options?.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        );
      case 'location':
      case 'vector3': {
        const loc = raw || { x: 0, y: 0, z: 0 };
        const labels = paramDef.type === 'location' ? ['X', 'Y', 'Z'] : ['Roll', 'Pitch', 'Yaw'];
        const currentUnit = loc.unit || paramDef.unit || '';
        const unitOptions = currentUnit ? getUnitOptions(currentUnit) : [];
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <div className="location-inputs">
              {labels.map((l, i) => {
                const axis = ['x', 'y', 'z'][i];
                const axisVal = typeof loc[axis] === 'number' ? loc[axis] : 0;
                return (
                  <div key={axis} className="axis-input">
                    <span className="axis-label">{l}</span>
                    <input
                      type="number"
                      value={formatValue(axisVal)}
                      step="any"
                      onChange={e => {
                        const newLoc = { ...loc, [axis]: parseFloat(e.target.value) || 0 };
                        handleChange(key, newLoc);
                      }}
                    />
                  </div>
                );
              })}
              {unitOptions.length > 1 ? (
                <select
                  className="unit-select unit-select-loc"
                  value={currentUnit}
                  onChange={e => handleLocUnitChange(key, e.target.value, currentUnit)}
                  title="切换单位"
                >
                  {unitOptions.map(u => (
                    <option key={u.value} value={u.value}>{u.value}</option>
                  ))}
                </select>
              ) : currentUnit ? (
                <span className="unit-label">{currentUnit}</span>
              ) : null}
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="property-panel">
      <h3>属性 Properties</h3>
      <div className="prop-header">
        <span className="prop-type-badge" style={{ background: def.color }}>
          {def.icon} {def.label}
        </span>
        <button className="delete-btn" onClick={() => { removeNode(node.id); setSelectedNode(null); }}>
          🗑️ 删除
        </button>
      </div>
      <div className="field-row">
        <label>名称</label>
        <input
          type="text"
          value={node.data.label}
          onChange={e => {
            useFlowStore.setState({
              nodes: useFlowStore.getState().nodes.map(n =>
                n.id === node.id ? { ...n, data: { ...n.data, label: e.target.value } } : n
              ),
            });
          }}
        />
      </div>
      <div className="prop-divider" />
      {Object.entries(def.params).map(([key, paramDef]) => renderField(key, paramDef))}
    </div>
  );
}
