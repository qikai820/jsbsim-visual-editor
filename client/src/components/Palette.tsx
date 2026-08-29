import { getCategories } from '../utils/componentDefs';
import type { ComponentType } from '../types';
import type { PointerEvent as ReactPointerEvent } from 'react';
import AviationIcon from './AviationIcon';

interface PaletteProps {
  onDragStart: (type: ComponentType) => void;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onResizeStart: (event: ReactPointerEvent) => void;
}

export default function Palette({ onDragStart, collapsed, onToggle, width, onResizeStart }: PaletteProps) {
  const categories = getCategories();

  return (
    <div className={`palette${collapsed ? ' palette-collapsed' : ''}`} style={{ width: collapsed ? 24 : width, minWidth: collapsed ? 24 : width }}>
      <h3><button type="button" onClick={onToggle} title={collapsed ? '展开部件库' : '折叠部件库'}>{collapsed ? '▶' : '◀'}</button>{!collapsed && ' 部件库 Components'}</h3>
      {!collapsed && <>
      {categories.map(cat => (
        <div key={cat.name} className="palette-category">
          <div className="category-title">{cat.name}</div>
          {cat.defs.map(def => (
            <div
              key={def.type}
              className="palette-item"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-jsbsim-component', def.type);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(def.type);
              }}
              style={{ borderLeftColor: def.color }}
              title={def.description}
            >
              <span className="palette-icon"><AviationIcon type={def.type} /></span>
              <span className="palette-label">{def.label}</span>
            </div>
          ))}
        </div>
      ))}</>}
      {!collapsed && <div className="palette-resizer" onPointerDown={onResizeStart} />}
    </div>
  );
}
