import { BLOCK_DEFS } from '../../utils/expressionConverter';

const CATEGORIES = [
  { key: 'input', label: '输入' },
  { key: 'table', label: '查表' },
  { key: 'math', label: '运算' },
  { key: 'func', label: '函数' },
  { key: 'logic', label: '逻辑' },
];

interface ExpressionPaletteProps {
  onAddBlock: (kind: string) => void;
}

export default function ExpressionPalette({ onAddBlock }: ExpressionPaletteProps) {
  const handleDragStart = (e: React.DragEvent, kind: string) => {
    e.dataTransfer.setData('application/expression-block', kind);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="expr-palette">
      <div className="expr-palette-title">模块 Blocks</div>
      <div style={{ padding: '2px 6px', fontSize: 9, color: 'var(--text-muted)' }}>
        点击或拖拽添加到画布
      </div>
      {CATEGORIES.map(cat => {
        const blocks = Object.values(BLOCK_DEFS).filter(b => b.category === cat.key);
        if (blocks.length === 0) return null;
        return (
          <div key={cat.key} className="expr-palette-group">
            <div className="expr-palette-group-label">{cat.label}</div>
            <div className="expr-palette-items">
              {blocks.map(b => (
                <button
                  key={b.kind}
                  className="expr-palette-item"
                  style={{ '--item-color': b.color } as React.CSSProperties}
                  onClick={() => onAddBlock(b.kind)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, b.kind)}
                  title={`${b.label} (点击或拖拽)`}
                >
                  <span className="expr-palette-icon">{b.icon}</span>
                  <span className="expr-palette-name">{b.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
