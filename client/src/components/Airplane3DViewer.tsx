import { useRef, useMemo, useState, Component, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Text, Grid, Line, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useFlowStore } from '../store/flowStore';
import { getComponentDef } from '../utils/componentDefs';
import ParametricAircraft from './ParametricAircraft';
import type { AircraftNodeData } from '../types';

// Error boundary
class ViewerErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { hasError: false, error: '' }; }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error: error.message }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', height: '100%', background: '#1a1a2e', color: '#fff' }}>
          <div style={{ textAlign: 'center', padding: 32 }}>
            <p style={{ color: '#ef4444', fontSize: 14 }}>⚠️ 3D 渲染错误</p>
            <p style={{ color: '#888', fontSize: 12, marginTop: 8 }}>{this.state.error}</p>
            <button onClick={() => this.setState({ hasError: false })}
              style={{ marginTop: 16, padding: '8px 20px', background: '#3b82f6', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer' }}>重试</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Scale: JSBSim uses IN (inches). We convert to a reasonable 3D scale.
// 1 unit in 3D = 1 inch. We'll scale the whole scene down for better viewing.
const SCALE = 0.01; // inches → 3D units (1/100 scale)

// JSBSim coords: X=forward, Y=right, Z=up
// Three.js: X=right, Y=up, Z=toward camera
// Mapping: jsbX → -z, jsbY → x, jsbZ → y
function jsbToThree(x: number, y: number, z: number): [number, number, number] {
  return [y * SCALE, z * SCALE, -x * SCALE];
}

function getLoc(params: Record<string, any>): { x: number; y: number; z: number } {
  const loc = params.location || params.cg || { x: 0, y: 0, z: 0 };
  return {
    x: typeof loc.x === 'number' ? loc.x : 0,
    y: typeof loc.y === 'number' ? loc.y : 0,
    z: typeof loc.z === 'number' ? loc.z : 0,
  };
}

// Resolve a 3D placement for a node.
// - If the component has a real JSBSim location (x/y/z), use it (geometry-accurate).
// - Otherwise fall back to its 2D layout position so modules never pile up at the origin.
function getDisplayPos(node: { position?: { x: number; y: number }; data: AircraftNodeData }): [number, number, number] {
  const p = node.data.params || {};
  const loc = p.location || p.cg;
  if (loc && typeof loc.x === 'number') {
    return jsbToThree(loc.x, loc.y, loc.z);
  }
  const lp = node.position || { x: 0, y: 0 };
  // 2D layout x -> lateral (3D x), 2D layout y -> forward (3D -z)
  return [lp.x * SCALE, 0, -lp.y * SCALE];
}

interface Airplane3DViewerProps {
  onClose: () => void;
}

// Check WebGL support
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

export default function Airplane3DViewer({ onClose }: Airplane3DViewerProps) {
  const webglOk = useMemo(() => isWebGLAvailable(), []);
  const { nodes, selectedNodeId, setSelectedNode } = useFlowStore();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Filter nodes that have spatial positions
  const spatialNodes = useMemo(() => {
    return nodes.filter(n => {
      const type = n.data.componentType;
      return ['fuselage', 'wing', 'htail', 'vtail', 'engine', 'propeller',
        'landing_gear', 'fuel_tank', 'point_mass'].includes(type);
    });
  }, [nodes]);

  // Compute center of all nodes for camera targeting
  const center = useMemo(() => {
    if (spatialNodes.length === 0) return [0, 0, 0] as [number, number, number];
    let cx = 0, cy = 0, cz = 0;
    for (const n of spatialNodes) {
      const [tx, ty, tz] = getDisplayPos(n);
      cx += tx; cy += ty; cz += tz;
    }
    const count = spatialNodes.length || 1;
    return [cx / count, cy / count, cz / count] as [number, number, number];
  }, [spatialNodes]);

  if (!webglOk) {
    return (
      <div className="viewer3d-overlay" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#fff', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🖥️</div>
          <h2 style={{ marginBottom: 8 }}>WebGL 不可用</h2>
          <p style={{ color: '#888', marginBottom: 20 }}>您的浏览器或设备不支持 WebGL 3D 渲染</p>
          <button onClick={onClose} style={{
            padding: '10px 24px', background: '#3b82f6', color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14,
          }}>← 返回编辑器</button>
        </div>
      </div>
    );
  }

  return (
    <ViewerErrorBoundary>
    <div className="viewer3d-overlay">
      {/* Top bar */}
      <div className="viewer3d-topbar">
        <button className="viewer3d-back-btn" onClick={onClose}>← 返回编辑器</button>
        <span className="viewer3d-title">🛩️ 3D 飞机预览</span>
        <div className="viewer3d-info">
          <span>{spatialNodes.length} 个部件</span>
          <span className="viewer3d-hint">🖱️ 左键旋转 | 右键平移 | 滚轮缩放 | 点击选中</span>
        </div>
      </div>

      {/* 3D Canvas */}
      <div className="viewer3d-canvas">
        <Canvas
          camera={{ position: [0.5, 0.8, 2.5], fov: 50, near: 0.01, far: 100 }}
          style={{ background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}
        >
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 8, 5]} intensity={1} castShadow />
          <directionalLight position={[-3, 4, -2]} intensity={0.3} />
          <pointLight position={[0, 2, 0]} intensity={0.3} />

          {/* Camera controls */}
          <OrbitControls
            target={center}
            enableDamping
            dampingFactor={0.1}
            minDistance={0.3}
            maxDistance={20}
          />

          {/* Reference grid */}
          <Grid
            args={[10, 10]}
            position={[0, -0.01, 0]}
            cellSize={0.1}
            cellThickness={0.5}
            cellColor="#1e3a5f"
            sectionSize={0.5}
            sectionThickness={1}
            sectionColor="#2d5a8e"
            fadeDistance={8}
            infiniteGrid
          />

          {/* Axis helper */}
          <AxisHelper />

          {/* Fuselage reference outline */}
          <ParametricAircraft
            showMarkers
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNode}
            onHover={(h) => setHoveredId(h)}
          />
        </Canvas>
      </div>

      {/* Bottom info panel */}
      {selectedNodeId && (
        <SelectedInfo nodeId={selectedNodeId} onClose={() => setSelectedNode(null)} />
      )}
    </div>
    </ViewerErrorBoundary>
  );
}

