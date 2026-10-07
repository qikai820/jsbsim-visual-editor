import { useState, useMemo, useEffect, useRef } from 'react';
import type { Telemetry } from '../sim/useSimSocket';
import { formatValueWithUnit, type UnitSystem } from '../utils/unitConversion';

interface PropertyTreeProps {
  telemetry: Telemetry | null;
  pinnedPaths: string[];
  onPin: (path: string) => void;
  onUnpin: (path: string) => void;
  unitSystem: UnitSystem;
}

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
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
        className={`ptree-row${changed ? ' is-changed' : ''}`}
        style={{
          paddingLeft: depth * 16 + 4,
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

        <span className="ptree-name">
          {node.name}
        </span>

        {node.isLeaf && currentValue !== undefined && (
          <>
            <span className="ptree-value">
              {formatValueWithUnit(currentValue, node.path, unitSystem).value}
            </span>
            {formatValueWithUnit(currentValue, node.path, unitSystem).unit && (
              <span className="ptree-unit">
                {formatValueWithUnit(currentValue, node.path, unitSystem).unit}
              </span>
            )}
            <button
              onClick={() => {
                if (isPinned) onUnpin(node.path);
                else {
                  onPin(node.path);
                  const saved = readStringList('jsbsim-global-variables');
                  if (!saved.includes(node.path)) localStorage.setItem('jsbsim-global-variables', JSON.stringify([...saved, node.path]));
                }
              }}
              className={`ptree-pin${isPinned ? ' is-pinned' : ''}`}
              title={isPinned ? '取消固定' : '加入全局变量浏览器'}
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

  useEffect(() => {
    const paths: string[] = [];
    const collect = (node: TreeNode) => {
      if (node.isLeaf && node.path) paths.push(node.path);
      node.children.forEach(collect);
    };
    collect(tree);
    if (paths.length) {
      localStorage.setItem('jsbsim-available-variables', JSON.stringify(paths));
      window.dispatchEvent(new CustomEvent('jsbsim-variables-updated', { detail: paths }));
    }
  }, [tree]);

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
    <div className="property-tree">
      <div className="ptree-searchbar">
        <input
          type="text"
          placeholder="🔍 搜索属性..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="ptree-search"
        />
      </div>
      <div className="ptree-body">
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
