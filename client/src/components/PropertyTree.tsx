import { useState, useMemo, useEffect, useRef } from 'react';
import type { Telemetry } from '../sim/useSimSocket';
import type { UnitSystem } from './LiveView';
import { formatValueWithUnit } from '../utils/unitConversion';

interface PropertyTreeProps {
  telemetry: Telemetry | null;
  pinnedPaths: string[];
  onPin: (path: string) => void;
  onUnpin: (path: string) => void;
  unitSystem: UnitSystem;
}

// Build a tree structure from flat property paths
interface TreeNode {
  name: string;
  path: string;
  value?: number;
  children: Map<string, TreeNode>;
  isLeaf: boolean;
}

function buildTree(telemetry: Telemetry | null): TreeNode {
  const root: TreeNode = { name: 'root', path: '', children: new Map(), isLeaf: false };

  if (!telemetry) return root;

  for (const [key, value] of Object.entries(telemetry)) {
    if (key === 't' || key === 'frame') continue;
    if (typeof value !== 'number') continue;

    const parts = key.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const path = '/' + parts.slice(0, i + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path,
          children: new Map(),
          isLeaf: i === parts.length - 1,
        });
      }

      current = current.children.get(part)!;
    }

    current.value = value;
    current.isLeaf = true;
  }

  return root;
}

// Tree node component
function TreeNodeView({
  node,
  depth,
  telemetry,
  pinnedPaths,
  onPin,
  onUnpin,
  prevValues,
  unitSystem,
}: {
  node: TreeNode;
  depth: number;
  telemetry: Telemetry | null;
  pinnedPaths: string[];
  onPin: (path: string) => void;
  onUnpin: (path: string) => void;
  prevValues: React.MutableRefObject<Map<string, number>>;
  unitSystem: UnitSystem;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isPinned = pinnedPaths.includes(node.path);
  const currentValue = node.value;
  const prevValue = prevValues.current.get(node.path);
  const changed = prevValue !== undefined && currentValue !== undefined && Math.abs(prevValue - currentValue) > 0.0001;

  useEffect(() => {
    if (currentValue !== undefined) {
      prevValues.current.set(node.path, currentValue);
    }
  }, [currentValue, node.path, prevValues]);

  const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div
        className="ptree-row"
        style={{
          paddingLeft: depth * 16 + 4,
          background: changed ? 'var(--accent-light)' : 'transparent',
          transition: 'background 0.3s',
        }}
      >
        {children.length > 0 && (
          <span
            className="ptree-toggle"
            onClick={() => setExpanded(!expanded)}
            style={{ cursor: 'pointer', userSelect: 'none', width: 16, display: 'inline-block' }}
          >
            {expanded ? '▼' : '▶'}
          </span>
        )}
        {children.length === 0 && <span style={{ width: 16, display: 'inline-block' }} />}

        <span className="ptree-name" style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>
          {node.name}
        </span>

        {node.isLeaf && currentValue !== undefined && (
          <>
            <span className="ptree-value" style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--success)', minWidth: 80, textAlign: 'right' }}>
              {formatValueWithUnit(currentValue, node.path, unitSystem).value}
            </span>
            {formatValueWithUnit(currentValue, node.path, unitSystem).unit && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 2 }}>
                {formatValueWithUnit(currentValue, node.path, unitSystem).unit}
              </span>
            )}
            <button
              className="ptree-pin"
              onClick={() => isPinned ? onUnpin(node.path) : onPin(node.path)}
              style={{
                marginLeft: 8,
                padding: '0 6px',
                fontSize: 10,
                background: isPinned ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: isPinned ? '#fff' : 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
              title={isPinned ? '取消固定' : '固定到仪表盘'}
            >
              {isPinned ? '★' : '☆'}
            </button>
          </>
        )}
      </div>

      {expanded && children.map(child => (
        <TreeNodeView
          key={child.path}
          node={child}
          depth={depth + 1}
          telemetry={telemetry}
          pinnedPaths={pinnedPaths}
          onPin={onPin}
          onUnpin={onUnpin}
          prevValues={prevValues}
          unitSystem={unitSystem}
        />
      ))}
    </div>
  );
}

export default function PropertyTree({ telemetry, pinnedPaths, onPin, onUnpin, unitSystem }: PropertyTreeProps) {
  const [filter, setFilter] = useState('');
  const prevValues = useRef<Map<string, number>>(new Map());

  const tree = useMemo(() => buildTree(telemetry), [telemetry]);

  const filteredTree = useMemo(() => {
    if (!filter) return tree;
    const lower = filter.toLowerCase();
    const filterNode = (node: TreeNode): TreeNode | null => {
      const matches = node.path.toLowerCase().includes(lower);
      const filteredChildren = new Map<string, TreeNode>();
      for (const [key, child] of node.children) {
        const filtered = filterNode(child);
        if (filtered) filteredChildren.set(key, filtered);
      }
      if (matches || filteredChildren.size > 0) {
        return { ...node, children: filteredChildren };
      }
      return null;
    };
    return filterNode(tree) || tree;
  }, [tree, filter]);

  return (
    <div className="property-tree" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-secondary)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <input
          type="text"
          placeholder="🔍 搜索属性..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontFamily: 'monospace',
          }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {Array.from(filteredTree.children.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(child => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={0}
              telemetry={telemetry}
              pinnedPaths={pinnedPaths}
              onPin={onPin}
              onUnpin={onUnpin}
              prevValues={prevValues}
              unitSystem={unitSystem}
            />
          ))}
      </div>
    </div>
  );
}