// ── Axis Helper ─────────────────────────────────────────────────────────────

function AxisHelper() {
  const len = 0.5;
  return (
    <group>
      {/* X axis (red) - right wing */}
      <Line points={[[0, 0.001, 0], [len, 0.001, 0]]} color="#ef4444" lineWidth={2} />
      <Text position={[len + 0.05, 0.001, 0]} fontSize={0.04} color="#ef4444" anchorX="left">Y (右翼)</Text>
      {/* Y axis (green) - up */}
      <Line points={[[0, 0, 0], [0, len, 0]]} color="#22c55e" lineWidth={2} />
      <Text position={[0, len + 0.05, 0]} fontSize={0.04} color="#22c55e" anchorX="center">Z (上)</Text>
      {/* Z axis (blue) - forward (negative in three.js) */}
      <Line points={[[0, 0.001, 0], [0, 0.001, -len]]} color="#3b82f6" lineWidth={2} />
      <Text position={[0, 0.001, -len - 0.05]} fontSize={0.04} color="#3b82f6" anchorX="center">X (机头)</Text>
    </group>
  );
}

// ── Fuselage Outline (reference shape) ──────────────────────────────────────

function FuselageOutline() {
  // Simple fuselage shape: elongated ellipsoid along X axis
  const points = useMemo(() => {
    const pts: [number, number, number][] = [];
    const segments = 32;
    // Top profile
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = (t - 0.4) * 4; // from -1.6 to 2.4 (nose to tail) in inches * SCALE
      const r = Math.sin(t * Math.PI) * 0.15; // radius varies along length
      pts.push([0, r + 0.05, -x]);
    }
    return pts;
  }, []);

  return (
    <group>
      {/* Fuselage body - semi-transparent */}
      <mesh position={[0, 0.05, -0.4]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.12, 0.08, 2.5, 16, 1, false]} />
        <meshStandardMaterial color="#4A90D9" transparent opacity={0.15} wireframe />
      </mesh>
      {/* Wing planform reference */}
      <mesh position={[0, 0.04, -0.4]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.8, 0.25]} />
        <meshStandardMaterial color="#27AE60" transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ── Component 3D Shape ──────────────────────────────────────────────────────

