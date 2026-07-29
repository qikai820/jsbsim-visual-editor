import { getCategories } from '../utils/componentDefs';
import type { ComponentType } from '../types';

interface PaletteProps {
  onDragStart: (type: ComponentType) => void;
}

export default function Palette({ onDragStart }: PaletteProps) {
  const categories = getCategories();

  return (
    <div className="palette">
      <h3>部件库 Components</h3>
      {categories.map(cat => (
        <div key={cat.name} className="palette-category">
          <div className="category-title">{cat.name}</div>
          {cat.defs.map(def => (
            <div
              key={def.type}
              className="palette-item"
              draggable
              onDragStart={() => onDragStart(def.type)}
              style={{ borderLeftColor: def.color }}
              title={def.description}
            >
              <span className="palette-icon">{def.icon}</span>
              <span className="palette-label">{def.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