interface ShapeProps {
  node: { id: string; position?: { x: number; y: number }; data: AircraftNodeData };
  isSelected: boolean;
  isHovered: boolean;
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
}

function ComponentShape({ node, isSelected, isHovered, onSelect, onHover }: ShapeProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const def = getComponentDef(node.data.componentType);
  const color = def?.color || '#888';
  const pos = getDisplayPos(node);

  const handleClick = (e: any) => {
    e.stopPropagation();
    onSelect();
  };

  const emissiveIntensity = isSelected ? 0.4 : isHovered ? 0.2 : 0;

  const materialProps = {
    color,
    emissive: color,
    emissiveIntensity,
    transparent: true,
    opacity: isSelected ? 1 : 0.85,
  };

  const shape = useMemo(() => {
    switch (node.data.componentType) {
      case 'fuselage': {
        // Main fuselage body
        const wt = node.data.params.emptywt;
        const weight = typeof wt === 'number' ? wt : wt?.value || 3000;
        const fuselageLen = Math.max(0.8, Math.min(3, weight / 1500));
        return (
          <mesh ref={meshRef} position={pos} rotation={[0, 0, Math.PI / 2]}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <cylinderGeometry args={[0.12, 0.08, fuselageLen, 16]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'wing': {
        // Wing: flat box spanning wingspan
        const span = node.data.params.wingspan;
        const s = typeof span === 'number' ? span : span?.value || 36;
        const wingSpan3D = s * SCALE;
        const chord = node.data.params.chord;
        const c = typeof chord === 'number' ? chord : chord?.value || 5;
        const chord3D = c * SCALE;
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <boxGeometry args={[wingSpan3D, 0.01, chord3D]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'htail': {
        // Horizontal tail: smaller flat box
        const area = node.data.params.htailarea;
        const a = typeof area === 'number' ? area : area?.value || 22;
        const tailSpan = Math.sqrt(a) * SCALE * 2;
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <boxGeometry args={[tailSpan, 0.008, tailSpan * 0.4]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'vtail': {
        // Vertical tail: vertical flat box
        const area = node.data.params.vtailarea;
        const a = typeof area === 'number' ? area : area?.value || 17;
        const tailH = Math.sqrt(a) * SCALE * 2;
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <boxGeometry args={[0.008, tailH, tailH * 0.5]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'engine': {
        // Engine: cylinder
        return (
          <mesh ref={meshRef} position={pos} rotation={[0, 0, Math.PI / 2]}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <cylinderGeometry args={[0.06, 0.08, 0.15, 12]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'propeller': {
        // Propeller: flat disc
        return (
          <mesh ref={meshRef} position={pos} rotation={[0, 0, Math.PI / 2]}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <cylinderGeometry args={[0.1, 0.1, 0.01, 3]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'landing_gear': {
        // Landing gear: small cylinder + wheel
        return (
          <group position={pos}>
            <mesh onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
              <cylinderGeometry args={[0.008, 0.008, 0.12, 8]} />
              <meshStandardMaterial {...materialProps} />
            </mesh>
            <mesh position={[0, -0.06, 0]}
              onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
              <sphereGeometry args={[0.025, 12, 12]} />
              <meshStandardMaterial color="#333" emissive="#333" emissiveIntensity={emissiveIntensity} />
            </mesh>
          </group>
        );
      }

      case 'fuel_tank': {
        // Fuel tank: small box
        const cap = node.data.params.capacity;
        const c = typeof cap === 'number' ? cap : cap?.value || 168;
        const tankSize = Math.max(0.03, Math.min(0.12, c * SCALE * 0.3));
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <boxGeometry args={[tankSize * 0.6, tankSize * 0.4, tankSize]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      case 'point_mass': {
        // Point mass: sphere
        const wt = node.data.params.weight;
        const w = typeof wt === 'number' ? wt : wt?.value || 180;
        const radius = Math.max(0.015, Math.min(0.05, w * SCALE * 0.1));
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <sphereGeometry args={[radius, 16, 16]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
      }

      default:
        return (
          <mesh ref={meshRef} position={pos}
            onClick={handleClick} onPointerOver={() => onHover(true)} onPointerOut={() => onHover(false)}>
            <boxGeometry args={[0.05, 0.05, 0.05]} />
            <meshStandardMaterial {...materialProps} />
          </mesh>
        );
    }
  }, [node.data.componentType, node.data.params, pos, isSelected, isHovered]);

  // Selection ring
  if (isSelected) {
    return (
      <group>
        {shape}
        <mesh position={pos}>
          <ringGeometry args={[0.08, 0.09, 32]} />
          <meshBasicMaterial color="#fbbf24" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }

  return shape;
}

// ── Component Label ─────────────────────────────────────────────────────────

function ComponentLabel({ node, isSelected }: { node: { id: string; position?: { x: number; y: number }; data: AircraftNodeData }; isSelected: boolean }) {
  const pos = getDisplayPos(node);
  const def = getComponentDef(node.data.componentType);
  const label = def?.icon || '';

  return (
    <Html
      position={[pos[0], pos[1] + 0.12, pos[2]]}
      center
      style={{
        pointerEvents: 'none',
        userSelect: 'none',
        opacity: isSelected ? 1 : 0.7,
        transition: 'opacity 0.2s',
      }}
    >
      <div style={{
        background: isSelected ? 'rgba(251,191,36,0.9)' : 'rgba(0,0,0,0.6)',
        color: isSelected ? '#000' : '#fff',
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: isSelected ? 700 : 500,
        whiteSpace: 'nowrap',
        fontFamily: 'sans-serif',
        border: isSelected ? '1px solid #fbbf24' : '1px solid rgba(255,255,255,0.2)',
      }}>
        {label} {node.data.label?.split(' ')[0]}
      </div>
    </Html>
  );
}

// ── Selected Info Panel ─────────────────────────────────────────────────────

function SelectedInfo({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore(s => s.nodes.find(n => n.id === nodeId));
  if (!node) return null;
  const def = getComponentDef(node.data.componentType);
  const loc = getLoc(node.data.params);

  return (
    <div className="viewer3d-info-panel">
      <div className="viewer3d-info-header">
        <span style={{ fontSize: 18 }}>{def?.icon}</span>
        <span className="viewer3d-info-name">{node.data.label}</span>
        <button className="viewer3d-info-close" onClick={onClose}>✕</button>
      </div>
      <div className="viewer3d-info-body">
        <div className="viewer3d-info-row">
          <span>类型</span>
          <span>{def?.category} · {node.data.componentType}</span>
        </div>
        <div className="viewer3d-info-row">
          <span>位置 (IN)</span>
          <span>X: {loc.x.toFixed(1)}, Y: {loc.y.toFixed(1)}, Z: {loc.z.toFixed(1)}</span>
        </div>
        {Object.entries(def?.params || {}).slice(0, 4).map(([key, pDef]) => {
          const val = node.data.params[key];
          if (val === undefined || typeof val === 'object' && !('value' in val)) return null;
          const displayVal = typeof val === 'number' ? val : (val as any).value;
          const unit = typeof val === 'object' && val.unit ? val.unit : (pDef as any).unit || '';
          return (
            <div key={key} className="viewer3d-info-row">
              <span>{pDef.label}</span>
              <span>{typeof displayVal === 'number' ? displayVal.toFixed(2) : String(val)} {unit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
